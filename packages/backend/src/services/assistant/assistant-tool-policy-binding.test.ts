import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Case, Run } from '@arbitra/shared';

/**
 * `bindAssistantToolPolicy` — re-entering an already-bound attempt (#835).
 *
 * A bound Run can be re-entered before it finishes: a lease-expiry reclaim, a
 * retry landing after a Cloud Run revision swap, both ordinary events inside
 * the tens-of-seconds bind-to-completion window. The re-entering executor
 * always carries a FRESHLY computed policy, and the bind has to decide whether
 * that is an idempotent replay or a genuine conflict.
 *
 * The test is `assistantToolPolicyRebindable` (`packages/shared/src/types/run.ts`),
 * a subset check, not `assistantToolPoliciesEqual`. The attempt keeps running
 * on its STORED snapshot, so a fresh policy that enables MORE — every registry
 * addition — cannot widen it and must replay. A fresh policy that no longer
 * enables a tool the stored snapshot named is a real conflict and must still
 * throw: that throw becomes `policy_binding_failed`, which
 * `run-retry-policy.ts` classifies permanent.
 *
 * A tiny Firestore double stands in for `lib/firestore.js`, using the
 * `allowClaimless` bind path so no lease/worker bookkeeping is needed to
 * reach the comparison this test exists for.
 */

type Row = Record<string, unknown>;

const caseStore = new Map<string, Row>();
const runStore = new Map<string, Row>();

function makeRef(store: Map<string, Row>, id: string) {
  return {
    id,
    async get() {
      const data = store.get(id);
      return { exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
    },
  };
}

const collections = {
  cases: () => ({ doc: (id: string) => makeRef(caseStore, id) }),
  runs: () => ({ doc: (id: string) => makeRef(runStore, id) }),
};

const fakeDb = {
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const tx = {
      get: (ref: { get: () => unknown }) => ref.get(),
      update: (ref: { id: string }, patch: Row) => {
        const current = runStore.get(ref.id) ?? {};
        runStore.set(ref.id, { ...current, ...patch });
      },
    };
    return fn(tx);
  },
};

vi.mock('../../lib/firestore.js', () => ({ collections, getDb: () => fakeDb }));

const { bindAssistantToolPolicy, AssistantPolicyBindConflictError } = await import(
  './assistant-tool-policy-binding.js'
);

const CASE_ID = 'case_policy_bind';
const RUN_ID = 'run_policy_bind';

function seedCase(overrides: Partial<Case> = {}) {
  caseStore.set(CASE_ID, {
    case_id: CASE_ID,
    case_type: 'assistant_task',
    status: 'in_build',
    ...overrides,
  } as unknown as Row);
}

/** Claimless so no lease/worker matching is needed to reach the equality check. */
function seedRun(overrides: Partial<Run> = {}) {
  runStore.set(RUN_ID, {
    run_id: RUN_ID,
    case_id: CASE_ID,
    run_type: 'assistant_task_run',
    status: 'pending',
    awaiting_claim: true,
    ...overrides,
  } as unknown as Row);
}

function dispatchedRun(): Run {
  return {
    run_id: RUN_ID,
    case_id: CASE_ID,
    run_type: 'assistant_task_run',
    trigger_source: 'assistant-intake:web',
    status: 'pending',
    input_refs: [],
    output_refs: [],
    created_at: '2026-08-05T00:00:00.000Z',
    updated_at: '2026-08-05T00:00:00.000Z',
  } as unknown as Run;
}

const STORED = {
  schema_version: 1 as const,
  task_kind: 'arbitra_data_question' as const,
  enabled_tools: ['arbitra_search_cases', 'arbitra_get_case'],
  tool_selection_reason: 'requester_scoped_read_registry' as const,
};

beforeEach(() => {
  caseStore.clear();
  runStore.clear();
});

describe('bindAssistantToolPolicy — re-binding an already-bound Run', () => {
  it('1. the read registry grew between the bind and the re-entry ⇒ replayed, no conflict', async () => {
    // The case the whole change exists for. Every tool added to the registry
    // changes what `decideAssistantPolicy` computes, so under the previous
    // `assistantToolPoliciesEqual` comparison EVERY attempt in flight across
    // that deploy threw here and was rejected as a permanent failure.
    // Restoring `assistantToolPoliciesEqual` in `assistant-tool-policy-binding.ts`
    // makes this test throw instead.
    seedCase();
    seedRun({ assistant_policy_state: 'bound', assistant_tool_policy: STORED });
    const freshWithOneMoreTool = {
      ...STORED,
      enabled_tools: [...STORED.enabled_tools, 'arbitra_count_cases'],
    };

    const result = await bindAssistantToolPolicy({
      run: dispatchedRun(),
      policy: freshWithOneMoreTool,
      allowClaimless: true,
    });

    expect(result).toMatchObject({ kind: 'bound', replayed: true });
    // The attempt keeps its OWN set — the extra tool is not handed to it.
    expect((result as { run: Run }).run.assistant_tool_policy).toEqual(STORED);
  });

  it('2. the fresh policy no longer enables a tool the stored snapshot named ⇒ conflict', async () => {
    // Fail-closed half of the subset rule: tool REMOVAL still conflicts.
    // Replacing `every(...)` in `assistantToolPolicyRebindable`
    // (`packages/shared/src/types/run.ts`) with a bare `return true` makes
    // this test replay instead of throwing.
    seedCase();
    seedRun({ assistant_policy_state: 'bound', assistant_tool_policy: STORED });
    const freshWithoutGetCase = {
      ...STORED,
      enabled_tools: ['arbitra_search_cases'],
    };

    await expect(
      bindAssistantToolPolicy({
        run: dispatchedRun(),
        policy: freshWithoutGetCase,
        allowClaimless: true,
      }),
    ).rejects.toBeInstanceOf(AssistantPolicyBindConflictError);
  });

  it('3. a different task_kind is still a conflict, even with a wider fresh enabled set', async () => {
    // Dropping the `stored.task_kind !== fresh.task_kind` guard in
    // `assistantToolPolicyRebindable` makes this test replay instead.
    seedCase();
    seedRun({ assistant_policy_state: 'bound', assistant_tool_policy: STORED });
    const freshDifferentKind = {
      ...STORED,
      task_kind: 'general_question' as const,
      enabled_tools: [...STORED.enabled_tools, 'arbitra_count_cases'],
    };

    await expect(
      bindAssistantToolPolicy({
        run: dispatchedRun(),
        policy: freshDifferentKind,
        allowClaimless: true,
      }),
    ).rejects.toBeInstanceOf(AssistantPolicyBindConflictError);
  });

  it('replays an identical bind without conflict (baseline)', async () => {
    seedCase();
    seedRun({ assistant_policy_state: 'bound', assistant_tool_policy: STORED });

    const result = await bindAssistantToolPolicy({
      run: dispatchedRun(),
      policy: STORED,
      allowClaimless: true,
    });

    expect(result).toMatchObject({ kind: 'bound', replayed: true });
  });
});
