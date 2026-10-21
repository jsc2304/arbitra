import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import type { Case, Rule, RuleSet, Run } from '@arbitra/shared';

/**
 * In-memory Firestore double for the case doc that the heal touches.
 * Runs transactions with serialized read-modify-write semantics, mirroring
 * Firestore's real behaviour: only one tx can flip the flag, the loser sees
 * the post-write state and short-circuits.
 */
interface Store {
  case_: Case;
}

const store: Store = {
  case_: makeCase(),
};

/** In-memory Firestore double for the `runs` collection (lease stamping). */
const runStore = new Map<string, Run>();

/**
 * Merge `updates` onto `current`, honoring `FieldValue.delete()` sentinels
 * (real Firestore removes the key entirely; a naive object spread would
 * instead assign the sentinel object as the field's value).
 */
function applyFirestoreUpdate<T extends Record<string, unknown>>(current: T, updates: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (value instanceof FieldValue) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next as T;
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
    async update(updates: Partial<Run>) {
      const current = runStore.get(id) as Run;
      runStore.set(id, applyFirestoreUpdate(current, updates));
    },
  };
}

const ruleSets: { value: RuleSet[] } = { value: [] };

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: 'run_1',
    case_id: 'case_1',
    run_type: 'review_run',
    trigger_source: 'system',
    status: 'running',
    input_refs: [],
    output_refs: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'c',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'p',
    repository_id: 'r',
    owner_user_id: 'u',
    status: 'in_review',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Serialize transactions to model Firestore's commit ordering: we use a
// single in-flight promise chain so two `runTransaction` callers cannot
// observe the same pre-write state.
let txQueue: Promise<unknown> = Promise.resolve();

function caseDocRef() {
  return {
    id: store.case_.case_id,
    async get() {
      return { data: () => store.case_, exists: true };
    },
    async update(updates: Partial<Case>) {
      store.case_ = { ...store.case_, ...updates };
    },
  };
}

const fakeDb = {
  async runTransaction<T>(fn: (tx: {
    get: (ref: ReturnType<typeof caseDocRef>) => Promise<{ data: () => Case }>;
    update: (ref: ReturnType<typeof caseDocRef>, updates: Partial<Case>) => void;
  }) => Promise<T>): Promise<T> {
    const next = txQueue.then(async () => {
      const writes: Array<{ ref: ReturnType<typeof caseDocRef>; updates: Partial<Case> }> = [];
      const tx = {
        get: async (ref: ReturnType<typeof caseDocRef>) => ref.get(),
        update: (ref: ReturnType<typeof caseDocRef>, updates: Partial<Case>) => {
          writes.push({ ref, updates });
        },
      };
      const result = await fn(tx);
      // Commit phase — apply writes only after the user fn resolves.
      for (const w of writes) await w.ref.update(w.updates);
      return result;
    });
    txQueue = next.catch(() => undefined);
    return next;
  },
};

vi.mock('../../lib/firestore.js', () => ({
  getDb: () => fakeDb,
  collections: {
    cases: () => ({
      doc: (_id: string) => caseDocRef(),
    }),
    findings: () => {
      const query = {
        where: () => query,
        get: vi.fn(async () => ({ docs: [] })),
      };
      return query;
    },
    runs: () => {
      const query = {
        where: () => query,
        get: vi.fn(async () => ({ docs: [] })),
        doc: (id: string) => runDocRef(id),
      };
      return query;
    },
    decisions: () => ({
      doc: () => ({ set: vi.fn(async () => undefined) }),
    }),
    ruleSets: () => ({
      get: vi.fn(async () => ({
        docs: ruleSets.value.map((ruleSet) => ({ data: () => ruleSet })),
      })),
    }),
  },
}));

const emitMock = vi.fn();
vi.mock('../event/event-service.js', () => ({
  EventService: class {
    async emit(...args: unknown[]) {
      emitMock(...args);
    }
  },
}));

vi.mock('../case/case-repository.js', () => ({
  CaseRepository: class {
    async getById() {
      return store.case_;
    }
    async update(_id: string, updates: Partial<Case>) {
      store.case_ = { ...store.case_, ...updates };
      return store.case_;
    }
  },
}));

// Import after mocks are wired.
const { FirestorePipelineAdapter } = await import('./firestore-pipeline-adapter.js');

describe('FirestorePipelineAdapter.persistReviewNotApplicableHeal', () => {
  beforeEach(() => {
    store.case_ = makeCase();
    txQueue = Promise.resolve();
    emitMock.mockReset();
  });

  it('emits review_marked_not_applicable exactly once on a single call', async () => {
    const adapter = new FirestorePipelineAdapter();
    await adapter.persistReviewNotApplicableHeal('case_1');
    expect(store.case_.review_not_applicable).toBe(true);
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0]?.[1]).toBe('review_marked_not_applicable');
  });

  it('is a no-op when the flag is already set', async () => {
    store.case_ = makeCase({ review_not_applicable: true });
    const adapter = new FirestorePipelineAdapter();
    await adapter.persistReviewNotApplicableHeal('case_1');
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('emits exactly once under two concurrent heal calls', async () => {
    const adapter = new FirestorePipelineAdapter();
    await Promise.all([
      adapter.persistReviewNotApplicableHeal('case_1'),
      adapter.persistReviewNotApplicableHeal('case_1'),
    ]);
    expect(store.case_.review_not_applicable).toBe(true);
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  it('emits exactly once under five concurrent heal calls', async () => {
    const adapter = new FirestorePipelineAdapter();
    await Promise.all(
      Array.from({ length: 5 }, () => adapter.persistReviewNotApplicableHeal('case_1')),
    );
    expect(store.case_.review_not_applicable).toBe(true);
    expect(emitMock).toHaveBeenCalledTimes(1);
  });
});

describe('FirestorePipelineAdapter.createRun (run lease/heartbeat)', () => {
  beforeEach(() => {
    runStore.clear();
    delete process.env['ARBITRA_RUN_LEASE_TTL_MS'];
  });

  it('stamps lease_expires_at and a worker_id on the created run', async () => {
    const adapter = new FirestorePipelineAdapter();
    const before = Date.now();

    const run = await adapter.createRun('case_1', 'rule_run', 'system');

    expect(run.status).toBe('pending');
    expect(run.attempt).toBe(1);
    expect(run.worker_id).toBeTruthy();
    expect(run.lease_expires_at).toBeTruthy();

    // Default TTL is 5 minutes (ARBITRA_RUN_LEASE_TTL_MS default 300000).
    const leaseMs = new Date(run.lease_expires_at!).getTime() - before;
    expect(leaseMs).toBeGreaterThan(299_000);
    expect(leaseMs).toBeLessThan(310_000);

    // The persisted doc matches what was returned.
    const persisted = runStore.get(run.run_id);
    expect(persisted?.worker_id).toBe(run.worker_id);
    expect(persisted?.lease_expires_at).toBe(run.lease_expires_at);
  });

  it('stamps a different worker_id on each created run', async () => {
    const adapter = new FirestorePipelineAdapter();
    const runA = await adapter.createRun('case_1', 'rule_run', 'system');
    const runB = await adapter.createRun('case_1', 'rule_run', 'system');
    expect(runA.worker_id).not.toBe(runB.worker_id);
  });

  it('honors ARBITRA_RUN_LEASE_TTL_MS for the lease TTL', async () => {
    process.env['ARBITRA_RUN_LEASE_TTL_MS'] = '1000';
    // Adapter reads the env var at module load time (top-level `parseInt`),
    // so re-import the module fresh with the env var already set.
    vi.resetModules();
    const { FirestorePipelineAdapter: FreshAdapter } = await import('./firestore-pipeline-adapter.js');
    const adapter = new FreshAdapter();
    const before = Date.now();

    const run = await adapter.createRun('case_1', 'rule_run', 'system');

    const leaseMs = new Date(run.lease_expires_at!).getTime() - before;
    expect(leaseMs).toBeGreaterThan(0);
    expect(leaseMs).toBeLessThan(2000);
  });
});

describe('FirestorePipelineAdapter decision snapshots', () => {
  beforeEach(() => {
    store.case_ = makeCase({
      active_rule_set_refs: [],
      knowledge_context_refs: ['knowledge_a'],
    });
    ruleSets.value = [
      {
        rule_set_id: 'ruleset_a',
        name: 'Global rules',
        description: '',
        rule_refs: ['rule_a'],
        status: 'active',
        version: 2,
        created_at: '',
        updated_at: '',
      },
      {
        rule_set_id: 'ruleset_b',
        name: 'Project rules',
        description: '',
        project_id: 'p',
        rule_refs: ['rule_b'],
        status: 'active',
        version: 4,
        created_at: '',
        updated_at: '',
      },
    ];
  });

  it.each([
    ['auto-approve', (adapter: InstanceType<typeof FirestorePipelineAdapter>) =>
      adapter.createAutoApproveDecision('case_1')],
    ['merge-not-applicable', (adapter: InstanceType<typeof FirestorePipelineAdapter>) =>
      adapter.createMergeNotApplicableDecision('case_1')],
  ])('records an exact snapshot for %s decisions', async (_label, createDecision) => {
    const caseRepo = { getById: vi.fn(async () => store.case_) };
    const evaluator = {
      getEffectivePolicy: vi.fn(async () => ({
        rule: {
          required_evidence_types: [],
          optional_evidence_types: [],
          four_eyes_required: false,
          allow_self_approval: false,
        },
        policy_id: 'policy_1',
        version: 6,
      })),
    };
    const ruleRepository = {
      getActiveRulesForProject: vi.fn(async () => ([
        {
          rule_id: 'rule_a',
          name: 'Global rule',
          category: 'code_quality_rule',
          scope: { layer: 'global', ref: 'global' },
          evaluation_mode: 'metadata_check',
          severity_if_failed: 'medium',
          config: {},
          description: '',
          rationale: '',
          status: 'active',
          version: 1,
          created_at: '',
          updated_at: '',
        },
        {
          rule_id: 'rule_b',
          name: 'Project rule',
          category: 'test_rule',
          scope: { layer: 'project', ref: 'p' },
          evaluation_mode: 'metadata_check',
          severity_if_failed: 'medium',
          config: {},
          description: '',
          rationale: '',
          status: 'active',
          version: 1,
          created_at: '',
          updated_at: '',
        },
      ] satisfies Rule[])),
    };
    const adapter = new FirestorePipelineAdapter(
      caseRepo as never,
      {} as never,
      evaluator as never,
      ruleRepository as never,
    );

    const decision = await createDecision(adapter);

    expect(decision.snapshot).toEqual({
      active_rule_set_versions: { ruleset_a: 2, ruleset_b: 4 },
      evidence_policy_id: 'policy_1',
      evidence_policy_version: 6,
      knowledge_asset_refs: ['knowledge_a'],
      snapshot_fidelity: 'exact',
    });
  });
});

describe('FirestorePipelineAdapter.failRunIfStillStale (PR #742)', () => {
  beforeEach(() => {
    runStore.clear();
    txQueue = Promise.resolve();
  });

  it('fails the run when it is still pending/running and the staleness check passes', async () => {
    runStore.set('run_1', makeRun({ status: 'running' }));
    const adapter = new FirestorePipelineAdapter();

    const result = await adapter.failRunIfStillStale('run_1', 'case_1', 'stale', () => true);

    expect(result.failed).toBe(true);
    expect(result.run?.status).toBe('failed');
    expect(result.run?.error_message).toBe('stale');
    expect(runStore.get('run_1')?.status).toBe('failed');
    expect(runStore.get('run_1')?.lease_expires_at).toBeUndefined();
    expect(runStore.get('run_1')?.worker_id).toBeUndefined();
  });

  it('REAL race test: does not overwrite a run that completed between the sweep query and the fail call', async () => {
    // The sweep's QUERY snapshot said this run was `running` (and stale) —
    // but by the time the transactional fail call actually reads the doc,
    // the run has for-real completed (a live worker finished just in time,
    // e.g. a 30-min cohort-2 review that was genuinely still mid-flight).
    runStore.set(
      'run_1',
      makeRun({ status: 'completed', finished_at: '2026-01-01T00:05:00.000Z', summary: 'Reviewed — no findings' }),
    );
    const adapter = new FirestorePipelineAdapter();
    // Even a staleness predicate that would unconditionally say "yes, stale"
    // must not matter — the status guard short-circuits before it's consulted.
    const isStillStale = vi.fn(() => true);

    const result = await adapter.failRunIfStillStale('run_1', 'case_1', 'swept as stale', isStillStale);

    expect(result.failed).toBe(false);
    expect(result.run?.status).toBe('completed');
    expect(runStore.get('run_1')?.status).toBe('completed'); // NOT clobbered to failed
    expect(runStore.get('run_1')?.summary).toBe('Reviewed — no findings'); // untouched
    expect(isStillStale).not.toHaveBeenCalled();
  });

  it('does not overwrite a run whose lease was refreshed after the sweep query snapshot', async () => {
    // Fresh read shows a lease far in the future — the heartbeat won the race.
    runStore.set('run_1', makeRun({ status: 'running', lease_expires_at: '2026-01-01T01:00:00.000Z' }));
    const adapter = new FirestorePipelineAdapter();
    const isStillStale = (run: Run) => !!run.lease_expires_at && run.lease_expires_at < '2026-01-01T00:00:00.000Z';

    const result = await adapter.failRunIfStillStale('run_1', 'case_1', 'swept as stale', isStillStale);

    expect(result.failed).toBe(false);
    expect(runStore.get('run_1')?.status).toBe('running');
  });

  it('returns failed:false with a null run when the doc no longer exists', async () => {
    const adapter = new FirestorePipelineAdapter();
    const result = await adapter.failRunIfStillStale('missing_run', 'case_1', 'stale', () => true);
    expect(result.failed).toBe(false);
    expect(result.run).toBeNull();
  });

  it('only one of two concurrent calls wins when both race the same still-stale run', async () => {
    runStore.set('run_1', makeRun({ status: 'running' }));
    const adapter = new FirestorePipelineAdapter();

    const [a, b] = await Promise.all([
      adapter.failRunIfStillStale('run_1', 'case_1', 'stale-a', () => true),
      adapter.failRunIfStillStale('run_1', 'case_1', 'stale-b', () => true),
    ]);

    const wins = [a, b].filter((r) => r.failed);
    expect(wins).toHaveLength(1);
    expect(runStore.get('run_1')?.status).toBe('failed');
  });
});

describe('FirestorePipelineAdapter durable retry backstop — scheduleRunRetry / claimRunRetryDispatch (PR #742)', () => {
  beforeEach(() => {
    runStore.clear();
    txQueue = Promise.resolve();
  });

  it('scheduleRunRetry persists retry_at on the run doc', async () => {
    runStore.set('run_1', makeRun({ status: 'failed', error_message: 'transient', attempt: 1 }));
    const adapter = new FirestorePipelineAdapter();

    await adapter.scheduleRunRetry('run_1', '2026-01-01T00:10:00.000Z');

    expect(runStore.get('run_1')?.retry_at).toBe('2026-01-01T00:10:00.000Z');
  });

  it('claimRunRetryDispatch claims once and returns null on a second claim', async () => {
    runStore.set('run_1', makeRun({ status: 'failed', retry_at: '2026-01-01T00:10:00.000Z', attempt: 1 }));
    const adapter = new FirestorePipelineAdapter();

    const first = await adapter.claimRunRetryDispatch('run_1');
    expect(first?.retry_dispatched).toBe(true);
    expect(runStore.get('run_1')?.retry_dispatched).toBe(true);

    const second = await adapter.claimRunRetryDispatch('run_1');
    expect(second).toBeNull();
  });

  it('double-dispatch guard: exactly one of two concurrent claims wins', async () => {
    runStore.set('run_1', makeRun({ status: 'failed', retry_at: '2026-01-01T00:10:00.000Z', attempt: 1 }));
    const adapter = new FirestorePipelineAdapter();

    const [a, b] = await Promise.all([
      adapter.claimRunRetryDispatch('run_1'),
      adapter.claimRunRetryDispatch('run_1'),
    ]);

    const claims = [a, b].filter((r) => r !== null);
    expect(claims).toHaveLength(1);
  });

  it('returns null when the run is no longer failed (already completed by some other path)', async () => {
    runStore.set('run_1', makeRun({ status: 'completed', retry_at: '2026-01-01T00:10:00.000Z' }));
    const adapter = new FirestorePipelineAdapter();
    const result = await adapter.claimRunRetryDispatch('run_1');
    expect(result).toBeNull();
  });

  it('returns null when the run doc no longer exists', async () => {
    const adapter = new FirestorePipelineAdapter();
    const result = await adapter.claimRunRetryDispatch('missing_run');
    expect(result).toBeNull();
  });

  it('Case cancellation fence: claimRunRetryDispatch cannot dispatch a failed assistant attempt', async () => {
    store.case_ = makeCase({
      case_type: 'assistant_task',
      status: 'in_build',
      assistant_cancel_intent: {
        revision: 1,
        requested_at: '2026-01-01T00:05:00.000Z',
        requested_by: 'u',
      },
    });
    runStore.set('run_1', makeRun({
      run_type: 'assistant_task_run',
      status: 'failed',
      retry_at: '2026-01-01T00:10:00.000Z',
      attempt: 1,
    }));
    const adapter = new FirestorePipelineAdapter();

    const result = await adapter.claimRunRetryDispatch('run_1');

    // Removing `case_.assistant_cancel_intent !== undefined` from
    // `claimRunRetryDispatch` flips `retry_dispatched` after the Case was rejected.
    expect(result).toBeNull();
    expect(runStore.get('run_1')?.retry_dispatched).toBeUndefined();
  });
});
