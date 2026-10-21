import { z } from 'zod';
import {
  ASSISTANT_TOOL_SELECTION_REASON,
  VALID_ASSISTANT_TASK_KINDS,
  type AssistantToolPolicyTrace,
  type Run,
} from '../types/run.js';

const enabledToolsSchema = z.array(z.string().min(1).max(200)).max(100)
  .refine((names) => new Set(names).size === names.length, 'Tool names must be unique');

export const assistantToolPolicyTraceSchema = z.object({
  schema_version: z.literal(1),
  task_kind: z.enum(VALID_ASSISTANT_TASK_KINDS),
  enabled_tools: enabledToolsSchema,
  tool_selection_reason: z.literal(ASSISTANT_TOOL_SELECTION_REASON),
}).strict();

export const assistantCancelIntentSchema = z.object({
  revision: z.number().int().positive(),
  requested_at: z.string().datetime(),
  requested_by: z.string().min(1).max(200),
}).strict();

export const assistantCancelReceiptSchema = z.object({
  revision: z.number().int().positive(),
  reconciled_at: z.string().datetime(),
  reconciled_by: z.enum(['executor', 'cancel_service', 'assistant_sweeper']),
  usage_status: z.enum(['complete', 'partial', 'unavailable']),
  trace_status: z.enum(['recorded', 'unavailable']),
  event_id: z.string().min(1).max(200),
}).strict();

export function parseAssistantToolPolicyTrace(value: unknown): AssistantToolPolicyTrace {
  return assistantToolPolicyTraceSchema.parse(value);
}

/**
 * Enforce the state-dependent Run shape at write boundaries.
 *
 * Reads may accept a legacy `assistant_task_run` with both policy fields
 * absent. New writes may not create that shape; a claim/bind transaction must
 * lazily upgrade it while it already owns the row. Every non-task Run is kept
 * policy-free so action and engineering execution cannot inherit Clerk reads.
 */
export function assertAssistantRunPolicyInvariant(
  run: Run,
  options: { allowLegacyTaskRead?: boolean } = {},
): void {
  const state = run.assistant_policy_state;
  const snapshot = run.assistant_tool_policy;

  if (run.run_type !== 'assistant_task_run') {
    if (
      state !== undefined
      || snapshot !== undefined
      || run.assistant_cancel_intent !== undefined
      || run.assistant_cancel_reconcile_pending !== undefined
      || run.assistant_cancel_receipt !== undefined
    ) {
      throw new Error(`${run.run_type} must not carry assistant task policy or cancel state`);
    }
    return;
  }

  if (run.assistant_cancel_intent !== undefined) {
    assistantCancelIntentSchema.parse(run.assistant_cancel_intent);
  }

  const pending = run.assistant_cancel_reconcile_pending;
  const receipt = run.assistant_cancel_receipt;
  if (pending !== undefined && pending !== true) {
    throw new Error('assistant_cancel_reconcile_pending may only be true when present');
  }
  if (receipt !== undefined) assistantCancelReceiptSchema.parse(receipt);
  if (pending !== undefined && receipt !== undefined) {
    throw new Error('A cancelled assistant run cannot be pending reconciliation and receipted');
  }
  if (pending !== undefined || receipt !== undefined) {
    if (run.status !== 'cancelled' || run.assistant_cancel_intent === undefined) {
      throw new Error('Assistant cancellation reconciliation state requires a cancelled Run and intent');
    }
    if (receipt && receipt.revision !== run.assistant_cancel_intent.revision) {
      throw new Error('Assistant cancellation receipt revision must match its intent');
    }
  }

  if (state === undefined && snapshot === undefined) {
    if (options.allowLegacyTaskRead === true) return;
    throw new Error('New assistant_task_run writes must declare assistant_policy_state');
  }
  if (state === 'unbound' && snapshot === undefined) return;
  if (state === 'bound' && snapshot !== undefined) {
    assistantToolPolicyTraceSchema.parse(snapshot);
    return;
  }
  throw new Error(
    `Invalid assistant task policy shape: state=${String(state)}, snapshot=${snapshot ? 'present' : 'absent'}`,
  );
}
