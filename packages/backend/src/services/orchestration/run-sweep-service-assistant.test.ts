import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case, CaseEvent, CaseStatus, EventType, Run } from '@arbitra/shared';
import { NotFoundError } from '@arbitra/shared';
import type { RunCompletionHandler } from './pipeline.js';
import type { RunExecutor } from './run-executor.js';
import type { PipelineAdapter, RunClaimResult } from './pipeline-adapter.js';
import type { AssistantHoldWrite } from './assistant-hold-writer.js';
import type { PreconditionContext } from './preconditions.js';
import type { RunSweepAdapter } from './run-sweep-service.js';
import { CASE_PIPELINE_LOCKS_COLLECTION, casePipelineLockDocId } from './case-pipeline-lock.js';

/**
 * Assistant sub-sweep: recovery of unclaimed assistant runs and of expired
 * assistant leases, plus the two properties that must NOT change — the main
 * stale-run sweep leaves assistant runs alone, and its legacy no-lease cohort
 * behaves exactly as before for every other run type.
 */

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
      return typeof row[f.field] === 'string' && (row[f.field] as string) < (f.value as string);
    case '<=':
      return typeof row[f.field] === 'string' && (row[f.field] as string) <= (f.value as string);
    case '>=':
      return typeof row[f.field] === 'string' && (row[f.field] as string) >= (f.value as string);
    default:
      throw new Error(`Unsupported op in test double: ${f.op}`);
  }
}

interface Ordering {
  field: string;
  direction: 'asc' | 'desc';
}

function runsQuery(filters: Filter[] = [], ordering?: Ordering) {
  const matchingRows = () => runRows
    .filter((r) => filters.every((f) => applyFilter(r as unknown as Record<string, unknown>, f)))
    .sort((left, right) => {
      if (!ordering) return 0;
      const leftValue = String((left as unknown as Record<string, unknown>)[ordering.field]);
      const rightValue = String((right as unknown as Record<string, unknown>)[ordering.field]);
      return leftValue.localeCompare(rightValue) * (ordering.direction === 'desc' ? -1 : 1);
    });
  return {
    where: (field: string, op: string, value: unknown) =>
      runsQuery([...filters, { field, op, value }], ordering),
    orderBy: (field: string, direction: 'asc' | 'desc') =>
      runsQuery(filters, { field, direction }),
    limit: (count: number) => ({
      get: async () => {
        const rows = matchingRows().slice(0, count);
        return { docs: rows.map((r) => ({ data: () => r })) };
      },
    }),
    get: async () => {
      const rows = matchingRows();
      return { docs: rows.map((r) => ({ data: () => r })) };
    },
  };
}

// Serialized transactions over a lock store keyed by `collection/doc`, so the
// two sweeps' DIFFERENT lock doc ids are genuinely independent documents.
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
    // Reached by the completeness evaluator when the REAL `RunCompletionHandler`
    // evaluates preconditions (see `makeRealPipeline`).
    evidencePolicies: () => ({
      where: () => ({ get: async () => ({ empty: true, docs: [] }) }),
    }),
  },
  getDb: () => fakeDb,
}));

// The real `RunCompletionHandler` constructs both in its constructor.
vi.mock('../notification/notification-dispatcher.js', () => ({
  NotificationDispatcher: class {
    dispatch = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('../notification/notification-service.js', () => ({
  NotificationService: class {
    notify = vi.fn().mockResolvedValue(undefined);
  },
}));

const { RunSweepService } = await import('./run-sweep-service.js');
const { RunCompletionHandler: RealRunCompletionHandler } = await import('./pipeline.js');
const { RUN_SWEEP_LOCK_DOC_ID, ASSISTANT_SWEEP_LOCK_DOC_ID, acquireRunSweepLock } = await import(
  './run-sweep-lock.js'
);

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

/** An unclaimed assistant run as `createUnclaimedRun` writes it. */
function makeUnclaimedAssistantRun(overrides: Partial<Run> = {}): Run {
  return makeRun({
    run_id: 'run_a1',
    case_id: 'case_a',
    run_type: 'assistant_task_run',
    status: 'pending',
    awaiting_claim: true,
    attempt: 1,
    ...overrides,
  });
}

/** See the identically-named helper in `run-sweep-service.test.ts`. */
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

/**
 * Mirrors `FirestorePipelineAdapter.claimRun`'s predicate against `runRows`:
 * pending AND no lease holder, else refuse. Keeps the sub-sweep tests honest
 * about which runs are actually claimable (the transactional guarantees
 * themselves are covered in `firestore-pipeline-adapter-claim.test.ts`).
 */
function realisticClaimRun(runId: string, workerId: string): Promise<RunClaimResult> {
  const idx = runRows.findIndex((r) => r.run_id === runId);
  if (idx === -1) return Promise.resolve({ claimed: false, run: null });
  const run = runRows[idx]!;
  if (run.status !== 'pending' || run.lease_expires_at || run.worker_id) {
    return Promise.resolve({ claimed: false, run });
  }
  const claimed: Run = {
    ...run,
    status: 'running',
    started_at: '2026-01-01T01:00:00.000Z',
    lease_expires_at: '2026-01-01T01:05:00.000Z',
    worker_id: workerId,
  };
  delete claimed.awaiting_claim;
  runRows[idx] = claimed;
  return Promise.resolve({ claimed: true, run: claimed });
}

function realisticCancelUnclaimedAssistantReattempt(
  runId: string,
  reason: string,
): Promise<{ cancelled: boolean; run: Run | null }> {
  const idx = runRows.findIndex((r) => r.run_id === runId);
  if (idx === -1) return Promise.resolve({ cancelled: false, run: null });
  const run = runRows[idx]!;
  if (
    run.status !== 'pending'
    || run.awaiting_claim !== true
    || run.lease_expires_at
    || run.worker_id
  ) {
    return Promise.resolve({ cancelled: false, run });
  }
  const cancelled: Run = {
    ...run,
    status: 'cancelled',
    summary: reason,
    finished_at: '2026-01-01T01:00:00.000Z',
    updated_at: '2026-01-01T01:00:00.000Z',
  };
  delete cancelled.awaiting_claim;
  runRows[idx] = cancelled;
  return Promise.resolve({ cancelled: true, run: cancelled });
}

function makeAdapter(): RunSweepAdapter & {
  cancelUnclaimedAssistantReattempt: ReturnType<typeof vi.fn>;
  failRunIfStillStale: ReturnType<typeof vi.fn>;
  emitEvent: ReturnType<typeof vi.fn>;
  claimRun: ReturnType<typeof vi.fn>;
  createUnclaimedRun: ReturnType<typeof vi.fn>;
  prepareAssistantReattempt: ReturnType<typeof vi.fn>;
  getCase: ReturnType<typeof vi.fn>;
} {
  let created = 0;
  const createUnclaimedRun = vi.fn(
    async (caseId: string, runType: Run['run_type'], triggerSource: string, attempt = 1) => {
      created++;
      const run = makeRun({
        run_id: `run_new_${created}`,
        case_id: caseId,
        run_type: runType,
        trigger_source: triggerSource,
        status: 'pending',
        awaiting_claim: true,
        attempt,
        created_at: '2026-01-01T01:00:00.000Z',
      });
      runRows.push(run);
      return run;
    },
  );
  return {
    getCase: vi.fn(async (caseId: string) => ({ case_id: caseId, case_type: 'assistant_task' })),
    updateCaseStatus: vi.fn(),
    updateCase: vi.fn(),
    loadPreconditionContext: vi.fn(),
    createRun: vi.fn(),
    createUnclaimedRun,
    prepareAssistantReattempt: vi.fn((caseId, runType, triggerSource, attempt) =>
      createUnclaimedRun(caseId, runType, triggerSource, attempt)),
    cancelUnclaimedAssistantReattempt: vi.fn(realisticCancelUnclaimedAssistantReattempt),
    claimRun: vi.fn(realisticClaimRun),
    completeRun: vi.fn(),
    failRun: vi.fn(),
    failRunIfStillStale: vi.fn(realisticFailRunIfStillStale),
    emitEvent: vi.fn(async () => {}),
    getActiveRuns: vi.fn(async () => []),
    createAutoApproveDecision: vi.fn(),
    closeOutstandingWaiverProposals: vi.fn(async () => ({ closed: 0 })),
    createMergeNotApplicableDecision: vi.fn(),
    getProjectLifecycleProfile: vi.fn(),
    scheduleRunRetry: vi.fn(async () => {}),
    claimRunRetryDispatch: vi.fn(async () => null),
  } as unknown as RunSweepAdapter & {
    cancelUnclaimedAssistantReattempt: ReturnType<typeof vi.fn>;
    failRunIfStillStale: ReturnType<typeof vi.fn>;
    emitEvent: ReturnType<typeof vi.fn>;
    claimRun: ReturnType<typeof vi.fn>;
    createUnclaimedRun: ReturnType<typeof vi.fn>;
    prepareAssistantReattempt: ReturnType<typeof vi.fn>;
    getCase: ReturnType<typeof vi.fn>;
  };
}

function makePipeline(): RunCompletionHandler & {
  handleRunFailure: ReturnType<typeof vi.fn>;
  onRunCompleted: ReturnType<typeof vi.fn>;
  dispatchScheduledRetry: ReturnType<typeof vi.fn>;
  documentAssistantTerminalFailure: ReturnType<typeof vi.fn>;
  settleAssistantFailureRepair: ReturnType<typeof vi.fn>;
} {
  return {
    handleRunFailure: vi.fn(async () => {}),
    onRunCompleted: vi.fn(async () => ({})),
    dispatchScheduledRetry: vi.fn(async () => 'dispatched' as const),
    documentAssistantTerminalFailure: vi.fn(async () => 'documented' as const),
    settleAssistantFailureRepair: vi.fn(async () => true),
  } as unknown as RunCompletionHandler & {
    handleRunFailure: ReturnType<typeof vi.fn>;
    onRunCompleted: ReturnType<typeof vi.fn>;
    dispatchScheduledRetry: ReturnType<typeof vi.fn>;
    documentAssistantTerminalFailure: ReturnType<typeof vi.fn>;
    settleAssistantFailureRepair: ReturnType<typeof vi.fn>;
  };
}

function makeExecutor(): RunExecutor & { dispatch: ReturnType<typeof vi.fn> } {
  return { dispatch: vi.fn() } as unknown as RunExecutor & { dispatch: ReturnType<typeof vi.fn> };
}

const NOW = new Date('2026-01-01T01:00:00.000Z');

function makeAssistantCaseDoc(status: CaseStatus): Case {
  return {
    case_id: 'case_a',
    title: 'Summarise the audit findings',
    description: 'Summarise the audit findings',
    source_type: 'google_chat',
    source_ref: 'spaces/one/messages/two',
    project_id: 'proj_clerk',
    repository_id: 'repo_clerk',
    owner_user_id: 'usr_requester',
    status,
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    case_type: 'assistant_task',
    assistant_context: {
      channel: 'google_chat',
      conversation_visibility: 'direct',
      requester_user_id: 'usr_requester',
      risk_level: 'low',
      policy_version: 'assistant-policy:v1',
      prompt_version: 'assistant-system:v1',
    },
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

type RealRepairAdapter = RunSweepAdapter & {
  getCase: ReturnType<typeof vi.fn>;
  documentAssistantHold: ReturnType<typeof vi.fn>;
};

/**
 * The sweep wired to the REAL `RunCompletionHandler` over one in-memory case,
 * sharing `runRows` with the query double so SELECTION and EFFECT are exercised
 * as a single composition.
 *
 * Asserting call counts against a stubbed repair cannot see whether the backstop
 * actually unwedges anything — the seam-stubbing pattern that let #768 ship with
 * a green suite. These tests assert the resulting case status and the marker.
 */
function makeRealRepairHarness(initialCase: Case) {
  const adapter = makeAdapter() as unknown as RealRepairAdapter;
  let case_ = { ...initialCase };
  const events: CaseEvent[] = [];
  let eventSeq = 0;

  function nextTimestamp(): string {
    eventSeq += 1;
    return new Date(Date.parse('2026-01-01T01:00:00.000Z') + eventSeq * 1000).toISOString();
  }

  function recordEvent(
    caseId: string,
    type: EventType,
    payload: Record<string, unknown>,
    actorId: string,
  ): void {
    events.push({
      event_id: `evt_${events.length + 1}`,
      case_id: caseId,
      type,
      actor_id: actorId,
      payload,
      created_at: nextTimestamp(),
    });
  }

  function patchRun(runId: string, updates: Partial<Run>): void {
    const index = runRows.findIndex((run) => run.run_id === runId);
    if (index !== -1) runRows[index] = { ...runRows[index]!, ...updates };
  }

  Object.assign(adapter, {
    getCase: vi.fn(async () => case_),
    updateCase: vi.fn(async (_caseId: string, updates: Partial<Case>) => {
      case_ = { ...case_, ...updates };
      return case_;
    }),
    updateCaseStatus: vi.fn(async (_caseId: string, status: CaseStatus) => {
      case_ = { ...case_, status };
      return case_;
    }),
    loadPreconditionContext: vi.fn(
      async (): Promise<PreconditionContext> => ({
        case_,
        runs: [...runRows],
        findings: [],
        ruleResults: [],
        evidence: [],
        decisions: [],
        events: [...events],
        actorId: 'system',
      }),
    ),
    emitEvent: vi.fn(recordEvent),
    documentAssistantHold: vi.fn(
      async (
        caseId: string,
        hold: AssistantHoldWrite,
        event: { type: EventType; payload: Record<string, unknown> },
        actorId: string,
      ) => {
        case_ = {
          ...case_,
          assistant_context: {
            ...case_.assistant_context!,
            wait_reason: hold.wait_reason,
            wait_run_id: hold.run_id,
            wait_attempt: hold.attempt,
          },
        };
        recordEvent(caseId, event.type, event.payload, actorId);
      },
    ),
    markAssistantFailureRepairPending: vi.fn(async (runId: string) => {
      patchRun(runId, { assistant_failure_repair_pending: true });
    }),
    clearAssistantFailureRepairPending: vi.fn(async (runId: string) => {
      patchRun(runId, {
        assistant_failure_repair_pending: undefined,
        assistant_failure_repair_settled_at: '2026-01-01T01:00:00.000Z',
      });
    }),
    getActiveRuns: vi.fn(async () =>
      runRows.filter((run) => run.status === 'pending' || run.status === 'running'),
    ),
  });

  const pipeline = new RealRunCompletionHandler(adapter as unknown as PipelineAdapter);
  return {
    adapter,
    service: new RunSweepService(adapter, pipeline, makeExecutor()),
    getCase: () => case_,
    events: () => [...events],
    runs: () => [...runRows],
  };
}

function makeCancellationService() {
  return { reconcile: vi.fn(async () => {}) };
}

function makeService(cancellationService = makeCancellationService()) {
  const adapter = makeAdapter();
  const pipeline = makePipeline();
  const executor = makeExecutor();
  return {
    adapter,
    pipeline,
    executor,
    cancellationService,
    service: new RunSweepService(adapter, pipeline, executor, cancellationService),
  };
}

describe('RunSweepService.findUnclaimedAssistantRuns — selection logic', () => {
  beforeEach(() => {
    runRows = [];
  });

  it('selects an assistant run that has been unclaimed for longer than the grace period', async () => {
    runRows = [makeUnclaimedAssistantRun({ created_at: '2026-01-01T00:30:00.000Z' })];
    const { service } = makeService();
    const unclaimed = await service.findUnclaimedAssistantRuns(NOW);
    expect(unclaimed.map((r) => r.run_id)).toEqual(['run_a1']);
  });

  it('leaves a just-created assistant run alone (still inside the 60s claim grace)', async () => {
    runRows = [makeUnclaimedAssistantRun({ created_at: '2026-01-01T00:59:45.000Z' })];
    const { service } = makeService();
    expect(await service.findUnclaimedAssistantRuns(NOW)).toHaveLength(0);
  });

  it('ignores an awaiting_claim run of a NON-assistant type', async () => {
    runRows = [
      makeUnclaimedAssistantRun({ run_id: 'run_x', run_type: 'rule_run', created_at: '2026-01-01T00:00:00.000Z' }),
    ];
    const { service } = makeService();
    expect(await service.findUnclaimedAssistantRuns(NOW)).toHaveLength(0);
  });

  it('ignores an assistant run that already has an owner, flag notwithstanding', async () => {
    runRows = [
      makeUnclaimedAssistantRun({ run_id: 'run_leased', lease_expires_at: '2026-01-01T02:00:00.000Z' }),
      makeUnclaimedAssistantRun({ run_id: 'run_worker', worker_id: 'worker_a' }),
    ];
    const { service } = makeService();
    expect(await service.findUnclaimedAssistantRuns(NOW)).toHaveLength(0);
  });

  it('ignores an assistant run that is no longer pending', async () => {
    runRows = [makeUnclaimedAssistantRun({ status: 'cancelled' })];
    const { service } = makeService();
    expect(await service.findUnclaimedAssistantRuns(NOW)).toHaveLength(0);
  });
});

describe('RunSweepService — the main stale-run sweep leaves assistant runs alone', () => {
  beforeEach(() => {
    runRows = [];
    lockStore.clear();
    txQueue = Promise.resolve();
  });

  it('THE TRAP: an unclaimed assistant run far older than the legacy max age is NOT legacy-stale', async () => {
    // 60 minutes old, no lease — indistinguishable from the legacy cohort
    // except for `awaiting_claim`.
    runRows = [makeUnclaimedAssistantRun({ created_at: '2026-01-01T00:00:00.000Z' })];
    const { service } = makeService();

    const stale = await service.findStaleRuns(NOW);

    expect(stale).toHaveLength(0);
  });

  it('does not fail the unclaimed assistant run during a full sweep — it claims it instead', async () => {
    runRows = [makeUnclaimedAssistantRun({ created_at: '2026-01-01T00:00:00.000Z' })];
    const { adapter, pipeline, executor, service } = makeService();

    const result = await service.sweep(NOW);

    expect(result.swept).toHaveLength(0);
    expect(adapter.failRunIfStillStale).not.toHaveBeenCalled();
    expect(pipeline.handleRunFailure).not.toHaveBeenCalled();
    expect(result.assistant.claimed).toEqual([
      { run_id: 'run_a1', case_id: 'case_a', run_type: 'assistant_task_run', attempt: 1 },
    ]);
    expect(executor.dispatch).toHaveBeenCalledTimes(1);
  });

  it('excludes an assistant run with an expired lease from cohort 1 (the sub-sweep owns it)', async () => {
    runRows = [
      makeUnclaimedAssistantRun({
        status: 'running',
        awaiting_claim: undefined,
        worker_id: 'worker_dead',
        lease_expires_at: '2026-01-01T00:30:00.000Z',
      }),
    ];
    const { service } = makeService();

    expect(await service.findStaleRuns(NOW)).toHaveLength(0);
  });

  it('LEGACY COHORT UNCHANGED: a non-assistant run with no lease is still swept after the max age', async () => {
    runRows = [
      makeRun({ run_id: 'legacy_review', run_type: 'review_run', started_at: '2026-01-01T00:20:00.000Z' }),
      makeRun({ run_id: 'legacy_rule', run_type: 'rule_run', started_at: '2026-01-01T00:20:00.000Z' }),
    ];
    const { service } = makeService();

    const stale = await service.findStaleRuns(NOW);

    expect(stale.map((s) => [s.run.run_id, s.reason]).sort()).toEqual([
      ['legacy_review', 'legacy_no_lease_stale'],
      ['legacy_rule', 'legacy_no_lease_stale'],
    ]);
  });

  it('LEGACY COHORT UNCHANGED: a non-assistant run with an expired lease is still swept end-to-end', async () => {
    runRows = [makeRun({ run_id: 'stale_1', case_id: 'case_1', lease_expires_at: '2026-01-01T00:30:00.000Z' })];
    const { adapter, pipeline, service } = makeService();

    const result = await service.sweep(NOW);

    expect(result.swept).toEqual([
      { run_id: 'stale_1', case_id: 'case_1', run_type: 'review_run', reason: 'lease_expired' },
    ]);
    expect(pipeline.handleRunFailure).toHaveBeenCalledTimes(1);
    expect(adapter.emitEvent).toHaveBeenCalledWith(
      'case_1',
      'run_failed',
      expect.objectContaining({ swept: true, sweep_reason: 'lease_expired' }),
      'system:run-sweeper',
    );
    // …and the assistant pass did not touch it.
    expect(result.assistant.claimed).toHaveLength(0);
    expect(result.assistant.reattempted).toHaveLength(0);
    expect(result.assistant.exhausted).toHaveLength(0);
  });

  it('the assistant sub-sweep does not touch runs of other types', async () => {
    runRows = [
      makeRun({ run_id: 'stale_review', lease_expires_at: '2026-01-01T00:30:00.000Z' }),
      makeRun({ run_id: 'legacy_rule', run_type: 'rule_run', started_at: '2026-01-01T00:20:00.000Z' }),
      makeUnclaimedAssistantRun({ run_id: 'run_x', run_type: 'build_run', created_at: '2026-01-01T00:00:00.000Z' }),
    ];
    const { adapter, executor, service } = makeService();

    const result = await service.sweep(NOW);

    expect(adapter.claimRun).not.toHaveBeenCalled();
    expect(adapter.createUnclaimedRun).not.toHaveBeenCalled();
    expect(executor.dispatch).not.toHaveBeenCalled();
    expect(result.assistant.claimed).toHaveLength(0);
    expect(result.assistant.skipped_claimed).toBe(0);
  });
});

describe('RunSweepService — claiming unclaimed assistant runs', () => {
  beforeEach(() => {
    runRows = [];
    lockStore.clear();
    txQueue = Promise.resolve();
  });

  it('dispatches the POST-claim doc so the executor heartbeat has the lease holder', async () => {
    runRows = [makeUnclaimedAssistantRun({ created_at: '2026-01-01T00:00:00.000Z' })];
    const { executor, service } = makeService();

    await service.sweep(NOW);

    const dispatchedRun = executor.dispatch.mock.calls[0]![0] as Run;
    expect(dispatchedRun.status).toBe('running');
    expect(dispatchedRun.worker_id).toBeTruthy();
    expect(dispatchedRun.lease_expires_at).toBeTruthy();
    expect(dispatchedRun.awaiting_claim).toBeUndefined();
  });

  it('counts a run another worker already claimed under skipped_claimed instead of dispatching it', async () => {
    runRows = [makeUnclaimedAssistantRun({ created_at: '2026-01-01T00:00:00.000Z' })];
    const { adapter, executor, service } = makeService();
    adapter.claimRun.mockImplementationOnce(async () => ({
      claimed: false,
      run: makeUnclaimedAssistantRun({ status: 'running', worker_id: 'worker_other' }),
    }));

    const result = await service.sweep(NOW);

    expect(result.assistant.claimed).toHaveLength(0);
    expect(result.assistant.skipped_claimed).toBe(1);
    expect(executor.dispatch).not.toHaveBeenCalled();
  });

  it('one failing run does not abort the rest of the pass', async () => {
    runRows = [
      makeUnclaimedAssistantRun({ run_id: 'run_bad', created_at: '2026-01-01T00:00:00.000Z' }),
      makeUnclaimedAssistantRun({ run_id: 'run_ok', created_at: '2026-01-01T00:00:00.000Z' }),
    ];
    const { adapter, service } = makeService();
    adapter.claimRun.mockImplementationOnce(async () => {
      throw new Error('firestore unavailable');
    });

    const result = await service.sweep(NOW);

    expect(result.assistant.skipped_claimed).toBe(1);
    expect(result.assistant.claimed.map((c) => c.run_id)).toEqual(['run_ok']);
  });
});

describe('RunSweepService — expired assistant leases start a new attempt, not a terminal failure', () => {
  beforeEach(() => {
    runRows = [];
    lockStore.clear();
    txQueue = Promise.resolve();
  });

  function expiredAssistantRun(attempt: number, overrides: Partial<Run> = {}): Run {
    return makeRun({
      run_id: `run_a${attempt}`,
      case_id: 'case_a',
      run_type: 'assistant_task_run',
      status: 'running',
      attempt,
      worker_id: 'worker_dead',
      lease_expires_at: '2026-01-01T00:30:00.000Z',
      ...overrides,
    });
  }

  it.each([[1, 2], [2, 3]])(
    'attempt %i is replaced by attempt %i while the assistant cap allows',
    async (attempt, nextAttempt) => {
      runRows = [expiredAssistantRun(attempt)];
      const { adapter, pipeline, executor, service } = makeService();

      const result = await service.sweep(NOW);

      // Old attempt failed, new one created at the incremented attempt number.
      expect(runRows.find((r) => r.run_id === `run_a${attempt}`)?.status).toBe('failed');
      expect(adapter.createUnclaimedRun).toHaveBeenCalledWith(
        'case_a',
        'assistant_task_run',
        expect.any(String),
        nextAttempt,
      );
      expect(executor.dispatch).toHaveBeenCalledTimes(1);

      expect(result.assistant.reattempted).toEqual([
        {
          run_id: `run_a${attempt}`,
          case_id: 'case_a',
          run_type: 'assistant_task_run',
          attempt,
          next_run_id: 'run_new_1',
          next_attempt: nextAttempt,
          dispatched: true,
        },
      ]);
      expect(result.assistant.exhausted).toHaveLength(0);

      // NOT a terminal outcome: no exhaustion event…
      const emittedTypes = adapter.emitEvent.mock.calls.map((c) => c[1]);
      expect(emittedTypes).toContain('run_failed');
      expect(emittedTypes).not.toContain('run_retries_exhausted');
      // …and crucially the GLOBAL retry policy is never consulted, which would
      // otherwise schedule a second retry on top of this fresh attempt.
      expect(pipeline.handleRunFailure).not.toHaveBeenCalled();
    },
  );

  it('the replacement attempt is created unclaimed, so a failed dispatch is recoverable later', async () => {
    runRows = [expiredAssistantRun(1)];
    const { adapter, service } = makeService();

    await service.sweep(NOW);

    const replacement = runRows.find((r) => r.run_id === 'run_new_1')!;
    expect(adapter.createUnclaimedRun).toHaveBeenCalledTimes(1);
    // Claimed immediately by this same pass — the unclaimed window is only the
    // durability fallback, not the normal path.
    expect(replacement.status).toBe('running');
    expect(replacement.attempt).toBe(2);
  });

  it('reports dispatched:false when the replacement could not be claimed, leaving it for a later pass', async () => {
    runRows = [expiredAssistantRun(1)];
    const { adapter, service } = makeService();
    // First claim call is for the replacement run (there are no unclaimed runs
    // in this fixture yet).
    adapter.claimRun.mockImplementationOnce(async () => ({ claimed: false, run: null }));

    const result = await service.sweep(NOW);

    expect(result.assistant.reattempted[0]!.dispatched).toBe(false);
    expect(runRows.find((r) => r.run_id === 'run_new_1')?.awaiting_claim).toBe(true);
  });

  it('attempt 3 exhausts the assistant cap into the terminal-failure path', async () => {
    runRows = [expiredAssistantRun(3)];
    const { adapter, pipeline, service } = makeService();

    const result = await service.sweep(NOW);

    expect(adapter.createUnclaimedRun).not.toHaveBeenCalled();
    expect(result.assistant.reattempted).toHaveLength(0);
    expect(result.assistant.exhausted).toEqual([
      {
        run_id: 'run_a3',
        case_id: 'case_a',
        run_type: 'assistant_task_run',
        attempt: 3,
        max_attempts: 3,
      },
    ]);
    // Replacing this call with the former retry_exhausted hold is the exact
    // regression that parks Clerk in an unresumable human-decision state.
    expect(pipeline.documentAssistantTerminalFailure).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 'run_a3', attempt: 3, status: 'failed' }),
      'retry_exhausted',
    );
    expect(pipeline.onRunCompleted).toHaveBeenCalledWith('case_a');
    expect(pipeline.settleAssistantFailureRepair).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 'run_a3' }),
    );
    // Still not the global policy's decision.
    expect(pipeline.handleRunFailure).not.toHaveBeenCalled();
  });

  it('honors ARBITRA_ASSISTANT_MAX_ATTEMPTS independently of MAX_RUN_RETRIES', async () => {
    process.env['ARBITRA_ASSISTANT_MAX_ATTEMPTS'] = '1';
    vi.resetModules();
    const { RunSweepService: FreshService } = await import('./run-sweep-service.js');
    try {
      runRows = [expiredAssistantRun(1)];
      const adapter = makeAdapter();
      const pipeline = makePipeline();
      const executor = makeExecutor();
      const service = new FreshService(adapter, pipeline, executor);

      const result = await service.sweep(NOW);

      // A cap of 1 means attempt 1 is already the last one.
      expect(result.assistant.reattempted).toHaveLength(0);
      expect(result.assistant.exhausted).toHaveLength(1);
      expect(adapter.createUnclaimedRun).not.toHaveBeenCalled();
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_ATTEMPTS'];
    }
  });

  it('does not clobber an assistant run that completed between the query and the fail call', async () => {
    runRows = [expiredAssistantRun(1)];
    const { adapter, pipeline, service } = makeService();
    adapter.failRunIfStillStale.mockImplementationOnce(async () => {
      const completed: Run = { ...runRows[0]!, status: 'completed', summary: 'assistant task done' };
      runRows[0] = completed;
      return { failed: false, run: completed };
    });

    const result = await service.sweep(NOW);

    expect(result.assistant.skipped_completed).toBe(1);
    expect(result.assistant.reattempted).toHaveLength(0);
    expect(result.assistant.exhausted).toHaveLength(0);
    expect(adapter.prepareAssistantReattempt).toHaveBeenCalledTimes(1);
    expect(adapter.createUnclaimedRun).toHaveBeenCalledTimes(1);
    expect(adapter.cancelUnclaimedAssistantReattempt).toHaveBeenCalledWith(
      'run_new_1',
      expect.stringContaining('predecessor run_a1 resolved'),
    );
    const replacement = runRows.find((r) => r.run_id === 'run_new_1')!;
    expect(replacement.status).toBe('cancelled');
    expect(replacement).not.toHaveProperty('awaiting_claim');
    expect(adapter.emitEvent).not.toHaveBeenCalled();
    expect(pipeline.onRunCompleted).not.toHaveBeenCalled();
  });

  it('does not cancel a replacement that another worker claimed before cleanup', async () => {
    runRows = [expiredAssistantRun(1)];
    const { adapter, pipeline, executor, service } = makeService();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    adapter.failRunIfStillStale.mockImplementationOnce(async () => {
      const claim = await adapter.claimRun('run_new_1', 'worker_concurrent');
      expect(claim.claimed).toBe(true);
      const completed: Run = { ...runRows[0]!, status: 'completed', summary: 'assistant task done' };
      runRows[0] = completed;
      return { failed: false, run: completed };
    });

    try {
      const result = await service.sweep(NOW);

      expect(result.assistant.skipped_completed).toBe(1);
      expect(adapter.cancelUnclaimedAssistantReattempt).toHaveBeenCalledTimes(1);
      expect(runRows.find((r) => r.run_id === 'run_new_1')).toEqual(
        expect.objectContaining({ status: 'running', worker_id: 'worker_concurrent' }),
      );
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('already claimed concurrently and was left alone'));
      expect(executor.dispatch).not.toHaveBeenCalled();
      expect(adapter.emitEvent).not.toHaveBeenCalled();
      expect(pipeline.onRunCompleted).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe('RunSweepService — the assistant sub-sweep has its own lock', () => {
  beforeEach(() => {
    runRows = [];
    lockStore.clear();
    txQueue = Promise.resolve();
  });

  it('uses a different lock document than the stale-run sweep', async () => {
    expect(ASSISTANT_SWEEP_LOCK_DOC_ID).not.toBe(RUN_SWEEP_LOCK_DOC_ID);
    runRows = [makeUnclaimedAssistantRun({ created_at: '2026-01-01T00:00:00.000Z' })];
    const { service } = makeService();

    await service.sweep(NOW);

    // Both locks were taken and released cleanly.
    expect(lockStore.size).toBe(0);
  });

  it('a stale-run sweep holding run:sweep does NOT starve assistant recovery', async () => {
    runRows = [
      makeRun({ run_id: 'stale_1', lease_expires_at: '2026-01-01T00:30:00.000Z' }),
      makeUnclaimedAssistantRun({ created_at: '2026-01-01T00:00:00.000Z' }),
    ];
    const { adapter, executor, service } = makeService();

    // Simulate a long in-flight stale-run sweep holding only its own lock.
    const holder = await acquireRunSweepLock(NOW);

    const result = await service.sweep(NOW);

    expect(result.skipped_locked).toBe(true);
    expect(result.swept).toHaveLength(0);
    expect(adapter.failRunIfStillStale).not.toHaveBeenCalled();
    // The assistant pass ran anyway.
    expect(result.assistant.skipped_locked).toBe(false);
    expect(result.assistant.claimed).toHaveLength(1);
    expect(executor.dispatch).toHaveBeenCalledTimes(1);

    await holder.release();
  });

  it('an in-flight assistant sub-sweep does not block the stale-run sweep', async () => {
    runRows = [
      makeRun({ run_id: 'stale_1', case_id: 'case_1', lease_expires_at: '2026-01-01T00:30:00.000Z' }),
      makeUnclaimedAssistantRun({ created_at: '2026-01-01T00:00:00.000Z' }),
    ];
    const { adapter, executor, service } = makeService();

    const holder = await acquireRunSweepLock(NOW, undefined, ASSISTANT_SWEEP_LOCK_DOC_ID);

    const result = await service.sweep(NOW);

    expect(result.assistant.skipped_locked).toBe(true);
    expect(result.assistant.claimed).toHaveLength(0);
    expect(adapter.claimRun).not.toHaveBeenCalled();
    expect(executor.dispatch).not.toHaveBeenCalled();
    // The stale-run pass proceeded normally.
    expect(result.skipped_locked).toBe(false);
    expect(result.swept).toHaveLength(1);

    await holder.release();
  });

  it('skips assistant recovery (rather than degrading to a non-atomic claim) when the adapter cannot claim', async () => {
    runRows = [makeUnclaimedAssistantRun({ created_at: '2026-01-01T00:00:00.000Z' })];
    const { adapter, executor, pipeline } = makeService();
    delete (adapter as { claimRun?: unknown }).claimRun;
    const service = new RunSweepService(adapter, pipeline, executor);

    const result = await service.sweep(NOW);

    expect(result.assistant).toEqual({
      claimed: [],
      reattempted: [],
      exhausted: [],
      failures_repaired: [],
      failures_outstanding: [],
      cancellations_reconciled: [],
      cancellations_outstanding: [],
      skipped_claimed: 0,
      skipped_completed: 0,
      skipped_locked: false,
    });
    expect(executor.dispatch).not.toHaveBeenCalled();
  });
});

/**
 * Out-of-process backstop for the terminal-failure repair: the in-process
 * repair in `RunCompletionHandler.documentAssistantTerminalFailure` is
 * best-effort by contract, so a failed assistant run that still carries
 * `assistant_failure_repair_pending` is a case with no reachable transition.
 */
describe('RunSweepService — outstanding assistant terminal-failure repairs', () => {
  beforeEach(() => {
    runRows = [];
    // The real pipeline takes a per-case lock; a leftover lock doc from another
    // test would silently turn the re-evaluation into a no-op.
    lockStore.clear();
  });

  function makePendingRepairRun(overrides: Partial<Run> = {}): Run {
    return makeRun({
      run_id: 'run_a9',
      case_id: 'case_a',
      run_type: 'assistant_task_run',
      status: 'failed',
      attempt: 1,
      error_message: 'Assistant attempt stopped by the max_steps bound',
      assistant_failure_repair_pending: true,
      finished_at: '2026-01-01T00:30:00.000Z',
      ...overrides,
    });
  }

  it('selects a marked failed assistant run once the grace period has passed', async () => {
    runRows = [makePendingRepairRun()];
    const { service } = makeService();

    const pending = await service.findAssistantFailureRepairs(NOW);

    expect(pending.map((run) => run.run_id)).toEqual(['run_a9']);
  });

  it('leaves a freshly marked run to the in-process repair', async () => {
    runRows = [makePendingRepairRun({ finished_at: '2026-01-01T00:59:59.000Z' })];
    const { service } = makeService();

    expect(await service.findAssistantFailureRepairs(NOW)).toEqual([]);
  });

  it('selects a recent permanent assistant failure even when the marker write itself was lost', async () => {
    runRows = [makePendingRepairRun({
      run_id: 'run_lost_marker',
      assistant_failure_repair_pending: undefined,
    })];
    const { service } = makeService();

    expect((await service.findAssistantFailureRepairs(NOW)).map((run) => run.run_id))
      .toEqual(['run_lost_marker']);
  });

  it('prioritizes the newest safety-net failures when the bounded cohort is full', async () => {
    runRows = Array.from({ length: 101 }, (_, index) => makePendingRepairRun({
      run_id: `run_${index}`,
      assistant_failure_repair_pending: undefined,
      finished_at: new Date(NOW.getTime() - (102 - index) * 60_000).toISOString(),
    }));
    const { service } = makeService();

    const pending = await service.findAssistantFailureRepairs(NOW);

    expect(pending).toHaveLength(100);
    expect(pending[0]?.run_id).toBe('run_100');
    expect(pending.map((run) => run.run_id)).not.toContain('run_0');
  });

  it('ignores settled, transient, non-assistant, and non-failed safety-net candidates', async () => {
    runRows = [
      makePendingRepairRun({
        run_id: 'run_settled',
        assistant_failure_repair_pending: undefined,
        assistant_failure_repair_settled_at: '2026-01-01T00:40:00.000Z',
      }),
      makePendingRepairRun({
        run_id: 'run_transient',
        assistant_failure_repair_pending: undefined,
        error_message: '503 Service Unavailable',
      }),
      makePendingRepairRun({ run_id: 'run_review', run_type: 'review_run' }),
      makePendingRepairRun({ run_id: 'run_running', status: 'running' }),
    ];
    const { service } = makeService();

    expect(await service.findAssistantFailureRepairs(NOW)).toEqual([]);
  });

  const REPAIR_SUMMARY = {
    run_id: 'run_a9',
    case_id: 'case_a',
    run_type: 'assistant_task_run',
    attempt: 1,
  };

  it('drives the real repair to a rejected case and clears the marker', async () => {
    runRows = [makePendingRepairRun()];
    const harness = makeRealRepairHarness(makeAssistantCaseDoc('in_build'));

    const result = await harness.service.sweep(NOW);

    // The outcome, not the call: a wedged case is now terminal and has stopped
    // consuming one of the requester's active-task slots.
    expect(harness.getCase().status).toBe('rejected');
    expect(harness.getCase().assistant_context).toMatchObject({
      wait_reason: 'failed_permanently',
      wait_run_id: 'run_a9',
    });
    expect(
      harness.events().filter((event) => event.type === 'assistant_task_abandoned'),
    ).toHaveLength(1);
    expect(harness.events().map((event) => event.type)).toContain('case_rejected');
    expect(harness.runs()[0]?.assistant_failure_repair_pending).toBeFalsy();
    expect(result.assistant.failures_repaired).toEqual([REPAIR_SUMMARY]);
    expect(result.assistant.failures_outstanding).toEqual([]);
  });

  it('emits the missing event half for a hold whose case write landed alone', async () => {
    runRows = [makePendingRepairRun()];
    const partiallyDocumented = makeAssistantCaseDoc('in_build');
    partiallyDocumented.assistant_context = {
      ...partiallyDocumented.assistant_context!,
      wait_reason: 'failed_permanently',
      wait_run_id: 'run_a9',
      wait_attempt: 1,
    };
    const harness = makeRealRepairHarness(partiallyDocumented);

    const result = await harness.service.sweep(NOW);

    // Keying "already documented" on the case fields alone would emit nothing
    // here, leaving a hold no event documents — no satisfiable edge, no marker.
    expect(
      harness.events().filter((event) => event.type === 'assistant_task_abandoned'),
    ).toHaveLength(1);
    expect(harness.getCase().status).toBe('rejected');
    expect(result.assistant.failures_repaired).toEqual([REPAIR_SUMMARY]);
  });

  it('reports the repair as outstanding and keeps the marker when the hold write fails', async () => {
    runRows = [makePendingRepairRun()];
    const harness = makeRealRepairHarness(makeAssistantCaseDoc('in_build'));
    harness.adapter.documentAssistantHold.mockRejectedValue(new Error('firestore down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await harness.service.sweep(NOW);
    logged.mockRestore();

    expect(harness.getCase().status).toBe('in_build');
    expect(result.assistant.failures_repaired).toEqual([]);
    expect(result.assistant.failures_outstanding).toEqual([REPAIR_SUMMARY]);
    expect(harness.runs()[0]?.assistant_failure_repair_pending).toBe(true);
  });

  it('keeps the marker and reports outstanding when the re-evaluation loses the pipeline lock', async () => {
    runRows = [makePendingRepairRun()];
    const harness = makeRealRepairHarness(makeAssistantCaseDoc('in_build'));
    // A concurrent evaluation holds the per-case lock, so `onRunCompleted`
    // no-ops and the documented edge is never taken. This is the window that
    // makes the marker meaningful: the hold is written, the case is not
    // terminal, and only the marker can lead anything back to it.
    // `acquireCasePipelineLock` compares `expires_at` against the REAL clock,
    // not the sweep's `now`, so this has to outlive the test run itself.
    lockStore.set(`${CASE_PIPELINE_LOCKS_COLLECTION}/${casePipelineLockDocId('case_a')}`, {
      acquired_at: '2026-01-01T00:59:00.000Z',
      expires_at: '2999-01-01T00:00:00.000Z',
      holder: 'someone_else',
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await harness.service.sweep(NOW);
    logged.mockRestore();

    expect(harness.getCase().status).toBe('in_build');
    expect(harness.runs()[0]?.assistant_failure_repair_pending).toBe(true);
    expect(result.assistant.failures_repaired).toEqual([]);
    expect(result.assistant.failures_outstanding).toEqual([REPAIR_SUMMARY]);
  });

  it('reports the repair as outstanding when the terminal case is observed but marker clear fails', async () => {
    runRows = [makePendingRepairRun()];
    const harness = makeRealRepairHarness(makeAssistantCaseDoc('rejected'));
    harness.adapter.clearAssistantFailureRepairPending.mockRejectedValue(
      new Error('firestore unavailable'),
    );
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await harness.service.sweep(NOW);
    logged.mockRestore();

    expect(harness.runs()[0]?.assistant_failure_repair_pending).toBe(true);
    expect(result.assistant.failures_repaired).toEqual([]);
    expect(result.assistant.failures_outstanding).toEqual([REPAIR_SUMMARY]);
  });

  it('drops the marker for a case that no longer exists, reporting neither a repair nor a failure', async () => {
    runRows = [makePendingRepairRun()];
    const harness = makeRealRepairHarness(makeAssistantCaseDoc('in_build'));
    harness.adapter.getCase.mockRejectedValue(new NotFoundError('Case', 'case_a'));

    const result = await harness.service.sweep(NOW);

    // A deleted case can never transition, so retaining the marker would mean
    // re-selecting this run and logging a failed repair on every pass forever.
    expect(harness.runs()[0]?.assistant_failure_repair_pending).toBeFalsy();
    expect(result.assistant.failures_repaired).toEqual([]);
    expect(result.assistant.failures_outstanding).toEqual([]);
  });

  it('clears the marker without re-documenting a case that is already terminal', async () => {
    runRows = [makePendingRepairRun()];
    const harness = makeRealRepairHarness(makeAssistantCaseDoc('rejected'));

    const result = await harness.service.sweep(NOW);

    expect(harness.events()).toEqual([]);
    expect(harness.runs()[0]?.assistant_failure_repair_pending).toBeFalsy();
    expect(result.assistant.failures_repaired).toEqual([REPAIR_SUMMARY]);
  });
});

describe('RunSweepService — outstanding assistant cancellation reconciliation', () => {
  beforeEach(() => {
    runRows = [];
    lockStore.clear();
    txQueue = Promise.resolve();
  });

  it('stale cancellation marker: reconciles unavailable once and is not selected by the next sweep', async () => {
    runRows = [makeRun({
      run_id: 'run_cancelled',
      case_id: 'case_a',
      run_type: 'assistant_task_run',
      status: 'cancelled',
      attempt: 2,
      finished_at: '2026-01-01T00:30:00.000Z',
      assistant_cancel_intent: {
        revision: 3,
        requested_at: '2026-01-01T00:29:59.000Z',
        requested_by: 'usr_requester',
      },
      assistant_cancel_reconcile_pending: true,
    })];
    const reconcile = vi.fn(async (input: { runId: string }) => {
      const index = runRows.findIndex((run) => run.run_id === input.runId);
      runRows[index] = {
        ...runRows[index]!,
        assistant_cancel_reconcile_pending: undefined,
        assistant_cancel_receipt: {
          revision: 3,
          reconciled_at: NOW.toISOString(),
          reconciled_by: 'assistant_sweeper',
          usage_status: 'unavailable',
          trace_status: 'unavailable',
          event_id: 'event_cancelled',
        },
      };
    });
    const { service } = makeService({ reconcile });

    const first = await service.sweep(NOW);
    const second = await service.sweep(NOW);

    // Removing the fourth assistant pass leaves this marker forever. Changing
    // either status from `unavailable` lies about data the dead executor never
    // persisted. A successful reconcile must clear selection for the next pass.
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith({
      runId: 'run_cancelled',
      reconciledBy: 'assistant_sweeper',
      usageStatus: 'unavailable',
      traceStatus: 'unavailable',
    });
    expect(first.assistant.cancellations_reconciled).toEqual([{
      run_id: 'run_cancelled',
      case_id: 'case_a',
      run_type: 'assistant_task_run',
      attempt: 2,
    }]);
    expect(first.assistant.cancellations_outstanding).toEqual([]);
    expect(second.assistant.cancellations_reconciled).toEqual([]);
    expect(runRows[0]?.assistant_cancel_receipt).toMatchObject({
      usage_status: 'unavailable',
      trace_status: 'unavailable',
      reconciled_by: 'assistant_sweeper',
    });
  });
});
