/**
 * Decoding and reading a stored Clerk (`assistant_task`) result.
 *
 * The result of an `assistant_task` case is a JSON artifact written by
 * `AssistantTaskExecutor.completeAtomically` under the current
 * `arbitra.assistant_task_result/v2` schema (with read support for legacy
 * v1). The fields below are exactly the ones that document writes —
 * nothing here is inferred or renamed.
 *
 * ## Why this lives in `@arbitra/shared`, not `packages/frontend`
 *
 * This decode/parse/select logic originally lived only in
 * `packages/frontend/src/lib/assistant-task-result.ts`, reachable from UI
 * code and from frontend API routes but NOT from `packages/backend`
 * (backend cannot import frontend code). Slice F
 * (`docs/specs/clerk-config-scheduling-chat.md`) needs a backend-side reader
 * of the same artifact — to post a Clerk answer into Google Chat — so the
 * schema-reading half of that module moved here, to the one package both
 * frontend and backend already depend on. `packages/frontend/src/lib/assistant-task-result.ts`
 * re-exports every name below unchanged, so existing frontend imports keep
 * working with no behavior change; the view-model-only helpers that never
 * had a backend consumer (`assertAssistantResultPolicyParity`,
 * `assistantFailureFromEvents`, `readsWithheldFact`, `formatDurationMs`,
 * `formatBytes`, `describeToolParams`, `toolLabel`) stayed in the frontend
 * module — they format for display, not for reading.
 *
 * Every function is pure so the decoding and selection rules can be tested
 * without rendering anything.
 */

import type { Evidence } from '../types/evidence.js';
import type { AssistantToolPolicyTrace } from '../types/run.js';
import { parseAssistantToolPolicyTrace } from '../validation/run-validators.js';

export const ASSISTANT_TASK_RESULT_SCHEMA_V1 = 'arbitra.assistant_task_result/v1';
export const ASSISTANT_TASK_RESULT_SCHEMA_V2 = 'arbitra.assistant_task_result/v2';
export const ASSISTANT_TASK_RESULT_SCHEMA = ASSISTANT_TASK_RESULT_SCHEMA_V2;

/**
 * One always-inject Clerk context entry, as the executor recorded it on the
 * trace — name and id only, never the body it injected into the prompt
 * (`assistant-task-executor.ts`'s `completeAtomically`, #832 slice A).
 */
export interface AssistantInjectedContextRef {
  knowledge_id: string;
  title: string;
}

/** One tool call as the executor recorded it (`ToolCallRecord` in tool-registry.ts). */
export interface AssistantToolCall {
  name: string;
  /**
   * What the executor recorded of the arguments the model passed. Enumerated and
   * structured parameters are recorded as their values (`case_id`,
   * `knowledge_id`, `status`, `type`, `created_after`, `created_before`,
   * `order_by`, `paged`, `limit`); free text is recorded as a length only, never
   * its content (`query_chars`, `project_chars`). Left as an open record because
   * the set is per-tool and grows with the registry.
   */
  params: Record<string, string | number | boolean>;
  result_bytes: number;
  duration_ms: number;
  outcome: 'ok' | 'error' | 'bound_exceeded';
  /** Present on `error` / `bound_exceeded` only. */
  detail?: string;
}

/** The subset of the stored document this surface reads. */
export interface AssistantTaskResult {
  schema: typeof ASSISTANT_TASK_RESULT_SCHEMA_V1 | typeof ASSISTANT_TASK_RESULT_SCHEMA_V2;
  answer: string;
  model: string;
  /** Instant the model was told was current while composing the answer. */
  as_of?: string;
  task_kind?: string;
  assistant_tool_policy: AssistantToolPolicyTrace | null;
  assistant_tool_policy_availability: 'bound' | 'legacy_schema_v1/unavailable';
  steps: number;
  finish_reason: string;
  duration_ms: number;
  reads_withheld: boolean;
  reads_withheld_reason: string | null;
  tool_calls: AssistantToolCall[];
  /**
   * The requester's always-inject Clerk context that shaped this answer
   * (#832 slice A) — names and ids only. Absent on every artifact written
   * before this field existed; the parser below defaults those to `[]`
   * rather than treating a missing field as an error, the same way legacy
   * v1 artifacts stay readable without a policy.
   */
  injected_context: AssistantInjectedContextRef[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

/**
 * Decode a `data:` URL produced by `api.artifacts.content` back into text.
 *
 * The bytes are UTF-8: an answer routinely contains characters outside
 * Latin-1 (the executor's own preview elides with `…`). `atob` yields one
 * char per BYTE, so decoding its output as a string mangles every multi-byte
 * character — hence the explicit `TextDecoder` over the raw bytes.
 */
export function decodeBase64DataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma === -1) {
    throw new Error('Artifact content is not a data URL.');
  }
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Parse a stored assistant result, refusing anything that is not this schema.
 *
 * A wrong schema means we would be rendering some other artifact's fields as
 * an answer, which is worse than showing an error: this surface claims to show
 * what the assistant produced.
 */
export function parseAssistantTaskResult(dataUrl: string): AssistantTaskResult {
  const parsed = JSON.parse(decodeBase64DataUrl(dataUrl)) as Partial<AssistantTaskResult> & {
    assistant_tool_policy?: unknown;
  };
  if (
    parsed.schema !== ASSISTANT_TASK_RESULT_SCHEMA_V1
    && parsed.schema !== ASSISTANT_TASK_RESULT_SCHEMA_V2
  ) {
    throw new Error(
      `Unexpected artifact schema '${String(parsed.schema)}' — expected ${ASSISTANT_TASK_RESULT_SCHEMA_V1} or ${ASSISTANT_TASK_RESULT_SCHEMA_V2}.`,
    );
  }
  if (typeof parsed.answer !== 'string') {
    throw new Error('Assistant result carries no answer text.');
  }
  const policy = parsed.schema === ASSISTANT_TASK_RESULT_SCHEMA_V2
    ? parseAssistantToolPolicyTrace(parsed.assistant_tool_policy)
    : null;
  return {
    schema: parsed.schema,
    answer: parsed.answer,
    model: typeof parsed.model === 'string' ? parsed.model : '',
    ...(typeof parsed.as_of === 'string' ? { as_of: parsed.as_of } : {}),
    ...(typeof parsed.task_kind === 'string' ? { task_kind: parsed.task_kind } : {}),
    assistant_tool_policy: policy,
    assistant_tool_policy_availability: policy ? 'bound' : 'legacy_schema_v1/unavailable',
    steps: typeof parsed.steps === 'number' ? parsed.steps : 0,
    finish_reason: typeof parsed.finish_reason === 'string' ? parsed.finish_reason : '',
    duration_ms: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : 0,
    reads_withheld: parsed.reads_withheld === true,
    reads_withheld_reason:
      typeof parsed.reads_withheld_reason === 'string' ? parsed.reads_withheld_reason : null,
    tool_calls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [],
    injected_context: Array.isArray(parsed.injected_context) ? parsed.injected_context : [],
    usage: {
      input_tokens: parsed.usage?.input_tokens ?? 0,
      output_tokens: parsed.usage?.output_tokens ?? 0,
      total_tokens: parsed.usage?.total_tokens ?? 0,
    },
  };
}

/**
 * The artifact holding the newest stored result, or `null` while none exists.
 *
 * A retried task can carry more than one `task_result` row (one per completed
 * attempt), so the newest wins — that is the result the case's `done` status
 * was granted for.
 */
export function taskResultArtifactRef(evidence: Evidence[] | undefined): string | null {
  const rows = (evidence ?? []).filter(
    (row) => row.type === 'task_result' && !!row.artifact_ref,
  );
  if (rows.length === 0) return null;
  const newest = rows.reduce((best, row) =>
    Date.parse(row.created_at) > Date.parse(best.created_at) ? row : best,
  );
  return newest.artifact_ref ?? null;
}
