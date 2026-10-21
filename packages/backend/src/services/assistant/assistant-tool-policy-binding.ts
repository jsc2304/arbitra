import {
  assertAssistantRunPolicyInvariant,
  assistantToolPolicyRebindable,
  type AssistantToolPolicyTrace,
  type Run,
} from '@arbitra/shared';
import { collections, getDb } from '../../lib/firestore.js';

export type AssistantPolicyBindBlockedReason =
  | 'case_unavailable'
  | 'case_not_assistant_task'
  | 'case_not_in_build'
  | 'run_missing'
  | 'run_terminal'
  | 'run_not_running'
  | 'run_reassigned'
  | 'run_attempt_changed'
  | 'run_lease_missing'
  | 'run_lease_expired'
  | 'run_cancelled';

export type AssistantPolicyBindResult =
  | { kind: 'bound'; run: Run; replayed: boolean }
  | { kind: 'blocked'; reason: AssistantPolicyBindBlockedReason };

export class AssistantPolicyBindConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantPolicyBindConflictError';
  }
}

/**
 * Bind one immutable tool policy while the caller still owns the attempt.
 * This is the last durable fence before model/provider work can begin.
 */
export async function bindAssistantToolPolicy(input: {
  run: Run;
  policy: AssistantToolPolicyTrace;
  now?: Date;
  /** Compatibility for demo adapters that deliberately implement no claim. */
  allowClaimless?: boolean;
}): Promise<AssistantPolicyBindResult> {
  const caseRef = collections.cases().doc(input.run.case_id);
  const runRef = collections.runs().doc(input.run.run_id);

  return getDb().runTransaction<AssistantPolicyBindResult>(async (tx) => {
    const [caseSnap, runSnap] = await Promise.all([tx.get(caseRef), tx.get(runRef)]);
    const case_ = caseSnap.data();
    if (!case_ || case_.deleted_at) return { kind: 'blocked', reason: 'case_unavailable' };
    if (case_.case_type !== 'assistant_task') {
      return { kind: 'blocked', reason: 'case_not_assistant_task' };
    }

    const current = runSnap.data();
    if (!current) return { kind: 'blocked', reason: 'run_missing' };
    if (current.case_id !== input.run.case_id || current.run_type !== 'assistant_task_run') {
      throw new AssistantPolicyBindConflictError(
        `Run ${input.run.run_id} no longer belongs to this assistant task`,
      );
    }
    if (current.assistant_cancel_intent !== undefined) {
      return { kind: 'blocked', reason: 'run_cancelled' };
    }
    if (['completed', 'failed', 'cancelled'].includes(current.status)) {
      return { kind: 'blocked', reason: 'run_terminal' };
    }
    if (case_.status !== 'in_build') return { kind: 'blocked', reason: 'case_not_in_build' };

    const claimless = input.allowClaimless === true
      && current.status === 'pending'
      && current.awaiting_claim === true
      && current.worker_id === undefined
      && current.lease_expires_at === undefined;
    if (!claimless) {
      if (current.status !== 'running') return { kind: 'blocked', reason: 'run_not_running' };
      if (!input.run.worker_id || current.worker_id !== input.run.worker_id) {
        return { kind: 'blocked', reason: 'run_reassigned' };
      }
      if ((current.attempt ?? 1) !== (input.run.attempt ?? 1)) {
        return { kind: 'blocked', reason: 'run_attempt_changed' };
      }
      if (!current.lease_expires_at) return { kind: 'blocked', reason: 'run_lease_missing' };
      const leaseMs = Date.parse(current.lease_expires_at);
      if (!Number.isFinite(leaseMs) || leaseMs <= (input.now ?? new Date()).getTime()) {
        return { kind: 'blocked', reason: 'run_lease_expired' };
      }
    }

    assertAssistantRunPolicyInvariant(current, { allowLegacyTaskRead: true });
    // Re-entering an attempt that is already bound. The test is subset, not
    // equality (`assistantToolPolicyRebindable`): the executor keeps running
    // this attempt on the STORED policy — it returns `current` here, and
    // `assistant-task-executor.ts` builds the model's tool set with
    // `selectReadTools(policy.enabled_tools)` from that stored value — so a
    // fresh policy that enables more tools cannot widen a live attempt. Under
    // strict equality every registry addition killed every attempt in flight
    // across its deploy, with `policy_binding_failed`, which
    // `run-retry-policy.ts` classifies permanent.
    if (current.assistant_policy_state === 'bound') {
      if (!assistantToolPolicyRebindable(current.assistant_tool_policy!, input.policy)) {
        throw new AssistantPolicyBindConflictError(
          `Run ${input.run.run_id} is already bound to an assistant tool policy the current one cannot honour`,
        );
      }
      return { kind: 'bound', run: current, replayed: true };
    }

    const boundRun: Run = {
      ...current,
      assistant_policy_state: 'bound',
      assistant_tool_policy: input.policy,
      updated_at: new Date().toISOString(),
    };
    assertAssistantRunPolicyInvariant(boundRun);
    tx.update(runRef, {
      assistant_policy_state: boundRun.assistant_policy_state,
      assistant_tool_policy: boundRun.assistant_tool_policy,
      updated_at: boundRun.updated_at,
    });
    return { kind: 'bound', run: boundRun, replayed: false };
  });
}
