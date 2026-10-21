import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Case, CaseEvent, Run } from '@arbitra/shared';
import type { RunCompletionHandler } from './pipeline.js';
import type { RunExecutor } from './run-executor.js';
import type { RunSweepAdapter } from './run-sweep-service.js';

let runRows: Run[] = [];

interface Filter {
  field: string;
  op: string;
  value: unknown;
}

function matches(row: Record<string, unknown>, filter: Filter): boolean {
  if (filter.op === '==') return row[filter.field] === filter.value;
  if (filter.op === 'in') {
    return Array.isArray(filter.value) && filter.value.includes(row[filter.field]);
  }
  if (filter.op === '<=') {
    return typeof row[filter.field] === 'string'
      && (row[filter.field] as string) <= (filter.value as string);
  }
  if (filter.op === '>=') {
    return typeof row[filter.field] === 'string'
      && (row[filter.field] as string) >= (filter.value as string);
  }
  if (filter.op === '<') {
    return typeof row[filter.field] === 'string'
      && (row[filter.field] as string) < (filter.value as string);
  }
  throw new Error(`Unsupported operator ${filter.op}`);
}

interface Ordering {
  field: string;
  direction: 'asc' | 'desc';
}

function runsQuery(filters: Filter[] = [], maxRows?: number, ordering?: Ordering) {
  return {
    where: (field: string, op: string, value: unknown) =>
      runsQuery([...filters, { field, op, value }], maxRows, ordering),
    orderBy: (field: string, direction: 'asc' | 'desc') =>
      runsQuery(filters, maxRows, { field, direction }),
    limit: (value: number) => runsQuery(filters, value, ordering),
    get: async () => ({
      docs: runRows
        .filter((run) => filters.every((filter) =>
          matches(run as unknown as Record<string, unknown>, filter)))
        .sort((left, right) => {
          if (!ordering) return 0;
          const leftValue = String((left as unknown as Record<string, unknown>)[ordering.field]);
          const rightValue = String((right as unknown as Record<string, unknown>)[ordering.field]);
          return leftValue.localeCompare(rightValue) * (ordering.direction === 'desc' ? -1 : 1);
        })
        .slice(0, maxRows ?? runRows.length)
        .map((run) => ({ data: () => run })),
    }),
  };
}

vi.mock('../../lib/firestore.js', () => ({
  collections: { runs: () => runsQuery() },
}));

vi.mock('./run-sweep-lock.js', () => ({
  RUN_SWEEP_LOCK_TTL_MS: 300_000,
  RUN_SWEEP_LOCK_DOC_ID: 'run:sweep',
  ASSISTANT_SWEEP_LOCK_DOC_ID: 'run:sweep:assistant',
  RunSweepLockHeldError: class RunSweepLockHeldError extends Error {},
  acquireRunSweepLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
}));

delete process.env['ARBITRA_ASSISTANT_MAX_ATTEMPTS'];
delete process.env['ARBITRA_ASSISTANT_CLAIM_GRACE_MS'];

const { RunSweepService } = await import('./run-sweep-service.js');
const NOW = new Date('2026-08-03T11:00:00.000Z');

function makeRun(attempt: number): Run {
  return {
    run_id: `run_a${attempt}`,
    case_id: 'case_a',
    run_type: 'assistant_task_run',
    trigger_source: 'system:test',
    status: 'running',
    input_refs: [],
    output_refs: [],
    attempt,
    worker_id: 'worker_dead',
    lease_expires_at: '2026-08-03T10:00:00.000Z',
    started_at: '2026-08-03T09:59:00.000Z',
    created_at: '2026-08-03T09:59:00.000Z',
    updated_at: '2026-08-03T10:00:00.000Z',
  };
}

function makeCase(): Case {
  return {
    case_id: 'case_a',
    title: 'Assistant task',
    description: 'Test task',
    source_type: 'google_chat',
    source_ref: 'message_1',
    project_id: 'project_1',
    repository_id: 'repo_1',
    owner_user_id: 'user_1',
    status: 'in_build',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    case_type: 'assistant_task',
    assistant_context: {
      channel: 'google_chat',
      space_name: 'space_1',
      thread_name: 'thread_1',
      source_message_name: 'message_1',
      chat_user_name: 'user_1',
      conversation_visibility: 'space',
      task_kind: 'implementation',
      risk_level: 'low',
      policy_version: 'policy-v1',
      prompt_version: 'prompt-v1',
    },
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-08-03T09:58:00.000Z',
    updated_at: '2026-08-03T09:58:00.000Z',
  };
}

function makeService(options: { failFirstCreate?: boolean } = {}) {
  let case_ = makeCase();
  let created = 0;
  let failNextCreate = options.failFirstCreate ?? false;
  const events: CaseEvent[] = [];
  const order: string[] = [];

  const adapter = {
    getCase: vi.fn(async () => case_),
    updateCaseStatus: vi.fn(),
    updateCase: vi.fn(async (_caseId: string, updates: Partial<Case>) => {
      case_ = { ...case_, ...updates };
      return case_;
    }),
    loadPreconditionContext: vi.fn(),
    createRun: vi.fn(),
    createUnclaimedRun: vi.fn(async (
      caseId: string,
      runType: Run['run_type'],
      triggerSource: string,
      attempt = 1,
    ) => {
      order.push('create_replacement');
      if (failNextCreate) {
        failNextCreate = false;
        throw new Error('create failed');
      }
      created++;
      const replacement: Run = {
        run_id: `run_new_${created}`,
        case_id: caseId,
        run_type: runType,
        trigger_source: triggerSource,
        status: 'pending',
        input_refs: [],
        output_refs: [],
        awaiting_claim: true,
        attempt,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      };
      runRows.push(replacement);
      return replacement;
    }),
    prepareAssistantReattempt: vi.fn((
      caseId: string,
      runType: Run['run_type'],
      triggerSource: string,
      attempt: number,
    ) => adapter.createUnclaimedRun(caseId, runType, triggerSource, attempt)),
    claimRun: vi.fn(async (runId: string, workerId: string) => {
      const index = runRows.findIndex((run) => run.run_id === runId);
      const run = runRows[index];
      if (!run || run.status !== 'pending' || run.worker_id || run.lease_expires_at) {
        return { claimed: false, run: run ?? null };
      }
      const claimed = {
        ...run,
        status: 'running' as const,
        worker_id: workerId,
        lease_expires_at: '2026-08-03T11:05:00.000Z',
        started_at: NOW.toISOString(),
      };
      delete claimed.awaiting_claim;
      runRows[index] = claimed;
      return { claimed: true, run: claimed };
    }),
    completeRun: vi.fn(),
    failRun: vi.fn(),
    failRunIfStillStale: vi.fn(async (
      runId: string,
      _caseId: string,
      error: string,
      isStillStale: (run: Run) => boolean,
    ) => {
      order.push('fail_old');
      const index = runRows.findIndex((run) => run.run_id === runId);
      const run = runRows[index];
      if (!run || !isStillStale(run)) return { failed: false, run: run ?? null };
      const failed = { ...run, status: 'failed' as const, error_message: error };
      runRows[index] = failed;
      return { failed: true, run: failed };
    }),
    emitEvent: vi.fn(async (
      caseId: string,
      type: CaseEvent['type'],
      payload: Record<string, unknown>,
      actorId: string,
    ) => {
      events.push({
        event_id: `event_${events.length + 1}`,
        case_id: caseId,
        type,
        actor_id: actorId,
        payload,
        created_at: NOW.toISOString(),
      });
    }),
    getActiveRuns: vi.fn(async () => []),
    createAutoApproveDecision: vi.fn(),
    closeOutstandingWaiverProposals: vi.fn(async () => ({ closed: 0 })),
    createMergeNotApplicableDecision: vi.fn(),
    getProjectLifecycleProfile: vi.fn(),
    scheduleRunRetry: vi.fn(async () => {}),
    claimRunRetryDispatch: vi.fn(async () => null),
  } as unknown as RunSweepAdapter & {
    createUnclaimedRun: ReturnType<typeof vi.fn>;
    failRunIfStillStale: ReturnType<typeof vi.fn>;
  };

  const pipeline = {
    handleRunFailure: vi.fn(async () => {}),
    dispatchScheduledRetry: vi.fn(async () => 'already_claimed' as const),
    documentAssistantTerminalFailure: vi.fn(async () => {
      order.push('document_terminal_failure');
    }),
    onRunCompleted: vi.fn(async () => {
      order.push('reevaluate');
      return {};
    }),
    settleAssistantFailureRepair: vi.fn(async () => {
      order.push('settle_failure_repair');
    }),
  } as unknown as RunCompletionHandler;

  const executor = { dispatch: vi.fn() } as unknown as RunExecutor;
  return {
    adapter,
    pipeline,
    service: new RunSweepService(adapter, pipeline, executor),
    getCase: () => case_,
    getOrder: () => order,
  };
}

describe('RunSweepService assistant claim review fixes', () => {
  beforeEach(() => {
    runRows = [];
    vi.clearAllMocks();
  });

  it('documents exhausted retries as terminal before reevaluation and preserves assistant context', async () => {
    runRows = [makeRun(3)];
    const harness = makeService();

    await harness.service.sweep(NOW);

    expect(harness.getCase().assistant_context).toEqual(expect.objectContaining({
      channel: 'google_chat',
      prompt_version: 'prompt-v1',
    }));
    expect(harness.getCase().assistant_context?.wait_reason).toBeUndefined();
    expect(harness.pipeline.documentAssistantTerminalFailure).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 'run_a3', status: 'failed' }),
      'retry_exhausted',
    );
    expect(harness.getOrder()).toEqual([
      'fail_old',
      'document_terminal_failure',
      'reevaluate',
      'settle_failure_repair',
    ]);
  });

  it('creates a non-exhausting replacement before failure and does not set wait_reason', async () => {
    runRows = [makeRun(1)];
    const harness = makeService();

    await harness.service.sweep(NOW);

    expect(harness.getOrder().slice(0, 2)).toEqual(['create_replacement', 'fail_old']);
    expect(harness.pipeline.documentAssistantTerminalFailure).not.toHaveBeenCalled();
    expect(harness.getCase().assistant_context?.wait_reason).toBeUndefined();
  });

  it('keeps the expired run recoverable when replacement creation fails, then recovers it on the next sweep', async () => {
    runRows = [makeRun(1)];
    const harness = makeService({ failFirstCreate: true });

    await expect(harness.service.sweep(NOW)).rejects.toThrow('create failed');
    expect(runRows.find((run) => run.run_id === 'run_a1')?.status).toBe('running');
    expect(harness.adapter.failRunIfStillStale).not.toHaveBeenCalled();

    const second = await harness.service.sweep(NOW);

    expect(runRows.find((run) => run.run_id === 'run_a1')?.status).toBe('failed');
    expect(second.assistant.reattempted).toEqual([
      expect.objectContaining({
        run_id: 'run_a1',
        next_run_id: 'run_new_1',
        next_attempt: 2,
      }),
    ]);
  });
});
