'use client';

/**
 * The answer a Clerk task produced, and how it produced it.
 *
 * Rendered only for `case_type === 'assistant_task'` (the page keys on it) and
 * placed directly under the request text, above the tabs: the answer is the
 * deliverable of an assistant case. Evidence is the proof that a deliverable
 * exists and satisfies the policy — which is why the Proof tab's one-line
 * `task_result` summary is not, and cannot be, where the answer is read.
 *
 * Everything shown here comes from the `arbitra.assistant_task_result/v1`
 * artifact written by `AssistantTaskExecutor`, fetched through the existing
 * `GET /api/artifacts/:id/content` route via the case's `task_result` evidence
 * row. Nothing is recomputed and nothing is inferred: see
 * `lib/assistant-task-result.ts` for the field-by-field mapping.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import useSWR, { useSWRConfig } from 'swr';
import type { Components } from 'react-markdown';
import type {
  AssistantFeedbackRating,
  Case,
  CaseEvent,
  Run,
} from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useAuth } from '../../providers/auth-provider';
import { getCasePollingInterval } from '../../lib/case-polling';
import { isTerminalCaseStatus } from '../../lib/lifecycle-stages';
import {
  assistantFailureFromEvents,
  describeToolParams,
  formatBytes,
  formatDurationMs,
  parseAssistantTaskResult,
  readsWithheldFact,
  taskResultArtifactRef,
  toolLabel,
  type AssistantTaskResult,
  type AssistantToolCall,
} from '../../lib/assistant-task-result';
import { MarkdownContent } from '../shared/markdown-content';
import LoadingSpinner from '../shared/loading-spinner';
import { RelativeTime } from '../shared/relative-time';
import { ConfirmDialog } from '../shared/confirm-dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useIsAdmin } from '../../hooks/use-is-admin';
import { useToast } from '../../providers/toast-provider';

interface AssistantAnswerPanelProps {
  caseData: Case;
  events?: CaseEvent[];
  runs?: Run[];
}

/**
 * SWR key for the stored result. Scoped by the signed-in uid for the same
 * reason `artifactContentSwrKey` in `comments-thread.tsx` is: sign-out neither
 * reloads the app nor clears SWR's cache, so an unscoped key could serve one
 * account's answer to the next account in the same tab. `null` until both the
 * artifact and the uid are known, so nothing is fetched speculatively.
 */
export function assistantResultSwrKey(
  artifactRef: string | null,
  uid: string | undefined,
): [string, string, string] | null {
  return artifactRef && uid ? ['assistant-task-result', artifactRef, uid] : null;
}

/** Feedback is private account state, so its cache key must include the uid. */
export function assistantFeedbackSwrKey(
  caseId: string,
  uid: string | undefined,
): [string, string, string] | null {
  return uid ? ['assistant-feedback', caseId, uid] : null;
}

/**
 * Element renderers this surface needs on top of the shared markdown defaults.
 *
 * An answer is the one markdown in the product that a model composed over text
 * other people wrote: a case title, a description or a knowledge asset reaches
 * the model through a read tool and can be echoed into the answer verbatim,
 * then stored verbatim. So a URL here may have been chosen by whoever wrote
 * that text, and rendering it as an image fires an outbound GET the moment the
 * panel is opened — which tells that host the answer was read, and carries the
 * reader's IP, user-agent and referrer along. The alt text is kept because it
 * is what the sentence meant to say and costs no request; the `src` is dropped,
 * because fetching it is the whole harm. Showing the URL as text instead was
 * the alternative and was rejected: it puts an attacker-chosen string in the
 * reader's way without telling them anything they can act on.
 *
 * Links stay clickable — an answer citing a case or a doc is useful — but they
 * leave this tab intact and hand the target no `window.opener` and no referrer.
 *
 * Kept here rather than in `MarkdownContent` on purpose: the shared component
 * has other callers whose rendering must not change, and this is the only
 * surface where the author of the text and the author of the markdown differ.
 */
const ANSWER_MARKDOWN_COMPONENTS: Components = {
  img: ({ alt }) =>
    alt ? <span className="italic text-gray-500 dark:text-gray-400">{alt}</span> : null,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-label="Assistant answer"
      className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg"
    >
      {children}
    </section>
  );
}

function Header({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-gray-200 dark:border-border-subtle px-4 py-2.5">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Answer</h2>
      {children}
    </div>
  );
}

function StopTaskControl({ caseId, runId }: { caseId: string; runId: string }) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const { mutate: mutateCache } = useSWRConfig();
  const { addToast } = useToast();

  const stop = async (): Promise<void> => {
    setStopping(true);
    try {
      await api.assistant.cancelTask(caseId, runId);
      setOpen(false);
      await Promise.all([
        mutateCache(['case', caseId]),
        mutateCache(['runs', caseId]),
        mutateCache(['events', caseId]),
        mutateCache(['evidence', caseId]),
      ]);
      addToast('success', 'Task stopped');
    } catch (error) {
      addToast(
        'error',
        'Task could not be stopped',
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setStopping(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        disabled={stopping}
        onClick={() => setOpen(true)}
        className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
      >
        Stop task
      </Button>
      <ConfirmDialog
        open={open}
        title="Stop Clerk task?"
        message="Clerk will stop this attempt. Reads already completed remain in the audit trace, but no answer will be produced."
        confirmLabel="Stop task"
        variant="danger"
        loading={stopping}
        onConfirm={() => void stop()}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

/**
 * The primary continuation affordance for a completed answer.
 *
 * Rendered as an always-visible composer rather than a button that reveals
 * one: every Clerk thread typically continues via a follow-up while
 * feedback is the rarer action, so this is what a requester should see and act on first —
 * one click less than the previous reveal-then-type flow, matching the
 * always-open composer `comments-thread.tsx` already uses for the same kind
 * of "continue the conversation" action. `FeedbackControl` stays secondary,
 * below this, in `AssistantAnswerPanel`'s render order.
 */
function FollowUpComposer({ caseId }: { caseId: string }) {
  const router = useRouter();
  const { addToast } = useToast();
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  // Kept across a failed submit so retrying the same turn cannot append twice.
  const idempotencyKey = useRef<string>(undefined);

  const submit = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) {
      setError('Write a follow-up question.');
      return;
    }
    idempotencyKey.current ??= crypto.randomUUID();
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await api.assistant.createFollowUp(caseId, {
        text: trimmed,
        idempotency_key: idempotencyKey.current,
      });
      addToast('success', result.replayed ? 'Follow-up reopened' : 'Follow-up started');
      router.push(`/cases/${result.case_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The follow-up could not be started.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-2">
      <Input
        as="textarea"
        label="Ask a follow-up"
        placeholder="Continue this conversation…"
        value={text}
        disabled={submitting}
        error={error}
        onChange={(event) => {
          setText(event.target.value);
          setError(undefined);
        }}
      />
      <div className="flex justify-end">
        <Button variant="primary" size="sm" loading={submitting} onClick={() => void submit()}>
          Start follow-up
        </Button>
      </div>
    </div>
  );
}

function FeedbackControl({
  caseId,
  uid,
  canEdit,
}: {
  caseId: string;
  uid: string;
  canEdit: boolean;
}) {
  const { addToast } = useToast();
  const { data, error, isLoading, mutate } = useSWR(
    assistantFeedbackSwrKey(caseId, uid),
    () => api.assistant.getFeedback(caseId),
    { revalidateOnFocus: false },
  );
  const feedback = data?.feedback ?? null;
  const [rating, setRating] = useState<AssistantFeedbackRating | null>(
    feedback?.rating ?? null,
  );
  const [reason, setReason] = useState(feedback?.reason ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!feedback) return;
    setRating(feedback.rating);
    setReason(feedback.reason);
  }, [feedback?.updated_at]);

  if (isLoading) {
    return <p className="text-xs text-gray-500 dark:text-gray-400">Loading feedback…</p>;
  }
  if (error) {
    return <p className="text-xs text-red-600 dark:text-red-400">Feedback could not be loaded.</p>;
  }
  if (!canEdit) {
    return (
      <div aria-label="Answer feedback" className="space-y-1 text-xs text-gray-600 dark:text-gray-400">
        <p className="font-medium text-gray-700 dark:text-gray-300">Requester feedback</p>
        {feedback ? (
          <>
            <p>{feedback.rating === 'useful' ? 'Useful' : 'Not useful'}</p>
            <p>{feedback.reason}</p>
          </>
        ) : <p>No feedback recorded.</p>}
      </div>
    );
  }

  const save = async (): Promise<void> => {
    if (!rating || !reason.trim()) return;
    setSaving(true);
    try {
      const result = await api.assistant.saveFeedback(caseId, {
        rating,
        reason: reason.trim(),
      });
      await mutate({ feedback: result.feedback }, { revalidate: false });
      setReason(result.feedback.reason);
      addToast('success', result.replayed ? 'Feedback already saved' : 'Feedback saved');
    } catch (saveError) {
      addToast('error', saveError instanceof Error ? saveError.message : 'Feedback could not be saved');
    } finally {
      setSaving(false);
    }
  };

  // Secondary to the follow-up composer: a compact inline row, never the
  // brand-accent button, and the Save action only appears once a rating is
  // picked — there is nothing to save before that, so showing it earlier
  // was the visual weight the feedback block did not need. The mandatory-reason rule is unchanged: Save stays
  // disabled until `reason` is non-empty.
  return (
    <div aria-label="Answer feedback" className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-medium text-gray-500 dark:text-gray-400">Was this answer useful?</span>
      <Button
        type="button"
        size="xs"
        variant={rating === 'useful' ? 'secondary' : 'ghost'}
        onClick={() => setRating('useful')}
      >
        Useful
      </Button>
      <Button
        type="button"
        size="xs"
        variant={rating === 'not_useful' ? 'secondary' : 'ghost'}
        onClick={() => setRating('not_useful')}
      >
        Not useful
      </Button>
      {rating && (
        <>
          <Input
            size="sm"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={2000}
            placeholder="Why?"
            aria-label="Why was this answer useful or not useful?"
            wrapperClassName="w-36 sm:w-56"
          />
          <Button
            type="button"
            size="xs"
            variant="secondary"
            disabled={!reason.trim() || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : feedback ? 'Update feedback' : 'Save feedback'}
          </Button>
        </>
      )}
    </div>
  );
}

/** Nothing is claimed while a request is in flight. */
function LoadingShell() {
  return (
    <Shell>
      <Header>
        <span className="text-xs text-gray-500 dark:text-gray-400">Loading</span>
      </Header>
      <div className="px-4 py-4 space-y-2" aria-hidden="true">
        <div className="h-3 w-2/3 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
        <div className="h-3 w-full bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
        <div className="h-3 w-5/6 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
      </div>
    </Shell>
  );
}

/** A read of ours failed, which is neither "no answer" nor "still working". */
function UnavailableShell({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Shell>
      <Header>
        <span className="text-xs font-medium text-red-600 dark:text-red-400">
          Answer unavailable
        </span>
      </Header>
      <div className="px-4 py-3 space-y-2">
        <p className="text-sm text-gray-700 dark:text-gray-300">{message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="text-xs font-medium text-accent-700 dark:text-accent-300 hover:underline"
        >
          Try again
        </button>
      </div>
    </Shell>
  );
}

function ToolCallRow({ call }: { call: AssistantToolCall }) {
  const params = describeToolParams(call.params);
  const outcomeStyles: Record<AssistantToolCall['outcome'], string> = {
    ok: 'text-green-700 dark:text-green-400',
    error: 'text-red-600 dark:text-red-400',
    bound_exceeded: 'text-amber-700 dark:text-amber-400',
  };
  return (
    <li className="px-4 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
          {toolLabel(call.name)}
        </span>
        <span className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
          <span>{formatDurationMs(call.duration_ms)}</span>
          <span>{formatBytes(call.result_bytes)}</span>
          <span className={outcomeStyles[call.outcome] ?? 'text-gray-500 dark:text-gray-400'}>
            {call.outcome === 'ok'
              ? 'ok'
              : call.outcome === 'bound_exceeded'
                ? 'stopped by a bound'
                : 'failed'}
          </span>
        </span>
      </div>
      {params && (
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Asked for {params}</p>
      )}
      {call.detail && (
        <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{call.detail}</p>
      )}
    </li>
  );
}

/**
 * The run facts and the reads behind one answer.
 *
 * Exported so the expanded section can be asserted directly: it opens only on a
 * click, and the wording in here is the part that has to stay honest.
 */
export function AssistantMethodDetails({ result }: { result: AssistantTaskResult }) {
  return (
    <div id="assistant-method" className="border-t border-gray-200 dark:border-border-subtle">
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 px-4 pt-3 pb-2 text-xs">
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Steps</dt>
          <dd className="font-medium text-gray-900 dark:text-gray-100">{result.steps}</dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Finish reason</dt>
          <dd className="font-medium text-gray-900 dark:text-gray-100">
            {result.finish_reason || '—'}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Duration</dt>
          <dd className="font-medium text-gray-900 dark:text-gray-100">
            {formatDurationMs(result.duration_ms)}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Tokens</dt>
          <dd className="font-medium text-gray-900 dark:text-gray-100">
            {result.usage.total_tokens} ({result.usage.input_tokens} in /{' '}
            {result.usage.output_tokens} out)
          </dd>
        </div>
      </dl>
      {/* The requester's always-inject Clerk context that shaped this answer
          (#832 slice A) — its own labeled block between the run facts above
          and the tool calls below, names and ids only, no bodies, matching
          ToolCallRow's minimal-disclosure look. Absent entirely on a legacy
          artifact with no `injected_context` field — `parseAssistantTaskResult`
          defaults that to `[]`, so this renders nothing rather than an empty
          "no context" claim about a result that never recorded the concept. */}
      {result.injected_context.length > 0 && (
        <div className="px-4 py-2 border-t border-gray-200 dark:border-border-subtle">
          <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">
            Context injected into this run
          </p>
          <ul className="space-y-0.5">
            {result.injected_context.map((ref) => (
              <li key={ref.knowledge_id} className="text-xs text-gray-700 dark:text-gray-300">
                {ref.title}{' '}
                <span className="font-mono text-gray-400 dark:text-gray-500">{ref.knowledge_id}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* A spent read budget is a fact about the run, so it sits with the other
          run facts — steps, finish reason, duration — and is worded like them.
          It used to be an amber strip above the answer, which was the defect:
          amber over the answer IS a verdict on the answer, and whether the
          answer misses anything is not knowable from this flag. See
          readsWithheldFact() for the wording rule. */}
      {result.reads_withheld && (
        <p className="px-4 pb-3 text-xs text-gray-500 dark:text-gray-400">
          {readsWithheldFact(result.reads_withheld_reason)}
        </p>
      )}
      {result.tool_calls.length === 0 ? (
        <p className="px-4 pb-3 text-xs text-gray-500 dark:text-gray-400">
          The assistant answered without reading anything.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800 border-t border-gray-200 dark:border-border-subtle">
          {result.tool_calls.map((call, index) => (
            <ToolCallRow key={`${call.name}-${index}`} call={call} />
          ))}
        </ul>
      )}
      {/* Describes what the rows above actually contain. The filters ARE shown as
          values — a reader auditing what the model asked for needs them — and
          only free text is reduced to a count, so claiming "never the values"
          would either invite pasting a case id somewhere it does not belong or
          cast doubt on the values in plain sight. */}
      <p className="px-4 py-2 text-[11px] text-gray-400 dark:text-gray-500 border-t border-gray-200 dark:border-border-subtle">
        Recorded per call: the tool, the filters and sizes it was asked for — free-text queries as
        a character count, never their content — the result size, the duration, and the outcome.
      </p>
    </div>
  );
}

export function AssistantAnswerPanel({ caseData, events, runs = [] }: AssistantAnswerPanelProps) {
  const caseId = caseData.case_id;
  const { user } = useAuth();
  const { isAdmin } = useIsAdmin();
  const [traceOpen, setTraceOpen] = useState(false);

  // Same SWR key as the page's own evidence fetch, so this shares that cache
  // rather than adding a second request. The cadence is the case cadence, not
  // the page's 30s badge cadence: the `task_result` evidence row IS the answer
  // arriving, and on a terminal case the helper returns 0, so a finished task
  // stops polling entirely.
  const {
    data: evidenceData,
    error: evidenceError,
    mutate: refetchEvidence,
  } = useSWR(
    ['evidence', caseId],
    () => api.cases.evidence(caseId),
    { refreshInterval: getCasePollingInterval(caseData.status) },
  );
  const artifactRef = taskResultArtifactRef(evidenceData?.evidence);

  const { data: contentUrl, error, isLoading, mutate } = useSWR(
    assistantResultSwrKey(artifactRef, user?.uid),
    () => api.artifacts.content(artifactRef!),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  const failure = assistantFailureFromEvents(events);
  const cancelled = caseData.assistant_cancel_intent !== undefined
    || events?.some((event) => event.type === 'assistant_task_cancelled') === true;
  const activeRun = runs
    .filter(
      (run) =>
        run.run_type === 'assistant_task_run'
        && (run.status === 'pending' || run.status === 'running'),
    )
    .sort((left, right) => {
      const attempt = (right.attempt ?? 1) - (left.attempt ?? 1);
      return attempt !== 0 ? attempt : right.created_at.localeCompare(left.created_at);
    })[0];
  const canStop = activeRun !== undefined
    && (caseData.owner_user_id === user?.uid || isAdmin);
  const canFollowUp = caseData.status === 'done'
    && caseData.owner_user_id === user?.uid
    && caseData.assistant_context?.requester_user_id === user?.uid;
  const canInspectFeedback = caseData.status === 'done'
    && !!user?.uid
    && (canFollowUp || isAdmin);

  // No stored result yet — or no way to tell. Four situations that must not be
  // conflated: conflating them either promises an answer that is never coming,
  // hides a failure, or declares a running task dead.
  if (!artifactRef) {
    if (cancelled) {
      return (
        <Shell>
          <Header>
            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
              Task stopped
            </span>
          </Header>
          <div className="px-4 py-3 space-y-1.5">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              This Clerk task was stopped before it produced an answer.
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Reads and usage already recorded remain available in the Runs and Timeline tabs.
            </p>
          </div>
        </Shell>
      );
    }
    // The evidence list is how the answer is found, so a failed load means we
    // cannot tell whether one exists. Claiming "working" here is the opposite
    // of the truth on a finished case, and a terminal case polls at 0, so
    // nothing would ever correct it.
    if (evidenceError) {
      return (
        <UnavailableShell
          message={
            evidenceError instanceof Error
              ? `The case's evidence could not be loaded, so the answer could not be found: ${evidenceError.message}`
              : "The case's evidence could not be loaded, so the answer could not be found."
          }
          onRetry={() => void refetchEvidence()}
        />
      );
    }
    if (!evidenceData) {
      return <LoadingShell />;
    }

    // "No answer produced" is a terminal claim, so it needs a terminal fact: the
    // case reached an end state, or the pipeline wrote off the run for good. An
    // `assistant_task_failed` event is NOT that — it reports one attempt, the
    // sweep retries up to `ASSISTANT_MAX_ATTEMPTS`, and the case stays
    // non-terminal in between. Only `assistant_task_abandoned` says the failure
    // was the last word, which is what `failure.abandoned` carries.
    //
    // Terminality comes from `TERMINAL_STATUSES`, the UI's source of truth for it,
    // rather than a second list of statuses to keep in step.
    if (failure?.abandoned || isTerminalCaseStatus(caseData.status)) {
      return (
        <Shell>
          <Header>
            <span className="text-xs font-medium text-red-600 dark:text-red-400">
              No answer produced
            </span>
          </Header>
          <div className="px-4 py-3 space-y-1.5">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {failure?.abandoned
                ? 'The assistant stopped without answering, and the run was not retried further.'
                : 'The assistant stopped without answering.'}
            </p>
            {failure?.reason && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Recorded reason: <span className="font-mono">{failure.reason}</span>
              </p>
            )}
            {failure?.error && (
              <p className="text-xs text-gray-500 dark:text-gray-400">{failure.error}</p>
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400">
              The Timeline tab carries the full record of the attempt.
            </p>
          </div>
        </Shell>
      );
    }

    // A failed attempt on a case nobody has given up on: the next attempt is
    // already the assistant's business, so say that rather than either hiding
    // the failed attempt or announcing an ending that has not happened.
    if (failure) {
      return (
        <Shell>
          <Header>
            <span className="inline-flex items-center gap-3">
              <span className="inline-flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <LoadingSpinner size="sm" />
                Retrying
              </span>
              {canStop && activeRun && <StopTaskControl caseId={caseId} runId={activeRun.run_id} />}
            </span>
          </Header>
          <div className="px-4 py-3 space-y-1.5">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              An attempt failed and this case is still running, so the assistant is trying again.
              The answer appears here as soon as it is stored.
            </p>
            {failure.reason && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Reason the last attempt gave: <span className="font-mono">{failure.reason}</span>
              </p>
            )}
          </div>
        </Shell>
      );
    }

    return (
      <Shell>
        <Header>
          <span className="inline-flex items-center gap-3">
            <span className="inline-flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <LoadingSpinner size="sm" />
              Working
            </span>
            {canStop && activeRun && <StopTaskControl caseId={caseId} runId={activeRun.run_id} />}
          </span>
        </Header>
        <div className="px-4 py-3">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            The assistant is working on this request. The answer appears here as soon as it is
            stored.
          </p>
        </div>
      </Shell>
    );
  }

  if (isLoading || (!contentUrl && !error)) {
    return <LoadingShell />;
  }

  let result: AssistantTaskResult | null = null;
  let parseError: string | null = null;
  if (contentUrl) {
    try {
      result = parseAssistantTaskResult(contentUrl);
    } catch (err) {
      parseError = err instanceof Error ? err.message : 'Stored answer could not be read.';
    }
  }

  if (!result) {
    const message = parseError
      ?? (error instanceof Error ? error.message : 'Stored answer could not be loaded.');
    return <UnavailableShell message={message} onRetry={() => void mutate()} />;
  }

  const okCalls = result.tool_calls.filter((call) => call.outcome === 'ok').length;

  return (
    <Shell>
      <Header>
        <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          {result.as_of && (
            <RelativeTime timestamp={result.as_of} mode="exact" prefix="As of" />
          )}
          {result.as_of && <span aria-hidden="true">·</span>}
          <span>{result.model || 'model not recorded'}</span>
        </span>
      </Header>

      <div className="px-4 py-3">
        <MarkdownContent components={ANSWER_MARKDOWN_COMPONENTS}>{result.answer}</MarkdownContent>
      </div>

      <div className="border-t border-gray-200 dark:border-border-subtle">
        <button
          type="button"
          onClick={() => setTraceOpen((open) => !open)}
          aria-expanded={traceOpen}
          aria-controls="assistant-method"
          className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-surface-base/50 dark:hover:bg-border-subtle/30 transition-colors"
        >
          <span className="inline-flex items-center gap-2">
            <svg
              className={`h-3.5 w-3.5 text-gray-400 dark:text-gray-500 transition-transform ${traceOpen ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
              How this answer was produced
            </span>
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {result.tool_calls.length} tool call{result.tool_calls.length === 1 ? '' : 's'}
            {result.tool_calls.length > okCalls ? ` · ${result.tool_calls.length - okCalls} not ok` : ''}
            {' · '}
            {formatDurationMs(result.duration_ms)}
          </span>
        </button>
        {traceOpen && <AssistantMethodDetails result={result} />}
      </div>
      {/* Follow-up first: it is the action a requester actually takes to
          continue the conversation, so it renders directly under the
          method disclosure, ahead of feedback. */}
      {canFollowUp && (
        <div className="border-t border-gray-200 dark:border-border-subtle px-4 py-3">
          <FollowUpComposer caseId={caseId} />
        </div>
      )}
      {canInspectFeedback && user?.uid && (
        <div className="border-t border-gray-200 dark:border-border-subtle px-4 py-3">
          <FeedbackControl caseId={caseId} uid={user.uid} canEdit={canFollowUp} />
        </div>
      )}
    </Shell>
  );
}
