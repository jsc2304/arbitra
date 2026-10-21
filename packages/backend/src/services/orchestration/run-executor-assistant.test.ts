import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Run, Case, RunType } from '@arbitra/shared';
import type { PipelineAdapter, RunClaimResult } from './pipeline-adapter.js';
import type { RunCompletionHandler } from './pipeline.js';

/**
 * Assistant run types in `RunExecutor`: registration in the `switch`, and the
 * three parts of the run-durability contract around the (still minimal) task
 * body — claim, heartbeat, lease release.
 *
 * The heartbeat interval is read once at module load, so it is shortened here
 * BEFORE importing the executor and restored immediately after, which lets a
 * deliberately slow `completeRun` observe real heartbeat ticks.
 */
const PREVIOUS_HEARTBEAT_INTERVAL = process.env['ARBITRA_RUN_HEARTBEAT_INTERVAL_MS'];
process.env['ARBITRA_RUN_HEARTBEAT_INTERVAL_MS'] = '5';
const { RunExecutor } = await import('./run-executor.js');
if (PREVIOUS_HEARTBEAT_INTERVAL === undefined) {
  delete process.env['ARBITRA_RUN_HEARTBEAT_INTERVAL_MS'];
} else {
  process.env['ARBITRA_RUN_HEARTBEAT_INTERVAL_MS'] = PREVIOUS_HEARTBEAT_INTERVAL;
}

afterAll(() => {
  if (PREVIOUS_HEARTBEAT_INTERVAL === undefined) {
    delete process.env['ARBITRA_RUN_HEARTBEAT_INTERVAL_MS'];
  } else {
    process.env['ARBITRA_RUN_HEARTBEAT_INTERVAL_MS'] = PREVIOUS_HEARTBEAT_INTERVAL;
  }
});

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_assistant',
    title: 'Assistant task',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_test',
    repository_id: 'repo_test',
    owner_user_id: 'usr_owner',
    case_type: 'assistant_task',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    status: 'in_progress',
    decision_ready: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Case;
}

/** An unclaimed run doc as `createUnclaimedRun` writes it. */
function makeUnclaimedRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: 'run_a1',
    case_id: 'case_assistant',
    run_type: 'assistant_task_run',
    trigger_source: 'system:test',
    status: 'pending',
    input_refs: [],
    output_refs: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    awaiting_claim: true,
    attempt: 1,
    ...overrides,
  };
}

function makeAdapter(): PipelineAdapter & {
  emitEvent: ReturnType<typeof vi.fn>;
  completeRun: ReturnType<typeof vi.fn>;
  failRun: ReturnType<typeof vi.fn>;
  claimRun: ReturnType<typeof vi.fn>;
  createUnclaimedRun: ReturnType<typeof vi.fn>;
  refreshRunLease: ReturnType<typeof vi.fn>;
} {
  return {
    getCase: vi.fn(),
    updateCaseStatus: vi.fn(),
    updateCase: vi.fn(),
    loadPreconditionContext: vi.fn(),
    createRun: vi.fn(),
    createUnclaimedRun: vi.fn(async () => makeUnclaimedRun()),
    // Default: the claim succeeds and returns the post-claim doc, exactly as
    // the Firestore adapter's transaction does.
    claimRun: vi.fn(
      async (runId: string, workerId: string): Promise<RunClaimResult> => ({
        claimed: true,
        run: {
          ...makeUnclaimedRun({ run_id: runId }),
          status: 'running',
          started_at: '2026-01-01T00:01:00Z',
          lease_expires_at: '2026-01-01T00:06:00Z',
          worker_id: workerId,
          awaiting_claim: undefined,
        },
      }),
    ),
    completeRun: vi.fn(async () => makeUnclaimedRun({ status: 'completed' })),
    failRun: vi.fn(async (runId: string, caseId: string, error: string) =>
      makeUnclaimedRun({ run_id: runId, case_id: caseId, status: 'failed', error_message: error }),
    ),
    refreshRunLease: vi.fn(async () => {}),
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
  settleAssistantFailureRepair: ReturnType<typeof vi.fn>;
} {
  return {
    handleRunFailure: vi.fn(async () => {}),
    onRunCompleted: vi.fn(async () => ({})),
    settleAssistantFailureRepair: vi.fn(async () => false),
  } as unknown as RunCompletionHandler & {
    handleRunFailure: ReturnType<typeof vi.fn>;
    onRunCompleted: ReturnType<typeof vi.fn>;
    settleAssistantFailureRepair: ReturnType<typeof vi.fn>;
  };
}

/** Flush the `setImmediate`-deferred `execute()` and its internal await chain. */
async function flushAsync(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('RunExecutor — assistant run registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each<[RunType]>([['assistant_task_run'], ['assistant_action_run']])(
    'has an executor for %s (does NOT fall through to the permanent "no executor" failure)',
    async (runType) => {
      const adapter = makeAdapter();
      const pipeline = makePipeline();
      const executor = new RunExecutor(adapter, pipeline);
      // Already claimed (dispatched straight after a successful claim).
      const run = makeUnclaimedRun({
        run_type: runType,
        status: 'running',
        worker_id: 'worker_a',
        lease_expires_at: '2099-01-01T00:00:00Z',
        awaiting_claim: undefined,
      });

      executor.dispatch(run, makeCase());
      await flushAsync();

      expect(adapter.failRun).not.toHaveBeenCalled();
      expect(pipeline.handleRunFailure).not.toHaveBeenCalled();
      expect(adapter.completeRun).toHaveBeenCalledWith('run_a1', 'case_assistant', expect.any(String));
      expect(pipeline.onRunCompleted).toHaveBeenCalledTimes(1);
    },
  );

  it('emits run_started and completes, releasing the run for the next lifecycle step', async () => {
    const adapter = makeAdapter();
    const pipeline = makePipeline();
    const executor = new RunExecutor(adapter, pipeline);
    const run = makeUnclaimedRun({
      status: 'running',
      worker_id: 'worker_a',
      lease_expires_at: '2099-01-01T00:00:00Z',
      awaiting_claim: undefined,
    });

    executor.dispatch(run, makeCase());
    await flushAsync();

    expect(adapter.emitEvent).toHaveBeenCalledWith(
      'case_assistant',
      'run_started',
      expect.objectContaining({ run_id: 'run_a1', run_type: 'assistant_task_run' }),
      'system:run-executor',
    );
    expect(adapter.completeRun).toHaveBeenCalledTimes(1);
  });
});

describe('RunExecutor — claiming a run dispatched unclaimed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims the run before doing any work, and operates on the POST-claim doc', async () => {
    const adapter = makeAdapter();
    const pipeline = makePipeline();
    const executor = new RunExecutor(adapter, pipeline);

    executor.dispatch(makeUnclaimedRun(), makeCase());
    await flushAsync();

    expect(adapter.claimRun).toHaveBeenCalledTimes(1);
    expect(adapter.claimRun.mock.calls[0]![0]).toBe('run_a1');
    // A generated worker id, not an empty string or the run id.
    expect(adapter.claimRun.mock.calls[0]![1]).toMatch(/^[0-9a-f]{16}$/);
    expect(adapter.completeRun).toHaveBeenCalledWith('run_a1', 'case_assistant', expect.any(String));
  });

  it('stands down without touching the run when another worker already holds the claim', async () => {
    const adapter = makeAdapter();
    adapter.claimRun = vi.fn(
      async (): Promise<RunClaimResult> => ({
        claimed: false,
        run: makeUnclaimedRun({ status: 'running', worker_id: 'worker_other' }),
      }),
    );
    const pipeline = makePipeline();
    const executor = new RunExecutor(adapter, pipeline);

    executor.dispatch(makeUnclaimedRun(), makeCase());
    await flushAsync();

    // No work, and crucially no failRun: the run is not broken, it is simply
    // not ours — failing it would clobber the live execution that owns it.
    expect(adapter.completeRun).not.toHaveBeenCalled();
    expect(adapter.failRun).not.toHaveBeenCalled();
    expect(adapter.emitEvent).not.toHaveBeenCalled();
    expect(pipeline.handleRunFailure).not.toHaveBeenCalled();
    expect(pipeline.onRunCompleted).not.toHaveBeenCalled();
  });

  it('heartbeats with the worker id the CLAIM returned, and stops the heartbeat once the run is done', async () => {
    const adapter = makeAdapter();
    // Slow enough for several 5ms heartbeat ticks to land mid-execution.
    adapter.completeRun = vi.fn(async () => {
      await sleep(40);
      return makeUnclaimedRun({ status: 'completed' });
    });
    const pipeline = makePipeline();
    const executor = new RunExecutor(adapter, pipeline);

    executor.dispatch(makeUnclaimedRun(), makeCase());
    await sleep(80);

    expect(adapter.refreshRunLease).toHaveBeenCalled();
    const claimedWorkerId = adapter.claimRun.mock.calls[0]![1];
    for (const call of adapter.refreshRunLease.mock.calls) {
      expect(call[0]).toBe('run_a1');
      expect(call[1]).toBe(claimedWorkerId);
    }

    // Lease release: the interval must be cleared, or it would keep resurrecting
    // a lease on an already-terminal run.
    const callsAtCompletion = adapter.refreshRunLease.mock.calls.length;
    await sleep(40);
    expect(adapter.refreshRunLease.mock.calls.length).toBe(callsAtCompletion);
  });

  it('routes a completeRun failure through handleRunFailure (assistant runs are not a retry dead end)', async () => {
    const adapter = makeAdapter();
    adapter.completeRun = vi.fn(async () => {
      throw new Error('ETIMEDOUT: firestore unavailable');
    });
    const pipeline = makePipeline();
    const executor = new RunExecutor(adapter, pipeline);

    executor.dispatch(makeUnclaimedRun(), makeCase());
    await flushAsync();

    expect(adapter.failRun).toHaveBeenCalledWith('run_a1', 'case_assistant', expect.stringContaining('ETIMEDOUT'));
    expect(pipeline.handleRunFailure).toHaveBeenCalledTimes(1);
    expect(pipeline.onRunCompleted).toHaveBeenCalledTimes(1);
    // The repair marker is discharged by the case becoming terminal, which the
    // re-evaluation above is what produces — so the observation has to come
    // after it, not from inside the repair.
    expect(pipeline.settleAssistantFailureRepair).toHaveBeenCalledTimes(1);
    expect(
      pipeline.onRunCompleted.mock.invocationCallOrder[0]!,
    ).toBeLessThan(pipeline.settleAssistantFailureRepair.mock.invocationCallOrder[0]!);
  });

  it('never attempts a claim for a run that is not awaiting one (unchanged path for existing run types)', async () => {
    const adapter = makeAdapter();
    const pipeline = makePipeline();
    const executor = new RunExecutor(adapter, pipeline);
    // A `createRun`-shaped run: claimed at creation, no `awaiting_claim`.
    const run = makeUnclaimedRun({
      run_type: 'evidence_collection_run',
      status: 'pending',
      worker_id: 'worker_creator',
      lease_expires_at: '2099-01-01T00:00:00Z',
      awaiting_claim: undefined,
    });

    executor.dispatch(run, makeCase());
    await flushAsync();

    expect(adapter.claimRun).not.toHaveBeenCalled();
    expect(adapter.completeRun).toHaveBeenCalledTimes(1);
  });

  it('executes unclaimed (no crash) when the adapter does not implement claimRun', async () => {
    const adapter = makeAdapter();
    delete (adapter as { claimRun?: unknown }).claimRun;
    const pipeline = makePipeline();
    const executor = new RunExecutor(adapter, pipeline);

    executor.dispatch(makeUnclaimedRun(), makeCase());
    await flushAsync();

    expect(adapter.completeRun).toHaveBeenCalledTimes(1);
  });
});
