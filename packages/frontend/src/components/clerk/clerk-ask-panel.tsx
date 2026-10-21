'use client';

/**
 * Asking Clerk something, and seeing what you asked before.
 *
 * Posts to `POST /api/assistant/tasks` — the same route the Google Chat channel
 * will use — and navigates to the case the task is tracked on, because watching
 * it work IS the case page (request, method, answer, sign-off in one place).
 *
 * Two behaviours here are not cosmetic:
 *
 *  - A first-time user has no Clerk core, so intake answers 409
 *    `CLERK_CORE_NOT_PROVISIONED`. Provisioning is idempotent, so we provision
 *    and retry rather than showing a dead end.
 *  - The retry reuses the SAME idempotency key as the first attempt, so if the
 *    first submission actually did create a case (any failure after the write),
 *    the retry replays it instead of creating a second one.
 */

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import { api, type AssistantTaskSummary } from '../../lib/api-client';
import { describeIntakeRefusal } from '../../lib/clerk-intake-refusal';
import { submitClerkTask } from '../../lib/clerk-task-submit';
import {
  groupAssistantTasksByThread,
  type AssistantTaskThreadGroup,
} from '../../lib/assistant-task-grouping';
import { useAuth } from '../../providers/auth-provider';
import { StatusBadge } from '../shared/status-badge';
import { RelativeTime } from '../shared/relative-time';

/**
 * SWR key for the task list, scoped by the signed-in uid for the same reason
 * `assistantResultSwrKey` and `artifactContentSwrKey` are: sign-out neither
 * reloads the app nor clears SWR's cache, so an unscoped key hands one account's
 * request titles and case ids to whoever signs in next in the same tab. `null`
 * until the uid is known, so nothing is fetched before there is an account to
 * fetch for.
 *
 * `limit` also has to be part of the key, not just the fetcher argument.
 * This panel and `ClerkScheduledPanel` render mutually exclusively (two tabs
 * on `/clerk`) but both read `GET /api/assistant/tasks` — this one at the
 * route's default limit, that one asking for 50 so its per-blueprint
 * grouping has enough rows to group. A shared 2-tuple key for two different
 * limits is cache BLEED, not dedup: whichever panel fetches second overwrites
 * the first panel's cached data with a differently-sized list, so switching
 * tabs back re-renders the previous tab with the wrong tasks until its own
 * revalidation lands. Passing `limit` only when it differs from this panel's
 * own default keeps the key `['assistant-tasks', uid]` here — unchanged from
 * before this doc comment — while giving the Scheduled tab's call a
 * genuinely distinct 3-tuple key.
 */
export function assistantTasksSwrKey(
  uid: string | undefined,
  limit?: number,
): readonly [string, string] | readonly [string, string, number] | null {
  if (!uid) return null;
  return limit ? ['assistant-tasks', uid, limit] : ['assistant-tasks', uid];
}

/**
 * A per-submission key so a provisioning retry cannot double-create. Falls back
 * to a timestamp-and-random string where `crypto.randomUUID` is unavailable —
 * uniqueness per submission is all the receipt needs.
 */
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `web-${crypto.randomUUID()}`;
  }
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function TaskRow({ task, indent = false }: { task: AssistantTaskSummary; indent?: boolean }) {
  return (
    <Link
      href={`/cases/${task.case_id}`}
      className={`flex items-center justify-between gap-3 py-2.5 hover:bg-surface-base/50 dark:hover:bg-border-subtle/30 transition-colors ${
        indent ? 'pl-8 pr-4' : 'px-4'
      }`}
    >
      <span
        className={`min-w-0 truncate text-sm ${
          indent ? 'text-gray-700 dark:text-gray-300' : 'text-gray-900 dark:text-gray-100'
        }`}
      >
        {task.title}
      </span>
      <span className="flex flex-shrink-0 items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
        <StatusBadge status={task.status} />
        <RelativeTime timestamp={task.updated_at} />
      </span>
    </Link>
  );
}

/**
 * A thread's root row plus its "N follow-ups" affordance. Collapsed by
 * default — expanding reveals the indented follow-up rows below, newest
 * first (same direction as the rest of this list; see
 * `groupAssistantTasksByThread`).
 *
 * The toggle is a sibling `<button>`, not nested inside the root's `<Link>`:
 * a `<button>` inside an `<a>` is invalid HTML (interactive-in-interactive),
 * so only the title text is the link and the follow-up count is its own
 * click target.
 */
function ThreadGroupRow({ group }: { group: AssistantTaskThreadGroup }) {
  const [open, setOpen] = useState(false);
  const count = group.followUps.length;

  return (
    <li>
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-surface-base/50 dark:hover:bg-border-subtle/30 transition-colors">
        <Link
          href={`/cases/${group.root.case_id}`}
          className="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-gray-100"
        >
          {group.root.title}
        </Link>
        <span className="flex flex-shrink-0 items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
          <StatusBadge status={group.root.status} />
          <RelativeTime timestamp={group.root.updated_at} />
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex-shrink-0 font-medium text-accent-700 dark:text-accent-300 hover:underline"
          >
            {count} follow-up{count === 1 ? '' : 's'}
          </button>
        </span>
      </div>
      {open && (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800 border-t border-gray-100 dark:border-gray-800">
          {group.followUps.map((task) => (
            <li key={task.case_id}>
              <TaskRow task={task} indent />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

interface ClerkAskPanelProps {
  /** Close a containing launcher drawer once navigation to the Case begins. */
  onTaskCreated?: () => void;
}

export function ClerkAskPanel({ onTaskCreated }: ClerkAskPanelProps = {}) {
  const router = useRouter();
  const { user } = useAuth();
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<{ message: string; blockingCaseIds: string[] } | null>(
    null,
  );
  // Survives a failed attempt so the retry replays rather than duplicates.
  const pendingKey = useRef<string | null>(null);

  // A task typically finishes in seconds, so the list refreshes on its own —
  // slowly, because the live view of a running task is its case page, not this
  // one.
  const { data, mutate } = useSWR(
    assistantTasksSwrKey(user?.uid),
    () => api.assistant.listTasks(),
    { refreshInterval: 15_000 },
  );
  const tasks = data?.tasks ?? [];
  // Threads collapse under their root's entry; a case without a thread link
  // renders exactly as it did before grouping existed.
  const entries = groupAssistantTasksByThread(tasks);

  const submit = useCallback(async () => {
    const request = text.trim();
    if (request.length === 0 || submitting) return;
    setSubmitting(true);
    setRefusal(null);
    const idempotencyKey = pendingKey.current ?? newIdempotencyKey();
    pendingKey.current = idempotencyKey;

    try {
      const created = await submitClerkTask(
        {
          createTask: api.assistant.createTask,
          provisionClerkCore: api.assistant.provisionClerkCore,
        },
        { text: request, idempotencyKey },
      );
      pendingKey.current = null;
      setText('');
      void mutate();
      onTaskCreated?.();
      router.push(`/cases/${created.case_id}`);
    } catch (error) {
      setRefusal(describeIntakeRefusal(error));
    } finally {
      setSubmitting(false);
    }
  }, [text, submitting, mutate, onTaskCreated, router]);

  return (
    <div className="space-y-4">
      <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg">
        <div className="border-b border-gray-200 dark:border-border-subtle px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Ask Clerk</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Clerk reads Arbitra on your behalf — cases, projects, knowledge — and answers in a case
            of its own, with the request, the reads it made, and the answer in one place.
          </p>
        </div>
        <form
          className="px-4 py-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div>
            <label
              htmlFor="clerk-request"
              className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Your request
            </label>
            <textarea
              id="clerk-request"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                // Edited text is a different request, so it must not replay the
                // previous attempt's receipt. The key survives only across a
                // retry of the SAME text.
                pendingKey.current = null;
              }}
              rows={4}
              placeholder="e.g. Which cases exist in the project Payments API, and what status is each in?"
              className="w-full rounded-md border border-gray-300 dark:border-border-default px-2.5 py-2 text-sm bg-input-bg dark:text-gray-200 dark:placeholder-gray-500 focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
          {refusal && (
            <div className="rounded-md border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
              <p className="text-xs text-amber-800 dark:text-amber-300">{refusal.message}</p>
              {refusal.blockingCaseIds.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {refusal.blockingCaseIds.map((caseId) => (
                    <li key={caseId}>
                      <Link
                        href={`/cases/${caseId}`}
                        className="text-xs font-medium text-accent-700 dark:text-accent-300 hover:underline"
                      >
                        {caseId}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {text.trim().length} characters
            </span>
            <button
              type="submit"
              disabled={submitting || text.trim().length === 0}
              className="inline-flex items-center rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 transition-colors"
            >
              {submitting ? 'Submitting…' : 'Ask Clerk'}
            </button>
          </div>
        </form>
      </div>

      <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg">
        <div className="border-b border-gray-200 dark:border-border-subtle px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Your recent tasks
          </h2>
        </div>
        {tasks.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            Nothing yet. Your tasks appear here once you have asked something.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {entries.map((entry) =>
              entry.kind === 'standalone' ? (
                <li key={entry.task.case_id}>
                  <TaskRow task={entry.task} />
                </li>
              ) : (
                <ThreadGroupRow key={entry.group.root.case_id} group={entry.group} />
              ),
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
