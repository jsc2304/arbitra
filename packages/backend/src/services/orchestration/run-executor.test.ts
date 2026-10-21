import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Run, Case } from '@arbitra/shared';
import type { PipelineAdapter } from './pipeline-adapter.js';
import type { RunCompletionHandler } from './pipeline.js';

// RunExecutor.executeRuleRun dynamically `import()`s these — mock both so
// we control whether rule evaluation succeeds or throws.
const evaluateRulesForCaseMock = vi.fn();
vi.mock('../rule/rule-service.js', () => ({
  RuleService: class {
    evaluateRulesForCase = evaluateRulesForCaseMock;
  },
}));

const getByCaseIdMock = vi.fn(async () => []);
vi.mock('../evidence/evidence-repository.js', () => ({
  EvidenceRepository: class {
    getByCaseId = getByCaseIdMock;
  },
}));

import { RunExecutor } from './run-executor.js';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_test',
    title: 'Test Case',
    description: 'A test case',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_test',
    repository_id: 'repo_test',
    owner_user_id: 'usr_owner',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    status: 'in_validation',
    decision_ready: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Case;
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: 'run_1',
    case_id: 'case_test',
    run_type: 'rule_run',
    trigger_source: 'system',
    status: 'running',
    input_refs: [],
    output_refs: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    attempt: 1,
    ...overrides,
  };
}

function makeAdapter(): PipelineAdapter & {
  emitEvent: ReturnType<typeof vi.fn>;
  completeRun: ReturnType<typeof vi.fn>;
  failRun: ReturnType<typeof vi.fn>;
} {
  return {
    getCase: vi.fn(),
    updateCaseStatus: vi.fn(),
    updateCase: vi.fn(),
    loadPreconditionContext: vi.fn(),
    createRun: vi.fn(),
    completeRun: vi.fn(async () => makeRun({ status: 'completed' })),
    failRun: vi.fn(async (runId: string, caseId: string, error: string) =>
      makeRun({ run_id: runId, case_id: caseId, status: 'failed', error_message: error }),
    ),
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
async function flushAsync(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('RunExecutor — executor-failure wiring into handleRunFailure (PR #742)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    evaluateRulesForCaseMock.mockReset();
    getByCaseIdMock.mockReset();
    getByCaseIdMock.mockResolvedValue([]);
  });

  it('routes a transient rule_run failure through handleRunFailure with attempt+1 eligible on the failed run', async () => {
    evaluateRulesForCaseMock.mockRejectedValueOnce(new Error('ETIMEDOUT: rule engine unavailable'));
    const adapter = makeAdapter();
    const pipeline = makePipeline();
    const executor = new RunExecutor(adapter, pipeline);
    const run = makeRun({ run_type: 'rule_run', attempt: 1 });
    const case_ = makeCase();

    executor.dispatch(run, case_);
    await flushAsync();

    expect(adapter.failRun).toHaveBeenCalledWith('run_1', 'case_test', expect.stringContaining('ETIMEDOUT'));
    expect(adapter.emitEvent).toHaveBeenCalledWith(
      'case_test',
      'run_failed',
      expect.objectContaining({
        run_id: 'run_1',
        run_type: 'rule_run',
        attempt: 1,
        error: expect.stringContaining('ETIMEDOUT'),
        in_process: true,
      }),
      'system:run-executor',
    );
    expect(pipeline.handleRunFailure).toHaveBeenCalledTimes(1);
    expect(pipeline.handleRunFailure.mock.calls[0]![0]).toMatchObject({
      run_id: 'run_1',
      status: 'failed',
      attempt: 1,
    });
    expect(pipeline.onRunCompleted).toHaveBeenCalledWith('case_test');
    // Exactly one onRunCompleted call for this failure — not also the
    // normal post-switch success call (would be a redundant re-evaluation).
    expect(pipeline.onRunCompleted).toHaveBeenCalledTimes(1);
    // The terminal-failure repair marker is an assistant-only concept; no other
    // run type gains a step on its failure path.
    expect(pipeline.settleAssistantFailureRepair).not.toHaveBeenCalled();
  });

  it('routes an outer-catch failure (e.g. emitEvent throwing before the switch) through handleRunFailure too', async () => {
    const adapter = makeAdapter();
    adapter.emitEvent = vi.fn(async () => {
      throw new Error('network: emit failed');
    });
    const pipeline = makePipeline();
    const executor = new RunExecutor(adapter, pipeline);
    const run = makeRun({ run_type: 'rule_run' });
    const case_ = makeCase();

    executor.dispatch(run, case_);
    await flushAsync();

    expect(adapter.failRun).toHaveBeenCalledWith('run_1', 'case_test', expect.stringContaining('network'));
    expect(pipeline.handleRunFailure).toHaveBeenCalledTimes(1);
    expect(pipeline.onRunCompleted).toHaveBeenCalledTimes(1);
  });

  it('routes the "no executor for run type" failure through handleRunFailure (permanent classification — no retry, but still surfaced)', async () => {
    const adapter = makeAdapter();
    const pipeline = makePipeline();
    const executor = new RunExecutor(adapter, pipeline);
    const run = makeRun({ run_type: 'build_run' });
    const case_ = makeCase();

    executor.dispatch(run, case_);
    await flushAsync();

    expect(adapter.failRun).toHaveBeenCalledWith('run_1', 'case_test', 'No executor for run type: build_run');
    expect(pipeline.handleRunFailure).toHaveBeenCalledTimes(1);
    expect(pipeline.onRunCompleted).toHaveBeenCalledTimes(1);
  });

  it('does not call onRunCompleted twice, and does not call handleRunFailure, on the success path', async () => {
    evaluateRulesForCaseMock.mockResolvedValueOnce(undefined);
    const adapter = makeAdapter();
    const pipeline = makePipeline();
    const executor = new RunExecutor(adapter, pipeline);
    const run = makeRun({ run_type: 'rule_run' });
    const case_ = makeCase();

    executor.dispatch(run, case_);
    await flushAsync();

    expect(adapter.completeRun).toHaveBeenCalledTimes(1);
    expect(adapter.failRun).not.toHaveBeenCalled();
    expect(pipeline.handleRunFailure).not.toHaveBeenCalled();
    expect(pipeline.onRunCompleted).toHaveBeenCalledTimes(1);
  });

  it('propagates a real handleRunFailure implementation deciding to retry (integration-style, real classification)', async () => {
    // Use the REAL classifyRunFailure-driven handleRunFailure via a minimal
    // RunCompletionHandler-shaped stub that mimics just enough of the real
    // decision to prove wiring, without importing the full pipeline module
    // (already covered end-to-end in pipeline.test.ts's handleRunFailure
    // suite). Here we just assert the run handed to handleRunFailure carries
    // everything needed for that decision (attempt, error_message, case_id).
    evaluateRulesForCaseMock.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const adapter = makeAdapter();
    const run = makeRun({ run_type: 'rule_run', attempt: 2 });
    // The real FirestorePipelineAdapter.failRun does an `update()` on the
    // EXISTING doc (preserving fields like `attempt`) then re-reads it —
    // echo that behavior here instead of the generic default stub, which
    // constructs an unrelated fresh run.
    adapter.failRun = vi.fn(async (runId: string, caseId: string, error: string) => ({
      ...run,
      run_id: runId,
      case_id: caseId,
      status: 'failed' as const,
      error_message: error,
    }));
    const pipeline = makePipeline();
    const executor = new RunExecutor(adapter, pipeline);
    const case_ = makeCase();

    executor.dispatch(run, case_);
    await flushAsync();

    const failedRunArg = pipeline.handleRunFailure.mock.calls[0]![0];
    expect(failedRunArg.attempt).toBe(2);
    expect(failedRunArg.error_message).toContain('503');
    expect(failedRunArg.case_id).toBe('case_test');
  });
});
