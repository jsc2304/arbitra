import { describe, expect, it } from 'vitest';
import {
  assistantToolPoliciesEqual,
  assistantToolPolicyRebindable,
  canonicalAssistantToolPolicy,
  type Run,
} from '../types/run.js';
import { assertAssistantRunPolicyInvariant, assistantToolPolicyTraceSchema } from './run-validators.js';

function run(overrides: Partial<Run> = {}): Run {
  return {
    run_id: 'run_1',
    case_id: 'case_1',
    run_type: 'assistant_task_run',
    trigger_source: 'assistant-intake:web',
    status: 'pending',
    input_refs: [],
    output_refs: [],
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
    ...overrides,
  };
}

const policy = {
  schema_version: 1 as const,
  task_kind: 'general_question' as const,
  enabled_tools: ['arbitra_search_cases'],
  tool_selection_reason: 'requester_scoped_read_registry' as const,
};

describe('assertAssistantRunPolicyInvariant', () => {
  it('accepts explicit unbound and bound task states', () => {
    expect(() => assertAssistantRunPolicyInvariant(run({
      assistant_policy_state: 'unbound',
    }))).not.toThrow();
    expect(() => assertAssistantRunPolicyInvariant(run({
      assistant_policy_state: 'bound',
      assistant_tool_policy: policy,
    }))).not.toThrow();
  });

  it('allows a missing policy only as an immutable legacy read', () => {
    // Removing the mode distinction would let intake create new ambiguous
    // rows or make old terminal rows unreadable; both are regressions.
    expect(() => assertAssistantRunPolicyInvariant(run())).toThrow(/must declare/);
    expect(() => assertAssistantRunPolicyInvariant(run(), {
      allowLegacyTaskRead: true,
    })).not.toThrow();
  });

  it('rejects mismatched state and snapshot combinations', () => {
    expect(() => assertAssistantRunPolicyInvariant(run({
      assistant_policy_state: 'unbound',
      assistant_tool_policy: policy,
    }))).toThrow(/Invalid assistant task policy shape/);
    expect(() => assertAssistantRunPolicyInvariant(run({
      assistant_policy_state: 'bound',
    }))).toThrow(/Invalid assistant task policy shape/);
  });

  it('keeps assistant action runs free of task read policy', () => {
    expect(() => assertAssistantRunPolicyInvariant(run({
      run_type: 'assistant_action_run',
      assistant_policy_state: 'bound',
      assistant_tool_policy: policy,
    }))).toThrow(/must not carry/);
  });

  it('accepts exactly one durable reconciliation state on a cancelled task Run', () => {
    // Reverting the cancelled+intent coupling would let an audit marker exist
    // on a live attempt, where it could be mistaken for a terminal receipt.
    const intent = {
      revision: 2,
      requested_at: '2026-08-05T08:00:00.000Z',
      requested_by: 'usr_requester',
    };
    expect(() => assertAssistantRunPolicyInvariant(run({
      status: 'cancelled',
      assistant_policy_state: 'bound',
      assistant_tool_policy: policy,
      assistant_cancel_intent: intent,
      assistant_cancel_reconcile_pending: true,
    }))).not.toThrow();
    expect(() => assertAssistantRunPolicyInvariant(run({
      status: 'cancelled',
      assistant_policy_state: 'bound',
      assistant_tool_policy: policy,
      assistant_cancel_intent: intent,
      assistant_cancel_receipt: {
        revision: 2,
        reconciled_at: '2026-08-05T08:00:01.000Z',
        reconciled_by: 'executor',
        usage_status: 'partial',
        trace_status: 'recorded',
        event_id: 'evt_cancelled_1',
      },
    }))).not.toThrow();
  });

  it('rejects simultaneous pending and receipted cancellation state', () => {
    // Removing this guard would let two contradictory answers to the durable
    // reconciliation handshake coexist on one Run.
    expect(() => assertAssistantRunPolicyInvariant(run({
      status: 'cancelled',
      assistant_policy_state: 'unbound',
      assistant_cancel_intent: {
        revision: 1,
        requested_at: '2026-08-05T08:00:00.000Z',
        requested_by: 'usr_requester',
      },
      assistant_cancel_reconcile_pending: true,
      assistant_cancel_receipt: {
        revision: 1,
        reconciled_at: '2026-08-05T08:00:01.000Z',
        reconciled_by: 'assistant_sweeper',
        usage_status: 'unavailable',
        trace_status: 'unavailable',
        event_id: 'evt_cancelled_1',
      },
    }))).toThrow(/pending reconciliation and receipted/);
  });

  it('rejects a receipt whose revision does not match the cancellation fence', () => {
    // Reverting the revision comparison would allow a stale reconciler to
    // acknowledge a newer cancellation generation.
    expect(() => assertAssistantRunPolicyInvariant(run({
      status: 'cancelled',
      assistant_policy_state: 'unbound',
      assistant_cancel_intent: {
        revision: 3,
        requested_at: '2026-08-05T08:00:00.000Z',
        requested_by: 'usr_requester',
      },
      assistant_cancel_receipt: {
        revision: 2,
        reconciled_at: '2026-08-05T08:00:01.000Z',
        reconciled_by: 'executor',
        usage_status: 'complete',
        trace_status: 'recorded',
        event_id: 'evt_cancelled_1',
      },
    }))).toThrow(/revision must match/);
  });
});

describe('assistantToolPolicyTraceSchema', () => {
  it('accepts a schema_version 1 trace', () => {
    expect(() => assistantToolPolicyTraceSchema.parse(policy)).not.toThrow();
  });

  it('rejects a schema_version other than 1', () => {
    expect(() =>
      assistantToolPolicyTraceSchema.parse({ ...policy, schema_version: 2 }),
    ).toThrow();
  });

  it('rejects an unknown key — the trace is strict', () => {
    expect(() =>
      assistantToolPolicyTraceSchema.parse({ ...policy, withheld_tools: [] }),
    ).toThrow();
  });
});

describe('canonicalAssistantToolPolicy / assistantToolPoliciesEqual / assistantToolPolicyRebindable', () => {
  const stored = {
    schema_version: 1 as const,
    task_kind: 'arbitra_data_question' as const,
    enabled_tools: ['arbitra_search_cases'],
    tool_selection_reason: 'requester_scoped_read_registry' as const,
  };

  it('canonicalises the same policy to the same string', () => {
    expect(canonicalAssistantToolPolicy(stored)).toBe(canonicalAssistantToolPolicy({ ...stored }));
    expect(assistantToolPoliciesEqual(stored, { ...stored })).toBe(true);
  });

  it('strict equality is order-sensitive on enabled_tools — a reordering is a different tool set', () => {
    const two = { ...stored, enabled_tools: ['arbitra_search_cases', 'arbitra_count_cases'] };
    const reordered = { ...stored, enabled_tools: ['arbitra_count_cases', 'arbitra_search_cases'] };
    expect(assistantToolPoliciesEqual(two, reordered)).toBe(false);
  });

  // The re-bind predicate is directional and asymmetric on purpose: the first
  // argument is what the attempt is already running on.
  it('a grown registry is rebindable, a shrunk one is not', () => {
    const grown = { ...stored, enabled_tools: [...stored.enabled_tools, 'arbitra_count_cases'] };
    // Strict equality would fail an otherwise-healthy attempt crossing a deploy
    // that added a tool; the subset rule lets it replay.
    expect(assistantToolPoliciesEqual(stored, grown)).toBe(false);
    expect(assistantToolPolicyRebindable(stored, grown)).toBe(true);
    // Reversed: the stored set names a tool the fresh policy no longer has.
    expect(assistantToolPolicyRebindable(grown, stored)).toBe(false);
  });

  it('a different task_kind is never rebindable, however wide the fresh enabled set', () => {
    expect(
      assistantToolPolicyRebindable(stored, {
        ...stored,
        task_kind: 'general_question',
        enabled_tools: [...stored.enabled_tools, 'arbitra_count_cases'],
      }),
    ).toBe(false);
  });
});
