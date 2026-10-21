import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Case,
  CaseEvent,
  CaseStatus,
  Evidence,
  EventType,
  Run,
  RunType,
} from '@arbitra/shared';
import { TRANSITION_MATRIX } from '@arbitra/shared';
import type { PipelineAdapter, RunClaimResult } from './pipeline-adapter.js';
import type { AssistantHoldWrite } from './assistant-hold-writer.js';
import type { AssistantRunOutcome, AssistantTaskRunner } from '../assistant/assistant-task-executor.js';
import { createPreconditionEvaluator, type PreconditionContext } from './preconditions.js';

/**
 * The composition that broke (issue #768): an assistant attempt
 * fails permanently, the run is marked `failed`, and the case has to end up
 * somewhere a human or the requester can see — instead of sitting in
 * `open`/`in_build` with no reachable transition, holding one of the
 * requester's active-task slots forever.
 *
 * Every unit involved was green when that happened. `RunExecutor`'s assistant
 * tests stub `handleRunFailure` and assert only that it was called; the hold
 * writer is tested against its own adapter; the only end-to-end coverage went
 * through the sweep. So these tests deliberately wire the REAL
 * `RunCompletionHandler` to the REAL `RunExecutor` over one in-memory adapter
 * and assert on the resulting case, not on call counts.
 */

vi.mock('../notification/notification-dispatcher.js', () => ({
  NotificationDispatcher: class {
    dispatch = vi.fn().mockResolvedValue(undefined);
  },
}));

const notifyMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../notification/notification-service.js', () => ({
  NotificationService: class {
    notify = notifyMock;
  },
}));

// `case-pipeline-lock.ts` and the evidence completeness evaluator both reach
// for Firestore. Same minimal doubles as `pipeline.test.ts`.
vi.mock('../../lib/firestore.js', () => {
  const lockStore = new Map<string, unknown>();
  interface FakeRef { __path: string }
  return {
    collections: {
      evidencePolicies: () => ({
        where: () => ({ get: vi.fn().mockResolvedValue({ empty: true, docs: [] }) }),
      }),
    },
    getDb: () => ({
      collection: (name: string) => ({ doc: (id: string): FakeRef => ({ __path: `${name}/${id}` }) }),
      runTransaction: async <T>(fn: (tx: {
        get(ref: FakeRef): Promise<{ exists: boolean; data: () => unknown }>;
        set(ref: FakeRef, data: unknown): void;
        delete(ref: FakeRef): void;
      }) => Promise<T>): Promise<T> =>
        fn({
          get: async (ref) => {
            const data = lockStore.get(ref.__path);
            return { exists: data !== undefined, data: () => data };
          },
          set: (ref, data) => { lockStore.set(ref.__path, data); },
          delete: (ref) => { lockStore.delete(ref.__path); },
        }),
    }),
  };
});

const { RunCompletionHandler } = await import('./pipeline.js');
const { RunExecutor } = await import('./run-executor.js');

const PERMANENT_FAILURE =
  'Assistant attempt stopped by the max_steps bound: the model still wanted to call tools after its last permitted step.';

function makeAssistantCase(status: CaseStatus): Case {
  return {
    case_id: 'case_assistant',
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
      space_name: 'spaces/one',
      conversation_visibility: 'direct',
      requester_user_id: 'usr_requester',
      risk_level: 'low',
      policy_version: 'assistant-policy:v1',
      prompt_version: 'assistant-system:v1',
    },
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-08-03T10:00:00.000Z',
    updated_at: '2026-08-03T10:00:00.000Z',
  };
}

function makeAssistantRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: 'run_a1',
    case_id: 'case_assistant',
    run_type: 'assistant_task_run',
    trigger_source: 'system:assistant-intake',
    status: 'running',
    worker_id: 'worker_1',
    attempt: 1,
    input_refs: [],
    output_refs: [],
    created_at: '2026-08-03T10:00:01.000Z',
    updated_at: '2026-08-03T10:00:01.000Z',
    ...overrides,
  };
}

interface Harness {
  adapter: PipelineAdapter;
  pipeline: InstanceType<typeof RunCompletionHandler>;
  getCase(): Case;
  events(): CaseEvent[];
  eventTypes(): EventType[];
  runs(): Run[];
  statusWrites(): CaseStatus[];
  repairMarkers(): Record<string, boolean>;
}

/**
 * In-memory adapter with the real write semantics that matter here: `failRun`
 * makes the run terminal and drops its lease, the hold write lands both halves
 * together, and the repair marker is a real per-run field the assertions read.
 */
function makeHarness(
  initialCase: Case,
  options: { failHoldWrite?: boolean; runs?: Run[]; evidence?: Evidence[] } = {},
): Harness {
  let case_ = { ...initialCase };
  const runs: Run[] = [...(options.runs ?? [makeAssistantRun()])];
  const events: CaseEvent[] = [];
  const statusWrites: CaseStatus[] = [];
  const repairMarkers: Record<string, boolean> = {};
  let eventSeq = 0;

  function nextTimestamp(): string {
    eventSeq += 1;
    return new Date(Date.parse('2026-08-03T10:10:00.000Z') + eventSeq * 1000).toISOString();
  }

  function updateRun(runId: string, updates: Partial<Run>): Run {
    const index = runs.findIndex((run) => run.run_id === runId);
    if (index === -1) throw new Error(`Unknown run ${runId}`);
    const updated = { ...runs[index]!, ...updates };
    runs[index] = updated;
    return updated;
  }

  const adapter: PipelineAdapter = {
    getCase: async () => case_,
    updateCaseStatus: async (_caseId: string, status: CaseStatus) => {
      statusWrites.push(status);
      case_ = { ...case_, status };
      return case_;
    },
    updateCase: async (_caseId: string, updates: Partial<Case>) => {
      case_ = { ...case_, ...updates };
      return case_;
    },
    loadPreconditionContext: async (): Promise<PreconditionContext> => ({
      case_,
      runs: [...runs],
      findings: [],
      ruleResults: [],
      evidence: options.evidence ?? [],
      decisions: [],
      events: [...events],
      actorId: 'system',
    }),
    createRun: async (caseId: string, runType: RunType, triggerSource: string) => {
      const run = makeAssistantRun({
        run_id: `run_created_${runs.length + 1}`,
        case_id: caseId,
        run_type: runType,
        trigger_source: triggerSource,
        status: 'pending',
      });
      runs.push(run);
      return run;
    },
    completeRun: async (runId: string, _caseId: string, summary: string) =>
      updateRun(runId, {
        status: 'completed',
        summary,
        lease_expires_at: undefined,
        worker_id: undefined,
      }),
    failRun: async (runId: string, _caseId: string, error: string) =>
      updateRun(runId, {
        status: 'failed',
        error_message: error,
        finished_at: nextTimestamp(),
        lease_expires_at: undefined,
        worker_id: undefined,
      }),
    claimRun: async (runId: string, workerId: string): Promise<RunClaimResult> => ({
      claimed: true,
      run: updateRun(runId, { status: 'running', worker_id: workerId, awaiting_claim: undefined }),
    }),
    documentAssistantHold: async (
      caseId: string,
      hold: AssistantHoldWrite,
      event: { type: EventType; payload: Record<string, unknown> },
      actorId: string,
    ) => {
      if (options.failHoldWrite) throw new Error('firestore unavailable');
      case_ = {
        ...case_,
        assistant_context: {
          ...case_.assistant_context!,
          wait_reason: hold.wait_reason,
          wait_run_id: hold.run_id,
          wait_attempt: hold.attempt,
        },
      };
      events.push({
        event_id: `evt_${events.length + 1}`,
        case_id: caseId,
        type: event.type,
        actor_id: actorId,
        payload: event.payload,
        created_at: nextTimestamp(),
      });
    },
    markAssistantFailureRepairPending: async (runId: string) => {
      repairMarkers[runId] = true;
    },
    clearAssistantFailureRepairPending: async (runId: string) => {
      delete repairMarkers[runId];
    },
    emitEvent: async (
      caseId: string,
      type: EventType,
      payload: Record<string, unknown>,
      actorId: string,
    ) => {
      events.push({
        event_id: `evt_${events.length + 1}`,
        case_id: caseId,
        type,
        actor_id: actorId,
        payload,
        created_at: nextTimestamp(),
      });
    },
    getActiveRuns: async () =>
      runs.filter((run) => run.status === 'pending' || run.status === 'running'),
    createAutoApproveDecision: async () => {
      throw new Error('not expected on the assistant lifecycle');
    },
    closeOutstandingWaiverProposals: async () => ({ closed: 0 }),
    createMergeNotApplicableDecision: async () => {
      throw new Error('not expected on the assistant lifecycle');
    },
    getProjectLifecycleProfile: async () => undefined,
    scheduleRunRetry: async () => {},
    claimRunRetryDispatch: async () => null,
  };

  return {
    adapter,
    pipeline: new RunCompletionHandler(adapter),
    getCase: () => case_,
    events: () => [...events],
    eventTypes: () => events.map((event) => event.type),
    runs: () => [...runs],
    statusWrites: () => [...statusWrites],
    repairMarkers: () => ({ ...repairMarkers }),
  };
}

/** A runner whose attempt always ends in a permanently-classified failure. */
function failingRunner(message = PERMANENT_FAILURE): AssistantTaskRunner {
  return {
    run: async (): Promise<AssistantRunOutcome> => ({ outcome: 'failed', message }),
  };
}

/**
 * Drive one attempt exactly as production does: `RunExecutor.execute` fails the
 * run, hands it to `handleRunFailure`, then re-evaluates the case. `dispatch`
 * defers through `setImmediate`, so the test awaits the same private path the
 * dispatcher would.
 */
async function runOneAttempt(harness: Harness, run: Run): Promise<void> {
  const executor = new RunExecutor(harness.adapter, harness.pipeline, failingRunner());
  await (executor as unknown as {
    execute(run: Run, case_: Case): Promise<void>;
  }).execute(run, harness.getCase());
}

describe('assistant terminal failure — case reaches rejected from every non-terminal status', () => {
  beforeEach(() => {
    notifyMock.mockClear();
  });

  // `open` is not a corner case: the transition to `in_build` is step 4 of the
  // executor, and every check before it (missing/empty/oversized input, an
  // unknown or non-member requester) fails with the case still `open`.
  it.each<CaseStatus>(['open', 'in_build'])(
    'rejects a case whose assistant attempt failed permanently in %s',
    async (status) => {
      const harness = makeHarness(makeAssistantCase(status));

      await runOneAttempt(harness, harness.runs()[0]!);

      expect(harness.getCase().status).toBe('rejected');
      expect(harness.statusWrites()).toEqual(['rejected']);
      expect(harness.runs()[0]).toMatchObject({
        status: 'failed',
        error_message: PERMANENT_FAILURE,
      });
      expect(harness.getCase().assistant_context).toMatchObject({
        wait_reason: 'failed_permanently',
        wait_run_id: 'run_a1',
        wait_attempt: 1,
      });
      expect(harness.eventTypes()).toEqual([
        'run_started',
        'run_failed',
        'assistant_task_abandoned',
        'case_rejected',
      ]);
      expect(
        harness.events().find((event) => event.type === 'assistant_task_abandoned')?.payload,
      ).toMatchObject({
        run_id: 'run_a1',
        run_type: 'assistant_task_run',
        attempt: 1,
        error: PERMANENT_FAILURE,
      });
      // The marker exists only for the window in which the repair is
      // outstanding — a repair that landed must not leave sweep work behind.
      expect(harness.repairMarkers()).toEqual({});
    },
  );

  it('keeps the repair marker set when the hold write fails, so the sweep retries', async () => {
    const harness = makeHarness(makeAssistantCase('in_build'), { failHoldWrite: true });
    // The swallowed error is the point of this test; keep it out of the report.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runOneAttempt(harness, harness.runs()[0]!);

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();

    // The original failure is not masked, and the case has not moved.
    expect(harness.runs()[0]).toMatchObject({ status: 'failed' });
    expect(harness.getCase().status).toBe('in_build');
    expect(harness.getCase().assistant_context?.wait_reason).toBeUndefined();
    expect(harness.repairMarkers()).toEqual({ run_a1: true });
  });

  it('does not write a hold when the durable repair marker cannot be written', async () => {
    const harness = makeHarness(makeAssistantCase('in_build'));
    harness.adapter.markAssistantFailureRepairPending = async () => {
      throw new Error('firestore unavailable');
    };
    const failed = await harness.adapter.failRun('run_a1', 'case_assistant', PERMANENT_FAILURE);
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await harness.pipeline.documentAssistantTerminalFailure(failed)).toBe('failed');
    logged.mockRestore();

    // Reverting the early return after the marker failure is the one change
    // that would make these assertions fail and recreate #774's P1 wedge.
    expect(harness.getCase().assistant_context?.wait_reason).toBeUndefined();
    expect(harness.eventTypes()).not.toContain('assistant_task_abandoned');
    expect(harness.repairMarkers()).toEqual({});
  });

  it('does not re-document or re-emit for a case that already carries the verdict', async () => {
    const harness = makeHarness(makeAssistantCase('in_build'));
    await runOneAttempt(harness, harness.runs()[0]!);
    const eventsAfterFirstRepair = harness.eventTypes();

    // What the sweep's backstop does for a marker whose clear never landed.
    await harness.pipeline.documentAssistantTerminalFailure(harness.runs()[0]!);

    expect(harness.eventTypes()).toEqual(eventsAfterFirstRepair);
    expect(harness.repairMarkers()).toEqual({});
  });

  it('leaves a rejected case alone — the terminal-failure edge lands in a sink', async () => {
    const harness = makeHarness(makeAssistantCase('in_build'));
    await runOneAttempt(harness, harness.runs()[0]!);
    const eventsAfterRepair = harness.eventTypes();

    for (let i = 0; i < 3; i += 1) {
      const result = await harness.pipeline.onRunCompleted('case_assistant');
      expect(result.transitions).toEqual([]);
      expect(result.final_status).toBe('rejected');
    }

    expect(harness.statusWrites()).toEqual(['rejected']);
    expect(harness.eventTypes()).toEqual(eventsAfterRepair);
  });

  it('does not revive a legacy retry-exhausted case after a courtroom approval', async () => {
    const parked = makeAssistantCase('needs_human_decision');
    const harness = makeHarness(
      {
        ...parked,
        assistant_context: {
          ...parked.assistant_context!,
          wait_reason: 'retry_exhausted',
          wait_run_id: 'run_a1',
          wait_attempt: 3,
        },
      },
      {
        runs: [makeAssistantRun({ status: 'failed', attempt: 3, error_message: 'ETIMEDOUT' })],
      },
    );
    await harness.adapter.emitEvent(
      'case_assistant',
      'run_retries_exhausted',
      { run_id: 'run_a1', attempts: 3 },
      'system:pipeline',
    );
    // The courtroom is the only human surface for this status, and an approve
    // decision is the only resume key it produces.
    await harness.adapter.emitEvent(
      'case_assistant',
      'decision_created',
      { type: 'approve' },
      'usr_reviewer',
    );

    const result = await harness.pipeline.onRunCompleted('case_assistant');

    // Re-introducing the deleted assistant resume edge is the only matrix
    // change that makes this fail. An approval cannot manufacture a new Run.
    expect(result.transitions).toEqual([]);
    expect(result.final_status).toBe('needs_human_decision');
    expect(harness.statusWrites()).toEqual([]);
  });

  /**
   * The window the repair marker exists for. `documentAssistantTerminalFailure`
   * does not drive the transition — its caller does, one statement later — so
   * clearing the marker on the write would leave the #768 state (non-terminal
   * case, hold written, no marker) whenever that statement does not run: a dead
   * instance, a throwing evaluation, a held pipeline lock.
   */
  it('keeps the repair marker set until the case is observed terminal', async () => {
    const harness = makeHarness(makeAssistantCase('in_build'));
    const failed = await harness.adapter.failRun(
      'run_a1',
      'case_assistant',
      PERMANENT_FAILURE,
    );

    expect(await harness.pipeline.documentAssistantTerminalFailure(failed)).toBe('documented');

    expect(harness.getCase().status).toBe('in_build');
    expect(harness.getCase().assistant_context).toMatchObject({
      wait_reason: 'failed_permanently',
      wait_run_id: 'run_a1',
    });
    expect(harness.repairMarkers()).toEqual({ run_a1: true });

    // Whoever drives the transition then discharges the marker — and only then.
    await harness.pipeline.onRunCompleted('case_assistant');
    expect(await harness.pipeline.settleAssistantFailureRepair(failed)).toBe(true);
    expect(harness.getCase().status).toBe('rejected');
    expect(harness.repairMarkers()).toEqual({});
  });

  it('does not settle the repair while the case is still non-terminal', async () => {
    const harness = makeHarness(makeAssistantCase('in_build'));
    const failed = await harness.adapter.failRun(
      'run_a1',
      'case_assistant',
      PERMANENT_FAILURE,
    );
    await harness.pipeline.documentAssistantTerminalFailure(failed);

    // No `onRunCompleted` in between: this is the crash/lock-loss window.
    expect(await harness.pipeline.settleAssistantFailureRepair(failed)).toBe(false);
    expect(harness.repairMarkers()).toEqual({ run_a1: true });
  });

  it('does not document a terminal verdict in a status with no terminal-failure edge', async () => {
    const harness = makeHarness(makeAssistantCase('needs_human_decision'));
    const failed = await harness.adapter.failRun('run_a1', 'case_assistant', PERMANENT_FAILURE);

    expect(await harness.pipeline.documentAssistantTerminalFailure(failed)).toBe('settled');

    expect(harness.getCase().status).toBe('needs_human_decision');
    expect(harness.getCase().assistant_context?.wait_reason).toBeUndefined();
    expect(harness.eventTypes()).not.toContain('assistant_task_abandoned');
    expect(harness.repairMarkers()).toEqual({});
  });

  /**
   * `writeAssistantHold`'s sequential fallback (any adapter without the
   * transactional `documentAssistantHold`) can land the case write and then fail
   * the event write. Keying "already documented" on the case fields alone would
   * make the re-drive a no-op and clear the marker, leaving a hold that no event
   * documents — `assistant_hold_documented` excludes `failed_permanently` and
   * `assistant_terminal_failure_documented` needs the event, so the case would
   * have no satisfiable edge and nothing left to find it by.
   */
  it('re-emits the documenting event for a hold whose case write landed alone', async () => {
    const harness = makeHarness(makeAssistantCase('in_build'));
    delete (harness.adapter as { documentAssistantHold?: unknown }).documentAssistantHold;
    const emitEvent = harness.adapter.emitEvent.bind(harness.adapter);
    let failNextEmit = true;
    harness.adapter.emitEvent = async (caseId, type, payload, actorId) => {
      if (failNextEmit) {
        failNextEmit = false;
        throw new Error('firestore unavailable');
      }
      return emitEvent(caseId, type, payload, actorId);
    };
    const failed = await harness.adapter.failRun('run_a1', 'case_assistant', PERMANENT_FAILURE);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await harness.pipeline.documentAssistantTerminalFailure(failed)).toBe('failed');
    expect(harness.getCase().assistant_context?.wait_reason).toBe('failed_permanently');
    expect(harness.eventTypes()).not.toContain('assistant_task_abandoned');
    expect(harness.repairMarkers()).toEqual({ run_a1: true });

    // What the sweep re-drives. The missing half must still be written.
    expect(await harness.pipeline.documentAssistantTerminalFailure(failed)).toBe('documented');
    logged.mockRestore();

    expect(
      harness.eventTypes().filter((type) => type === 'assistant_task_abandoned'),
    ).toHaveLength(1);
    await harness.pipeline.onRunCompleted('case_assistant');
    expect(harness.getCase().status).toBe('rejected');
  });
});

describe('assistant terminal failure — blast radius', () => {
  beforeEach(() => {
    notifyMock.mockClear();
  });

  it('leaves a non-assistant run\'s permanent failure exactly as it was', async () => {
    const case_ = {
      ...makeAssistantCase('in_build'),
      case_type: 'bugfix' as const,
      assistant_context: undefined,
    };
    const ruleRun = makeAssistantRun({
      run_id: 'run_rule_1',
      run_type: 'rule_run',
      status: 'failed',
      error_message: 'No executor for run type: build_run',
    });
    const harness = makeHarness(case_, { runs: [ruleRun] });

    await harness.pipeline.handleRunFailure(harness.runs()[0]!);

    // No hold, no marker, no event, no status change: a permanent failure on
    // any other run type still "just stands".
    expect(harness.getCase().assistant_context).toBeUndefined();
    expect(harness.getCase().status).toBe('in_build');
    expect(harness.repairMarkers()).toEqual({});
    expect(harness.eventTypes()).toEqual([]);
    expect(harness.statusWrites()).toEqual([]);
  });

  it('has no assistant hold or resume edges in the live transition matrix', () => {
    const assistantEdges = TRANSITION_MATRIX.filter(
      (transition) => transition.case_types?.includes('assistant_task'),
    );

    // Adding either deleted edge is the only matrix change that makes this
    // regression fail: Clerk follow-ups are new Cases, not lifecycle resumes.
    expect(assistantEdges).not.toContainEqual(expect.objectContaining({
      to: 'needs_human_decision',
      auto_trigger: true,
    }));
    expect(assistantEdges).not.toContainEqual(expect.objectContaining({
      from: 'needs_human_decision',
      to: 'in_build',
    }));
  });

  /**
   * The other pair of auto edges out of `in_build`. `tryAutoTransition` takes
   * the FIRST satisfied candidate, so two different notions of "the latest
   * assistant attempt" would let `done` and `rejected` both hold and let matrix
   * order decide which one a case gets. Unreachable while nothing creates an
   * `assistant_action_run`; pinned so it stays unreachable once something does.
   */
  it('never lets the result edge and the terminal-failure edge be satisfiable together', async () => {
    const case_ = makeAssistantCase('in_build');
    const completedTaskRun = makeAssistantRun({
      run_id: 'run_t1',
      status: 'completed',
      created_at: '2026-08-03T10:00:01.000Z',
    });
    const failedActionRun = makeAssistantRun({
      run_id: 'run_x1',
      run_type: 'assistant_action_run',
      status: 'failed',
      error_message: PERMANENT_FAILURE,
      created_at: '2026-08-03T10:05:00.000Z',
    });
    const ctx: PreconditionContext = {
      case_: {
        ...case_,
        assistant_context: {
          ...case_.assistant_context!,
          wait_reason: 'failed_permanently',
          wait_run_id: 'run_x1',
          wait_attempt: 1,
        },
      },
      runs: [completedTaskRun, failedActionRun],
      findings: [],
      ruleResults: [],
      evidence: [
        {
          evidence_id: 'ev_1',
          case_id: case_.case_id,
          run_id: 'run_t1',
          type: 'task_result',
          source_type: 'agent',
          artifact_ref: 'gs://demo-arbitra-artifacts/case_assistant/result.md',
          machine_readable: true,
          validation_track: 'direct',
          created_at: '2026-08-03T10:01:00.000Z',
          created_by: 'system:assistant',
        },
      ],
      decisions: [],
      events: [
        {
          event_id: 'evt_1',
          case_id: case_.case_id,
          type: 'assistant_task_abandoned',
          actor_id: 'system:pipeline',
          payload: { run_id: 'run_x1' },
          created_at: '2026-08-03T10:06:00.000Z',
        },
      ],
      actorId: 'system:pipeline',
    };

    const evaluator = createPreconditionEvaluator(ctx);
    const done = await evaluator.evaluate('assistant_result_evidence_present');
    const rejected = await evaluator.evaluate('assistant_terminal_failure_documented');

    expect([done.satisfied, rejected.satisfied].filter(Boolean)).toHaveLength(1);
    // The newest attempt failed, so the terminal verdict is the one that counts.
    expect(rejected.satisfied).toBe(true);
  });

  it('ignores a terminal verdict left over from an earlier attempt', async () => {
    const case_ = makeAssistantCase('in_build');
    const staleVerdictCase: Case = {
      ...case_,
      assistant_context: {
        ...case_.assistant_context!,
        wait_reason: 'failed_permanently',
        wait_run_id: 'run_a1',
        wait_attempt: 1,
      },
    };
    const harness = makeHarness(staleVerdictCase, {
      runs: [
        makeAssistantRun({ status: 'failed', error_message: PERMANENT_FAILURE }),
        // A newer attempt is live — the old verdict no longer describes the case.
        makeAssistantRun({
          run_id: 'run_a2',
          attempt: 2,
          status: 'running',
          created_at: '2026-08-03T10:05:00.000Z',
        }),
      ],
    });
    await harness.adapter.emitEvent(
      'case_assistant',
      'assistant_task_abandoned',
      { run_id: 'run_a1' },
      'system:pipeline',
    );

    const result = await harness.pipeline.onRunCompleted('case_assistant');

    expect(result.transitions).toEqual([]);
    expect(harness.getCase().status).toBe('in_build');
  });
});
