import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case, Run } from '@arbitra/shared';
import type { RunCompletionHandler } from './pipeline.js';
import type { RunSweepAdapter } from './run-sweep-service.js';

// ---------------------------------------------------------------------------
// In-memory Firestore double for the `runs` collection queries `findStaleRuns`
// / `findOverdueRetries` issue, plus a transaction-capable fake db for
// `run-sweep-lock.ts`'s single-flight lock.
// ---------------------------------------------------------------------------

let runRows: Run[] = [];

interface Filter {
  field: string;
  op: string;
  value: unknown;
}

function applyFilter(row: Record<string, unknown>, f: Filter): boolean {
  switch (f.op) {
    case '==':
      return row[f.field] === f.value;
    case 'in':
      return Array.isArray(f.value) && (f.value as unknown[]).includes(row[f.field]);
    case '<':
      // ISO timestamp strings compare correctly lexicographically.
      return typeof row[f.field] === 'string' && (row[f.field] as string) < (f.value as string);
    case '<=':
      return typeof row[f.field] === 'string' && (row[f.field] as string) <= (f.value as string);
    default:
      throw new Error(`Unsupported op in test double: ${f.op}`);
  }
}

function runsQuery(filters: Filter[] = []) {
  return {
    where: (field: string, op: string, value: unknown) => runsQuery([...filters, { field, op, value }]),
    get: async () => {
      const rows = runRows.filter((r) => filters.every((f) => applyFilter(r as unknown as Record<string, unknown>, f)));
      return { docs: rows.map((r) => ({ data: () => r })) };
    },
  };
}

// Serialize transactions (FIFO) to mirror Firestore's commit ordering for a
// single contended lock document — same technique as pipeline.test.ts.
const lockStore = new Map<string, unknown>();
let txQueue: Promise<unknown> = Promise.resolve();

interface FakeRef {
  __path: string;
}
interface FakeTx {
  get(ref: FakeRef): Promise<{ exists: boolean; data: () => unknown }>;
  set(ref: FakeRef, data: unknown): void;
  delete(ref: FakeRef): void;
}

const fakeDb = {
  collection: (name: string) => ({
    doc: (id: string): FakeRef => ({ __path: `${name}/${id}` }),
  }),
  runTransaction: <T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> => {
    const tx: FakeTx = {
      get: async (ref) => {
        const data = lockStore.get(ref.__path);
        return { exists: data !== undefined, data: () => data };
      },
      set: (ref, data) => {
        lockStore.set(ref.__path, data);
      },
      delete: (ref) => {
        lockStore.delete(ref.__path);
      },
    };
    const run = txQueue.then(() => fn(tx));
    txQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  },
};

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    runs: () => runsQuery(),
  },
  getDb: () => fakeDb,
}));

const { RunSweepService } = await import('./run-sweep-service.js');
const { RunCompletionHandler: RealRunCompletionHandler } = await import('./pipeline.js');

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
    title: 'Completed Case',
    description: 'Already finished before its worker lease expired.',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'usr_owner',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    status: 'done',
    decision_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:45:00.000Z',
    ...overrides,
  } as Case;
}

/**
 * Realistic in-memory `failRunIfStillStale`: reads the CURRENT `runRows`
 * entry (not whatever `findStaleRuns` saw earlier) and only "fails" it if
 * still pending/running AND `isStillStale` accepts it — same contract as
 * the real Firestore-transactional implementation (tested end-to-end in
 * `firestore-pipeline-adapter.test.ts`). Lets most tests just work, while
 * the dedicated race test below overrides this per-call to
 * represent "the fresh read at fail-time disagrees with the query snapshot."
 */
function realisticFailRunIfStillStale(
  runId: string,
  _caseId: string,
  error: string,
  isStillStale: (run: Run) => boolean,
): Promise<{ failed: boolean; run: Run | null }> {
  const idx = runRows.findIndex((r) => r.run_id === runId);
  if (idx === -1) return Promise.resolve({ failed: false, run: null });
  const run = runRows[idx]!;
  if (run.status !== 'pending' && run.status !== 'running') {
    return Promise.resolve({ failed: false, run });
  }
  if (!isStillStale(run)) {
    return Promise.resolve({ failed: false, run });
  }
  const updated: Run = { ...run, status: 'failed', error_message: error };
  runRows[idx] = updated;
  return Promise.resolve({ failed: true, run: updated });
}

function makeAdapter(): RunSweepAdapter & {
  failRun: ReturnType<typeof vi.fn>;
  failRunIfStillStale: ReturnType<typeof vi.fn>;
  emitEvent: ReturnType<typeof vi.fn>;
  scheduleRunRetry: ReturnType<typeof vi.fn>;
  claimRunRetryDispatch: ReturnType<typeof vi.fn>;
} {
  return {
    getCase: vi.fn(),
    updateCaseStatus: vi.fn(),
    updateCase: vi.fn(),
    loadPreconditionContext: vi.fn(),
    createRun: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(async (runId: string, caseId: string) =>
      makeRun({ run_id: runId, case_id: caseId, status: 'failed', error_message: 'swept' }),
    ),
    failRunIfStillStale: vi.fn(realisticFailRunIfStillStale),
    emitEvent: vi.fn(async () => {}),
    getActiveRuns: vi.fn(async () => []),
    createAutoApproveDecision: vi.fn(),
    closeOutstandingWaiverProposals: vi.fn(async () => ({ closed: 0 })),
    createMergeNotApplicableDecision: vi.fn(),
    getProjectLifecycleProfile: vi.fn(),
    scheduleRunRetry: vi.fn(async () => {}),
    claimRunRetryDispatch: vi.fn(async () => null),
  };
}

function makePipeline(): RunCompletionHandler & {
  handleRunFailure: ReturnType<typeof vi.fn>;
  onRunCompleted: ReturnType<typeof vi.fn>;
  dispatchScheduledRetry: ReturnType<typeof vi.fn>;
} {
  return {
    handleRunFailure: vi.fn(async () => {}),
    onRunCompleted: vi.fn(async () => ({})),
    dispatchScheduledRetry: vi.fn(async () => 'dispatched' as const),
  } as unknown as RunCompletionHandler & {
    handleRunFailure: ReturnType<typeof vi.fn>;
    onRunCompleted: ReturnType<typeof vi.fn>;
    dispatchScheduledRetry: ReturnType<typeof vi.fn>;
  };
}

const NOW = new Date('2026-01-01T01:00:00.000Z');

describe('RunSweepService.findStaleRuns — selection logic', () => {
  beforeEach(() => {
    runRows = [];
  });

  it('selects a running run whose lease has expired', async () => {
    runRows = [
      makeRun({ run_id: 'stale_1', lease_expires_at: '2026-01-01T00:30:00.000Z' }),
    ];
    const service = new RunSweepService(makeAdapter(), makePipeline());
    const stale = await service.findStaleRuns(NOW);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.run.run_id).toBe('stale_1');
    expect(stale[0]!.reason).toBe('lease_expired');
  });

  it('leaves a run with a fresh (not-yet-expired) lease untouched', async () => {
    runRows = [
      makeRun({ run_id: 'fresh_1', lease_expires_at: '2026-01-01T02:00:00.000Z' }),
    ];
    const service = new RunSweepService(makeAdapter(), makePipeline());
    const stale = await service.findStaleRuns(NOW);
    expect(stale).toHaveLength(0);
  });

  it('applies the legacy no-lease policy: stale once older than the max age', async () => {
    runRows = [
      // No lease_expires_at at all, started 40 minutes before `now` — older
      // than the default 30-minute legacy max age.
      makeRun({ run_id: 'legacy_stale', started_at: '2026-01-01T00:20:00.000Z' }),
    ];
    const service = new RunSweepService(makeAdapter(), makePipeline());
    const stale = await service.findStaleRuns(NOW);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.run.run_id).toBe('legacy_stale');
    expect(stale[0]!.reason).toBe('legacy_no_lease_stale');
  });

  it('leaves a recent no-lease run untouched (within the legacy max age)', async () => {
    runRows = [
      makeRun({ run_id: 'legacy_fresh', started_at: '2026-01-01T00:55:00.000Z' }),
    ];
    const service = new RunSweepService(makeAdapter(), makePipeline());
    const stale = await service.findStaleRuns(NOW);
    expect(stale).toHaveLength(0);
  });

  it('ignores completed/failed/cancelled runs entirely', async () => {
    runRows = [
      makeRun({ run_id: 'done_1', status: 'completed', lease_expires_at: '2020-01-01T00:00:00.000Z' }),
      makeRun({ run_id: 'failed_1', status: 'failed', started_at: '2020-01-01T00:00:00.000Z' }),
    ];
    const service = new RunSweepService(makeAdapter(), makePipeline());
    const stale = await service.findStaleRuns(NOW);
    expect(stale).toHaveLength(0);
  });

  it('does not double-count a lease-expired run in the legacy pass', async () => {
    runRows = [
      makeRun({ run_id: 'stale_1', lease_expires_at: '2026-01-01T00:30:00.000Z', started_at: '2020-01-01T00:00:00.000Z' }),
    ];
    const service = new RunSweepService(makeAdapter(), makePipeline());
    const stale = await service.findStaleRuns(NOW);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.reason).toBe('lease_expired');
  });
});

describe('RunSweepService.findOverdueRetries — durable-retry backstop (PR #742)', () => {
  beforeEach(() => {
    runRows = [];
  });

  it('selects a failed run with an overdue retry_at that has not been dispatched', async () => {
    runRows = [
      makeRun({ run_id: 'retry_1', status: 'failed', retry_at: '2026-01-01T00:59:00.000Z' }),
    ];
    const service = new RunSweepService(makeAdapter(), makePipeline());
    const overdue = await service.findOverdueRetries(NOW);
    expect(overdue.map((r) => r.run_id)).toEqual(['retry_1']);
  });

  it('ignores a retry that is not yet due', async () => {
    runRows = [
      makeRun({ run_id: 'retry_future', status: 'failed', retry_at: '2026-01-01T02:00:00.000Z' }),
    ];
    const service = new RunSweepService(makeAdapter(), makePipeline());
    const overdue = await service.findOverdueRetries(NOW);
    expect(overdue).toHaveLength(0);
  });

  it('ignores a retry that has already been dispatched', async () => {
    runRows = [
      makeRun({ run_id: 'retry_done', status: 'failed', retry_at: '2026-01-01T00:59:00.000Z', retry_dispatched: true }),
    ];
    const service = new RunSweepService(makeAdapter(), makePipeline());
    const overdue = await service.findOverdueRetries(NOW);
    expect(overdue).toHaveLength(0);
  });

  it('ignores runs without a retry_at at all', async () => {
    runRows = [makeRun({ run_id: 'no_retry', status: 'failed' })];
    const service = new RunSweepService(makeAdapter(), makePipeline());
    const overdue = await service.findOverdueRetries(NOW);
    expect(overdue).toHaveLength(0);
  });
});

describe('RunSweepService.sweep — end-to-end selection + side effects', () => {
  beforeEach(() => {
    runRows = [];
    lockStore.clear();
    txQueue = Promise.resolve();
  });

  it('fails a stale run, emits run_failed, and re-evaluates the pipeline', async () => {
    runRows = [makeRun({ run_id: 'stale_1', case_id: 'case_1', lease_expires_at: '2026-01-01T00:30:00.000Z' })];
    const adapter = makeAdapter();
    const pipeline = makePipeline();
    const service = new RunSweepService(adapter, pipeline);

    const result = await service.sweep(NOW);

    expect(result.skipped_locked).toBe(false);
    expect(result.skipped_completed).toBe(0);
    expect(result.swept).toEqual([
      { run_id: 'stale_1', case_id: 'case_1', run_type: 'review_run', reason: 'lease_expired' },
    ]);
    expect(adapter.failRunIfStillStale).toHaveBeenCalledWith('stale_1', 'case_1', expect.any(String), expect.any(Function));
    expect(adapter.emitEvent).toHaveBeenCalledWith(
      'case_1',
      'run_failed',
      expect.objectContaining({ run_id: 'stale_1', swept: true, sweep_reason: 'lease_expired' }),
      'system:run-sweeper',
    );
    expect(pipeline.handleRunFailure).toHaveBeenCalledTimes(1);
    expect(pipeline.onRunCompleted).toHaveBeenCalledWith('case_1');
  });

  it('REAL terminal guard: fails stale bookkeeping but creates no retry on a completed Case', async () => {
    runRows = [makeRun({
      run_id: 'stale_terminal',
      case_id: 'case_1',
      lease_expires_at: '2026-01-01T00:30:00.000Z',
    })];
    const adapter = makeAdapter();
    adapter.getCase = vi.fn(async () => makeCase({ status: 'done' }));
    const pipeline = new RealRunCompletionHandler(adapter);
    const service = new RunSweepService(adapter, pipeline);

    const result = await service.sweep(NOW);

    // Removing handleRunFailure's terminal guard leaves the first three
    // bookkeeping assertions green but makes scheduleRunRetry fire here — the
    // exact production blast-radius defect from #760.
    expect(result.swept).toEqual([
      {
        run_id: 'stale_terminal',
        case_id: 'case_1',
        run_type: 'review_run',
        reason: 'lease_expired',
      },
    ]);
    expect(runRows[0]).toMatchObject({ status: 'failed' });
    expect(adapter.emitEvent).toHaveBeenCalledWith(
      'case_1',
      'run_failed',
      expect.objectContaining({ run_id: 'stale_terminal', swept: true }),
      'system:run-sweeper',
    );
    expect(adapter.scheduleRunRetry).not.toHaveBeenCalled();
  });

  it('does not touch a fresh-lease run', async () => {
    runRows = [makeRun({ run_id: 'fresh_1', lease_expires_at: '2026-01-01T02:00:00.000Z' })];
    const adapter = makeAdapter();
    const pipeline = makePipeline();
    const service = new RunSweepService(adapter, pipeline);

    const result = await service.sweep(NOW);

    expect(result.swept).toHaveLength(0);
    expect(adapter.failRunIfStillStale).not.toHaveBeenCalled();
    expect(pipeline.handleRunFailure).not.toHaveBeenCalled();
  });

  it('REAL test (PR #742): a run that completes between the sweep query and the fail call is NOT overwritten, and no retry is dispatched for it', async () => {
    // Query snapshot: run LOOKS lease-expired (stale).
    runRows = [
      makeRun({
        run_id: 'race_1',
        case_id: 'case_1',
        status: 'running',
        lease_expires_at: '2026-01-01T00:30:00.000Z',
        summary: undefined,
      }),
    ];
    const adapter = makeAdapter();
    // But by the time the transactional fail call actually re-reads the doc
    // (real behavior verified against an actual Firestore-transaction double
    // in `firestore-pipeline-adapter.test.ts`), the run genuinely completed —
    // a live worker finished just in time. Override the realistic default to
    // represent exactly that fresh-read outcome.
    adapter.failRunIfStillStale.mockImplementationOnce(async () => ({
      failed: false,
      run: { ...runRows[0]!, status: 'completed', finished_at: '2026-01-01T00:45:00.000Z', summary: 'Reviewed — no findings' },
    }));
    const pipeline = makePipeline();
    const service = new RunSweepService(adapter, pipeline);

    const result = await service.sweep(NOW);

    // Not counted as swept — and NOT clobbered.
    expect(result.swept).toHaveLength(0);
    expect(result.skipped_completed).toBe(1);
    // No run_failed event, no retry decision, no pipeline re-evaluation for
    // a run that resolved on its own — the sweep must leave it alone.
    expect(adapter.emitEvent).not.toHaveBeenCalled();
    expect(pipeline.handleRunFailure).not.toHaveBeenCalled();
    expect(pipeline.onRunCompleted).not.toHaveBeenCalled();
  });

  it('single-flight: a second concurrent sweep no-ops while the first holds the lock', async () => {
    runRows = [makeRun({ run_id: 'stale_1', lease_expires_at: '2026-01-01T00:30:00.000Z' })];
    const adapter = makeAdapter();
    const pipeline = makePipeline();

    // Acquire the lock out-of-band to simulate an in-flight sweep holding it.
    const { acquireRunSweepLock } = await import('./run-sweep-lock.js');
    const holderLock = await acquireRunSweepLock(NOW);

    const service = new RunSweepService(adapter, pipeline);
    const result = await service.sweep(NOW);

    expect(result.skipped_locked).toBe(true);
    expect(result.swept).toHaveLength(0);
    expect(adapter.failRunIfStillStale).not.toHaveBeenCalled();

    await holderLock.release();
  });

  it('a second sweep after the first releases the lock proceeds normally', async () => {
    runRows = [makeRun({ run_id: 'stale_1', lease_expires_at: '2026-01-01T00:30:00.000Z' })];
    const adapter = makeAdapter();
    const pipeline = makePipeline();
    const service = new RunSweepService(adapter, pipeline);

    const first = await service.sweep(NOW);
    expect(first.swept).toHaveLength(1);
    // The realistic fake adapter DID flip the run to 'failed' in `runRows`,
    // so a fresh sweep correctly finds nothing left to sweep.
    expect(runRows.find((r) => r.run_id === 'stale_1')?.status).toBe('failed');

    const second = await service.sweep(NOW);
    expect(second.skipped_locked).toBe(false);
    expect(second.swept).toHaveLength(0);
  });

  it('lost-timer scenario : dispatches an overdue persisted retry the in-process timer never fired', async () => {
    runRows = [
      makeRun({
        run_id: 'retry_1',
        case_id: 'case_2',
        run_type: 'review_run',
        status: 'failed',
        attempt: 1,
        retry_at: '2026-01-01T00:59:00.000Z',
      }),
    ];
    const adapter = makeAdapter();
    const pipeline = makePipeline();
    const service = new RunSweepService(adapter, pipeline);

    const result = await service.sweep(NOW);

    expect(pipeline.dispatchScheduledRetry).toHaveBeenCalledTimes(1);
    expect(pipeline.dispatchScheduledRetry).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 'retry_1', case_id: 'case_2' }),
    );
    expect(result.retries_dispatched).toEqual([
      { run_id: 'retry_1', case_id: 'case_2', run_type: 'review_run' },
    ]);
  });

  it('does not count a retry in retries_dispatched when dispatchScheduledRetry reports already_claimed (double-dispatch guard)', async () => {
    runRows = [
      makeRun({ run_id: 'retry_1', case_id: 'case_2', status: 'failed', retry_at: '2026-01-01T00:59:00.000Z' }),
    ];
    const adapter = makeAdapter();
    const pipeline = makePipeline();
    pipeline.dispatchScheduledRetry = vi.fn(async () => 'already_claimed' as const);
    const service = new RunSweepService(adapter, pipeline);

    const result = await service.sweep(NOW);

    expect(pipeline.dispatchScheduledRetry).toHaveBeenCalledTimes(1);
    expect(result.retries_dispatched).toHaveLength(0);
  });
});
