/**
 * Reading one Clerk task's stored result.
 *
 * The result of an `assistant_task` case is a JSON artifact written by
 * `AssistantTaskExecutor.completeAtomically` under the current
 * `arbitra.assistant_task_result/v2` schema (with read support for legacy v1),
 * referenced by the case's `task_result` evidence row and readable through
 * `GET /api/artifacts/:id/content`. The fields below are exactly the ones that
 * document writes — nothing here is inferred or renamed.
 *
 * Every function is pure so the decoding, selection, and wording rules can be
 * tested without rendering anything.
 *
 * ## Decode/parse/select logic moved to `@arbitra/shared`
 *
 * `ASSISTANT_TASK_RESULT_SCHEMA*`, `AssistantInjectedContextRef`,
 * `AssistantToolCall`, `AssistantTaskResult`, `decodeBase64DataUrl`,
 * `parseAssistantTaskResult`, and `taskResultArtifactRef` used to be defined
 * here. Slice F (`docs/specs/clerk-config-scheduling-chat.md`) needs a
 * backend-side reader of the same artifact (to post a Clerk answer into
 * Google Chat), and `packages/backend` cannot import frontend code — so
 * that logic now lives in `packages/shared/src/utils/assistant-task-result.ts`
 * and is re-exported below, unchanged, so every existing import of this
 * module keeps working exactly as before. Only the view-model-only helpers
 * that format for DISPLAY, never had a backend consumer, and stay below:
 * `assertAssistantResultPolicyParity`, `assistantFailureFromEvents`,
 * `readsWithheldFact`, `formatDurationMs`, `formatBytes`,
 * `describeToolParams`, `toolLabel`.
 */

import {
  ASSISTANT_TASK_RESULT_SCHEMA_V1,
  assertAssistantRunPolicyInvariant,
  assistantToolPoliciesEqual,
  type AssistantTaskResult,
  type CaseEvent,
  type Run,
} from '@arbitra/shared';

export {
  ASSISTANT_TASK_RESULT_SCHEMA,
  ASSISTANT_TASK_RESULT_SCHEMA_V1,
  ASSISTANT_TASK_RESULT_SCHEMA_V2,
  decodeBase64DataUrl,
  parseAssistantTaskResult,
  taskResultArtifactRef,
  type AssistantInjectedContextRef,
  type AssistantTaskResult,
  type AssistantToolCall,
} from '@arbitra/shared';

/**
 * Validate the cross-document invariant when a v2 result is read. Legacy v1
 * artifacts deliberately have no policy and remain readable without a Run
 * backfill or synthetic current-policy comparison.
 */
export function assertAssistantResultPolicyParity(
  result: AssistantTaskResult,
  run: Run | null,
): void {
  if (result.schema === ASSISTANT_TASK_RESULT_SCHEMA_V1) return;
  if (!run) throw new Error('Assistant v2 result has no linked Run');
  assertAssistantRunPolicyInvariant(run);
  if (
    run.run_type !== 'assistant_task_run'
    || run.assistant_policy_state !== 'bound'
    || !result.assistant_tool_policy
    || !assistantToolPoliciesEqual(run.assistant_tool_policy!, result.assistant_tool_policy)
  ) {
    throw new Error('Assistant v2 result policy does not match its bound Run');
  }
}

export interface AssistantFailure {
  /** Machine reason from `assistant_task_failed`, e.g. `bound:max_steps`. */
  reason: string | null;
  /** Operator-facing error text from `assistant_task_abandoned`, if any. */
  error: string | null;
  /** True once the failure was documented as permanent (no further attempt). */
  abandoned: boolean;
}

/**
 * What the timeline says about a task that produced no result.
 *
 * Both events matter and say different things: `assistant_task_failed` reports
 * ONE attempt's reason (a bound, a rejected answer, a completion error) and can
 * appear several times; `assistant_task_abandoned` is written once the pipeline
 * has given up on the run for good. Reporting the newest of each keeps "why the
 * last attempt failed" and "this is final" separable.
 */
export function assistantFailureFromEvents(
  events: CaseEvent[] | undefined,
): AssistantFailure | null {
  const failed = newestEvent(events, 'assistant_task_failed');
  const abandoned = newestEvent(events, 'assistant_task_abandoned');
  if (!failed && !abandoned) return null;

  const reason = failed ? stringField(failed.payload, 'reason') : null;
  const error = abandoned ? stringField(abandoned.payload, 'error') : null;
  return { reason, error, abandoned: abandoned !== null };
}

function newestEvent(events: CaseEvent[] | undefined, type: string): CaseEvent | null {
  const matching = (events ?? []).filter((event) => event.type === type);
  if (matching.length === 0) return null;
  return matching.reduce((best, event) =>
    Date.parse(event.created_at) > Date.parse(best.created_at) ? event : best,
  );
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * How a spent read budget is worded, and why it is worded like this.
 *
 * `reads_withheld` is a fact about the RUN and about nothing else: the step that
 * produced the answer had no reads left. It is not a claim about the answer, and
 * the wording must never become one — a request that needed exactly the whole
 * budget finishes completely and still reports `reads_withheld: true`, which is
 * the modal budget-boundary case, not the rare one.
 *
 * So the sentence names only what the run did. Banned outright: "incomplete",
 * "partial", "truncated" — and equally anything that implies a gap without
 * naming one: "only", "rests on", "before it finished". Whether the answer
 * misses something is not knowable from this flag, and if the model itself
 * found a gap it already says so in the answer text, which is the only place
 * that judgement can honestly be made.
 */
export function readsWithheldFact(reason: string | null): string {
  const budget = reason === 'step_budget'
    ? 'step budget'
    : reason === 'tool_call_budget'
      ? 'tool-call budget'
      : 'read budget';
  return `The run used its whole ${budget}; the answer was written with no reads left.`;
}

/** `1234` → `1.2s`; small numbers stay in milliseconds. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** `2048` → `2.0 kB`. Result sizes are informative, not exact accounting. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The parameter shape rendered as the phrase a reader can judge — "what was it
 * asked for". Only keys the tool descriptors actually declare are worded; an
 * unknown key still shows up as `key: value` rather than being dropped, so a
 * new descriptor field is visible before this list learns about it.
 */
export function describeToolParams(params: Record<string, string | number | boolean>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === '' || value === false || value === 0) continue;
    switch (key) {
      case 'query_chars':
        parts.push(`free text (${value} chars)`);
        break;
      case 'project_chars':
        parts.push(`project name (${value} chars)`);
        break;
      case 'case_id':
        parts.push(`case ${value}`);
        break;
      case 'knowledge_id':
        parts.push(`knowledge ${value}`);
        break;
      case 'status':
        parts.push(`status ${value}`);
        break;
      case 'type':
        parts.push(`type ${value}`);
        break;
      case 'created_after':
        parts.push(`created after ${value}`);
        break;
      case 'created_before':
        parts.push(`created before ${value}`);
        break;
      case 'order_by':
        parts.push(`ordered by ${value}`);
        break;
      case 'paged':
        parts.push('next page');
        break;
      case 'limit':
        parts.push(`limit ${value}`);
        break;
      default:
        parts.push(`${key}: ${value}`);
    }
  }
  return parts.join(' · ');
}

/** `arbitra_search_cases` → `search cases`. */
export function toolLabel(name: string): string {
  return name.replace(/^arbitra_/, '').replace(/_/g, ' ');
}
