import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import type { Case, Run } from '@arbitra/shared';

/**
 * Unclaimed run creation + atomic claim (`createUnclaimedRun` / `claimRun`).
 *
 * The claim predicate is the entire safety property of the assistant run path:
 * if it ever admits a run another worker already holds, two workers execute the
 * same task. So the Firestore double here models the one behaviour that makes
 * the predicate meaningful — transactions COMMIT SERIALLY, and a transaction
 * that starts after another has committed observes the committed state. A
 * double that let two transactions read the same pre-write snapshot and both
 * write would pass a broken predicate.
 */

const runStore = new Map<string, Run>();
const caseStore = new Map<string, Case>();

/** Merge `updates` onto `current`, honoring `FieldValue.delete()` sentinels. */
function applyFirestoreUpdate(current: Run, updates: Record<string, unknown>): Run {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (value instanceof FieldValue) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next as unknown as Run;
}

function runDocRef(id: string) {
  return {
    id,
    async get() {
      const data = runStore.get(id);
      return { exists: data !== undefined, data: () => data };
    },
    async set(data: Run) {
      runStore.set(id, data);
    },
    async update(updates: Record<string, unknown>) {
      const current = runStore.get(id);
      if (!current) return;
      runStore.set(id, applyFirestoreUpdate(current, updates));
    },
  };
}

/** Same ref surface as a Run ref so one transaction fake can read both docs. */
function caseDocRef(id: string): ReturnType<typeof runDocRef> {
  return {
    id,
    async get() {
      const data = caseStore.get(id);
      return { exists: data !== undefined, data: () => data as unknown as Run | undefined };
    },
    async set(data: Run) {
      caseStore.set(id, data as unknown as Case);
    },
    async update(updates: Record<string, unknown>) {
      const current = caseStore.get(id);
      if (!current) return;
      caseStore.set(id, { ...current, ...updates } as Case);
    },
  };
}

type FakeRef = ReturnType<typeof runDocRef>;

// Single in-flight promise chain: writes of transaction N are applied before
// transaction N+1's read runs, mirroring Firestore's commit ordering for a
// contended document.
let txQueue: Promise<unknown> = Promise.resolve();

const fakeDb = {
  async runTransaction<T>(
    fn: (tx: {
      get: (ref: FakeRef) => Promise<{ exists: boolean; data: () => Run | undefined }>;
      update: (ref: FakeRef, updates: Record<string, unknown>) => void;
      create: (ref: FakeRef, data: Run) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const next = txQueue.then(async () => {
      const writes: Array<
        | { op: 'update'; ref: FakeRef; updates: Record<string, unknown> }
        | { op: 'create'; ref: FakeRef; data: Run }
      > = [];
      const tx = {
        get: async (ref: FakeRef) => ref.get(),
        update: (ref: FakeRef, updates: Record<string, unknown>) => {
          writes.push({ op: 'update', ref, updates });
        },
        create: (ref: FakeRef, data: Run) => writes.push({ op: 'create', ref, data }),
      };
      const result = await fn(tx);
      for (const write of writes) {
        if (write.op === 'create') {
          if (runStore.has(write.ref.id)) throw new Error(`ALREADY_EXISTS: ${write.ref.id}`);
          await write.ref.set(write.data);
        } else {
          await write.ref.update(write.updates);
        }
      }
      return result;
    });
    txQueue = next.catch(() => undefined);
    return next;
  },
};

vi.mock('../../lib/firestore.js', () => ({
  getDb: () => fakeDb,
  collections: {
    runs: () => ({ doc: (id: string) => runDocRef(id) }),
    cases: () => ({ doc: (id: string) => caseDocRef(id) }),
  },
}));

vi.mock('../event/event-service.js', () => ({
  EventService: class {
    async emit() {}
  },
}));

vi.mock('../case/case-repository.js', () => ({
  CaseRepository: class {},
}));

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: 'run_1',
    case_id: 'case_1',
    run_type: 'assistant_task_run',
    trigger_source: 'system:test',
    status: 'pending',
    input_refs: [],
    output_refs: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    awaiting_claim: true,
    attempt: 1,
    ...overrides,
  };
}

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Assistant task',
    description: 'Answer the requester',
    source_type: 'manual',
    source_ref: '',
    project_id: 'project_1',
    repository_id: 'repo_1',
    owner_user_id: 'user_1',
    status: 'in_build',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    case_type: 'assistant_task',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const CANCEL_INTENT = {
  revision: 1,
  requested_at: '2026-01-01T00:05:00.000Z',
  requested_by: 'user_1',
} as const;

// The adapter reads the lease TTL at module load — clear any value a sibling
// test file may have left in the environment so the 5-minute default applies.
delete process.env['ARBITRA_RUN_LEASE_TTL_MS'];
const { FirestorePipelineAdapter } = await import('./firestore-pipeline-adapter.js');

describe('FirestorePipelineAdapter.createUnclaimedRun', () => {
  beforeEach(() => {
    runStore.clear();
    caseStore.clear();
    caseStore.set('case_1', makeCase());
    txQueue = Promise.resolve();
  });

  it('creates a pending run with NO lease and NO worker', async () => {
    const adapter = new FirestorePipelineAdapter();

    const run = await adapter.createUnclaimedRun('case_1', 'assistant_task_run', 'system:test');

    expect(run.status).toBe('pending');
    expect(run.lease_expires_at).toBeUndefined();
    expect(run.worker_id).toBeUndefined();
    // Execution has not started — `claimRun` stamps `started_at`.
    expect(run.started_at).toBeUndefined();
    expect(run.awaiting_claim).toBe(true);
    expect(run.attempt).toBe(1);
    expect(run.assistant_policy_state).toBe('unbound');
    expect(run.assistant_tool_policy).toBeUndefined();

    const persisted = runStore.get(run.run_id);
    expect(persisted?.lease_expires_at).toBeUndefined();
    expect(persisted?.worker_id).toBeUndefined();
    expect(persisted?.awaiting_claim).toBe(true);
  });

  it('stamps the requested attempt number', async () => {
    const adapter = new FirestorePipelineAdapter();
    const run = await adapter.createUnclaimedRun('case_1', 'assistant_action_run', 'system:test', 3);
    expect(run.attempt).toBe(3);
    expect(run.run_type).toBe('assistant_action_run');
    expect(run.assistant_policy_state).toBeUndefined();
    expect(run.assistant_tool_policy).toBeUndefined();
  });

  it('createRun still stamps a lease and a worker (unchanged, and therefore not claimable)', async () => {
    const adapter = new FirestorePipelineAdapter();

    const run = await adapter.createRun('case_1', 'assistant_task_run', 'system:test');

    expect(run.lease_expires_at).toBeTruthy();
    expect(run.worker_id).toBeTruthy();
    expect(run.awaiting_claim).toBeUndefined();
    expect(run.assistant_policy_state).toBe('unbound');

    const result = await adapter.claimRun(run.run_id, 'worker_x');
    expect(result.claimed).toBe(false);
    expect(runStore.get(run.run_id)?.worker_id).toBe(run.worker_id);
  });
});

describe('FirestorePipelineAdapter.prepareAssistantReattempt', () => {
  beforeEach(() => {
    runStore.clear();
    caseStore.clear();
    caseStore.set('case_1', makeCase());
    txQueue = Promise.resolve();
  });

  it('replays one deterministic unbound replacement instead of creating a second attempt', async () => {
    const adapter = new FirestorePipelineAdapter();

    const [first, replay] = await Promise.all([
      adapter.prepareAssistantReattempt('case_1', 'assistant_task_run', 'assistant-intake:web', 2),
      adapter.prepareAssistantReattempt('case_1', 'assistant_task_run', 'assistant-intake:web', 2),
    ]);

    // Reverting to random createUnclaimedRun ids makes the store contain two
    // attempt-2 rows after a crash/re-drive.
    expect(first.run_id).toBe(replay.run_id);
    expect(runStore).toHaveProperty('size', 1);
    expect(first.assistant_policy_state).toBe('unbound');
    expect(first.assistant_tool_policy).toBeUndefined();
  });

  it('Case cancellation fence: prepareAssistantReattempt cannot create a post-cancel retry', async () => {
    caseStore.set('case_1', makeCase({
      status: 'in_build',
      assistant_cancel_intent: CANCEL_INTENT,
    }));
    const adapter = new FirestorePipelineAdapter();

    // Removing the `case_.assistant_cancel_intent !== undefined` predicate from
    // `prepareAssistantReattempt` creates a new claimable Run after cancellation.
    await expect(
      adapter.prepareAssistantReattempt('case_1', 'assistant_task_run', 'assistant-intake:web', 2),
    ).rejects.toThrow(/terminal or cancelled/);
    expect(runStore).toHaveProperty('size', 0);
  });
});

describe('FirestorePipelineAdapter.claimRun', () => {
  beforeEach(() => {
    runStore.clear();
    caseStore.clear();
    caseStore.set('case_1', makeCase());
    txQueue = Promise.resolve();
  });

  it('claims a pending, unowned run: running + fresh lease + worker_id + started_at', async () => {
    runStore.set('run_1', makeRun());
    const adapter = new FirestorePipelineAdapter();
    const before = Date.now();

    const { claimed, run } = await adapter.claimRun('run_1', 'worker_a');

    expect(claimed).toBe(true);
    expect(run?.status).toBe('running');
    expect(run?.worker_id).toBe('worker_a');
    expect(run?.started_at).toBeTruthy();
    expect(run?.lease_expires_at).toBeTruthy();
    // Default lease TTL is 5 minutes (ARBITRA_RUN_LEASE_TTL_MS default 300000).
    const leaseMs = new Date(run!.lease_expires_at!).getTime() - before;
    expect(leaseMs).toBeGreaterThan(299_000);
    expect(leaseMs).toBeLessThan(310_000);

    // The returned doc is the POST-claim doc — the caller dispatches this one.
    const persisted = runStore.get('run_1');
    expect(persisted?.status).toBe('running');
    expect(persisted?.worker_id).toBe('worker_a');
    expect(persisted?.lease_expires_at).toBe(run?.lease_expires_at);
    // The flag's only job was to explain the lease-less window.
    expect(persisted?.awaiting_claim).toBeUndefined();
    expect(run?.awaiting_claim).toBeUndefined();
    // Removing the claim-time upgrade leaves a legacy run policy-unavailable
    // even though this transaction now owns it.
    expect(run?.assistant_policy_state).toBe('unbound');
    expect(run?.assistant_tool_policy).toBeUndefined();
  });

  it('preserves an explicitly unbound task run while claiming it', async () => {
    runStore.set('run_1', makeRun({ assistant_policy_state: 'unbound' }));
    const adapter = new FirestorePipelineAdapter();

    const { claimed, run } = await adapter.claimRun('run_1', 'worker_a');

    expect(claimed).toBe(true);
    expect(run?.assistant_policy_state).toBe('unbound');
    expect(run?.assistant_tool_policy).toBeUndefined();
  });

  it('keeps an assistant action run free of task read-policy state', async () => {
    runStore.set('run_1', makeRun({ run_type: 'assistant_action_run' }));
    const adapter = new FirestorePipelineAdapter();

    const { claimed, run } = await adapter.claimRun('run_1', 'worker_a');

    expect(claimed).toBe(true);
    expect(run?.assistant_policy_state).toBeUndefined();
    expect(run?.assistant_tool_policy).toBeUndefined();
  });

  it('fails closed on a malformed unbound run that already carries a snapshot', async () => {
    runStore.set('run_1', makeRun({
      assistant_policy_state: 'unbound',
      assistant_tool_policy: {
        schema_version: 1,
        task_kind: 'general_question',
        enabled_tools: [],
        tool_selection_reason: 'requester_scoped_read_registry',
      },
    }));
    const adapter = new FirestorePipelineAdapter();

    await expect(adapter.claimRun('run_1', 'worker_a')).rejects.toThrow(
      'Invalid assistant task policy shape',
    );
  });

  it('RACE: exactly one of two concurrent claims of the same run wins', async () => {
    runStore.set('run_1', makeRun());
    const adapter = new FirestorePipelineAdapter();

    const [a, b] = await Promise.all([
      adapter.claimRun('run_1', 'worker_a'),
      adapter.claimRun('run_1', 'worker_b'),
    ]);

    const winners = [a, b].filter((r) => r.claimed);
    expect(winners).toHaveLength(1);
    // The persisted doc belongs to the winner, and only the winner.
    const persisted = runStore.get('run_1');
    expect(persisted?.status).toBe('running');
    expect(persisted?.worker_id).toBe(winners[0]!.run?.worker_id);
  });

  it('RACE: exactly one of five concurrent claims of the same run wins', async () => {
    runStore.set('run_1', makeRun());
    const adapter = new FirestorePipelineAdapter();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_unused, i) => adapter.claimRun('run_1', `worker_${i}`)),
    );

    expect(results.filter((r) => r.claimed)).toHaveLength(1);
  });

  it('refuses a run that is already claimed (a second sequential claim fails)', async () => {
    runStore.set('run_1', makeRun());
    const adapter = new FirestorePipelineAdapter();

    const first = await adapter.claimRun('run_1', 'worker_a');
    expect(first.claimed).toBe(true);

    const second = await adapter.claimRun('run_1', 'worker_b');
    expect(second.claimed).toBe(false);
    // Not stolen from the first holder.
    expect(runStore.get('run_1')?.worker_id).toBe('worker_a');
  });

  it('Case cancellation fence: claimRun leaves an otherwise claimable assistant Run pending', async () => {
    runStore.set('run_1', makeRun());
    caseStore.set('case_1', makeCase({
      status: 'in_build',
      assistant_cancel_intent: CANCEL_INTENT,
    }));
    const adapter = new FirestorePipelineAdapter();

    const result = await adapter.claimRun('run_1', 'worker_late');

    // Removing `case_.assistant_cancel_intent !== undefined` in `claimRun` changes this to
    // running and starts a worker after the cancellation transaction committed.
    expect(result.claimed).toBe(false);
    expect(runStore.get('run_1')).toMatchObject({
      status: 'pending',
      awaiting_claim: true,
    });
    expect(runStore.get('run_1')?.worker_id).toBeUndefined();
    expect(runStore.get('run_1')?.lease_expires_at).toBeUndefined();
  });

  it.each([
    ['running', 'running'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)('refuses a run whose status is %s, not pending', async (_label, status) => {
    runStore.set('run_1', makeRun({ status, awaiting_claim: undefined }));
    const adapter = new FirestorePipelineAdapter();

    const { claimed } = await adapter.claimRun('run_1', 'worker_a');

    expect(claimed).toBe(false);
    expect(runStore.get('run_1')?.status).toBe(status);
    expect(runStore.get('run_1')?.worker_id).toBeUndefined();
  });

  it('treats an EXPIRED lease as still held — recovery is a new attempt, never a re-claim', async () => {
    runStore.set(
      'run_1',
      makeRun({ status: 'pending', lease_expires_at: '2020-01-01T00:00:00.000Z', worker_id: 'worker_dead' }),
    );
    const adapter = new FirestorePipelineAdapter();

    const { claimed } = await adapter.claimRun('run_1', 'worker_b');

    expect(claimed).toBe(false);
    expect(runStore.get('run_1')?.worker_id).toBe('worker_dead');
  });

  it('fails closed on a pending run that has a worker_id but no lease', async () => {
    runStore.set('run_1', makeRun({ worker_id: 'worker_partial' }));
    const adapter = new FirestorePipelineAdapter();

    const { claimed } = await adapter.claimRun('run_1', 'worker_b');

    expect(claimed).toBe(false);
    expect(runStore.get('run_1')?.worker_id).toBe('worker_partial');
  });

  it('fails closed on a pending run that has a lease but no worker_id', async () => {
    runStore.set('run_1', makeRun({ lease_expires_at: '2099-01-01T00:00:00.000Z' }));
    const adapter = new FirestorePipelineAdapter();

    const { claimed } = await adapter.claimRun('run_1', 'worker_b');

    expect(claimed).toBe(false);
  });

  it('returns claimed:false with a null run when the doc no longer exists', async () => {
    const adapter = new FirestorePipelineAdapter();
    const result = await adapter.claimRun('missing_run', 'worker_a');
    expect(result).toEqual({ claimed: false, run: null });
  });

  it('completeRun releases the lease a claim took, leaving nothing for the sweep to find', async () => {
    runStore.set('run_1', makeRun());
    const adapter = new FirestorePipelineAdapter();

    await adapter.claimRun('run_1', 'worker_a');
    await adapter.completeRun('run_1', 'case_1', 'done');

    const persisted = runStore.get('run_1');
    expect(persisted?.status).toBe('completed');
    expect(persisted?.lease_expires_at).toBeUndefined();
    expect(persisted?.worker_id).toBeUndefined();
    expect(persisted?.awaiting_claim).toBeUndefined();
  });

  it('Run cancellation fence: refreshRunLease cannot extend a cancelled worker heartbeat', async () => {
    const originalLease = '2026-01-01T00:06:00.000Z';
    runStore.set('run_1', makeRun({
      status: 'running',
      awaiting_claim: undefined,
      worker_id: 'worker_a',
      lease_expires_at: originalLease,
      assistant_cancel_intent: CANCEL_INTENT,
    }));
    caseStore.set('case_1', makeCase({
      status: 'in_build',
      assistant_cancel_intent: CANCEL_INTENT,
    }));
    const adapter = new FirestorePipelineAdapter();

    await adapter.refreshRunLease('run_1', 'worker_a');

    // Removing `run.assistant_cancel_intent !== undefined` from the transactional
    // heartbeat predicate extends this lease and makes the cancelled worker live.
    expect(runStore.get('run_1')?.lease_expires_at).toBe(originalLease);
    expect(runStore.get('run_1')?.updated_at).toBe('2026-01-01T00:00:00.000Z');
  });
});
