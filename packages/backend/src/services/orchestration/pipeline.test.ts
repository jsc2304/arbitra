import { describe, it, expect, vi } from 'vitest';
import { RunCompletionHandler, type PipelineResult } from './pipeline.js';
import type { PipelineAdapter, ResolveAndRunReviewResult } from './pipeline-adapter.js';
import type { Case, Run, CaseStatus, RunType, EventType } from '@arbitra/shared';
import type { PreconditionContext } from './preconditions.js';

// Stub NotificationDispatcher so dispatch() is a no-op. The pipeline constructs
// one internally (`new NotificationDispatcher()`) and calls `dispatch()` on every
// transition into a human-gate status. Without this stub the real implementation
// runs, hits the Firestore mock below (which has no `collections.projects`), and
// spams stderr with `[NotificationDispatcher] Failed to load project proj_test`.
// Exposed as `dispatchMock` (mirrors `notifyMock` below) so the needs-decision
// path can assert an actual call instead of only relying on the no-op keeping
// output clean (#208) — a dropped `dispatchTransitionNotification` call used to
// be invisible to this suite.
const dispatchMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../notification/notification-dispatcher.js', () => ({
  NotificationDispatcher: class {
    dispatch = dispatchMock;
  },
}));

// Stub NotificationService the same way — `handleRunFailure`'s exhaustion
// path and `scheduleRunTimeoutCheck` both call
// `this.notificationService.notify(...)`. The real implementation would hit
// `collections.notifications()`, which the Firestore mock below doesn't
// stub. Exposed as `notifyMock` so retry/exhaustion tests can assert on it.
const notifyMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../notification/notification-service.js', () => ({
  NotificationService: class {
    notify = notifyMock;
  },
}));

// Mock Firestore (required by CompletenessEvaluator used in preconditions,
// and by `case-pipeline-lock.ts`'s `getDb()`-based transaction lock that
// `onRunCompleted` now acquires).
// The resolver uses a single deterministic chain: where('project_id','==',...).get().
vi.mock('../../lib/firestore.js', () => {
  const whereNode = { get: vi.fn().mockResolvedValue({ empty: true, docs: [] }) };

  // Minimal in-memory Firestore double for `case-pipeline-lock.ts`: supports
  // collection().doc() refs plus a runTransaction(tx.get/set/delete) surface.
  // Transactions are serialized (FIFO) via a promise chain to mirror
  // Firestore's commit ordering for a single contended lock document — the
  // same technique used in `firestore-pipeline-adapter.test.ts`. Sufficient
  // for the concurrency assertions in this suite.
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

  return {
    collections: {
      evidencePolicies: () => ({
        where: () => whereNode,
      }),
    },
    getDb: () => fakeDb,
  };
});

// ── Test helpers ─────────────────────────────────────────────────────

// Default commit both `makeCase()` and a `makeRun({ run_type: 'review_run' })`
// carry (issue #1054): pre-existing tests in this file build a case and a
// review_run independently and neither mentioned commit identity before this
// field existed, so the two defaults must agree or every one of them needs
// an explicit override just to keep testing what it always tested. A test
// that cares about a MISMATCH (or an absent `current_head_sha`) overrides
// one side explicitly — see the "approval pin" and "commit binding" blocks.
const DEFAULT_HEAD_SHA = 'sha_default_head';

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
    status: 'open',
    decision_ready: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    current_head_sha: DEFAULT_HEAD_SHA,
    ...overrides,
  } as Case;
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: 'run_test',
    case_id: 'case_test',
    run_type: 'exploration_run',
    trigger_source: 'system',
    status: 'completed',
    input_refs: [],
    output_refs: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...(overrides.run_type === 'review_run' ? { reviewed_head_sha: DEFAULT_HEAD_SHA } : {}),
    ...overrides,
  };
}

function makeAdapter(initialCase: Case, context?: Partial<PreconditionContext>, lifecycleProfile?: import('@arbitra/shared').LifecycleProfile): PipelineAdapter & { transitions: Array<{ caseId: string; status: CaseStatus }>; events: Array<{ type: EventType }> } {
  let currentCase = { ...initialCase };
  const transitions: Array<{ caseId: string; status: CaseStatus }> = [];
  const events: Array<{ type: EventType }> = [];

  return {
    transitions,
    events,
    getCase: vi.fn(async () => currentCase),
    updateCaseStatus: vi.fn(async (
      _caseId: string,
      status: CaseStatus,
      extraUpdates: Partial<Case> = {},
    ) => {
      transitions.push({ caseId: _caseId, status });
      // `extraUpdates` must be applied, not dropped: it is how the approval
      // pin (issue #1045) reaches the document on this path. A fake that
      // ignored it would let an unpinned approval pass unnoticed — which is
      // exactly how the pipeline routes escaped the first cut of that fix.
      currentCase = { ...currentCase, ...extraUpdates, status };
      return currentCase;
    }),
    updateCase: vi.fn(async (_caseId: string, updates: Partial<Case>) => {
      currentCase = { ...currentCase, ...updates };
      return currentCase;
    }),
    loadPreconditionContext: vi.fn(async (case_: Case) => ({
      case_: currentCase,
      runs: context?.runs ?? [],
      findings: context?.findings ?? [],
      ruleResults: context?.ruleResults ?? [],
      evidence: context?.evidence ?? [],
      decisions: context?.decisions ?? [],
      events: context?.events ?? [],
      actorId: 'system',
    })),
    createRun: vi.fn(async (_caseId: string, runType: RunType) => makeRun({ run_type: runType })),
    completeRun: vi.fn(async () => makeRun()),
    failRun: vi.fn(async () => makeRun({ status: 'failed' })),
    createAutoApproveDecision: vi.fn(async () => ({ decision_id: 'dec_auto', case_id: 'case_test', type: 'auto_approve', actor_id: 'system', rationale: 'Auto-approved', snapshot: {}, created_at: '2026-01-01T00:00:00Z' })),
    closeOutstandingWaiverProposals: vi.fn(async () => ({ closed: 0 })),
    createMergeNotApplicableDecision: vi.fn(async () => ({ decision_id: 'dec_mna', case_id: 'case_test', type: 'merge_not_applicable', actor_id: 'system:pipeline', rationale: 'Auto-attached on approval: no PR and no branch', snapshot: {}, created_at: '2026-01-01T00:00:00Z' })),
    emitEvent: vi.fn(async (_caseId: string, type: EventType) => {
      events.push({ type });
    }),
    getActiveRuns: vi.fn(async () => []),
    getProjectLifecycleProfile: vi.fn(async () => lifecycleProfile),
    scheduleRunRetry: vi.fn(async () => {}),
    claimRunRetryDispatch: vi.fn(async () => null),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('RunCompletionHandler', () => {
  describe('onRunCompleted — no auto-transition possible', () => {
    it('should not transition from open (requires human triage)', async () => {
      const case_ = makeCase({ status: 'open' });
      const adapter = makeAdapter(case_);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(0);
      expect(result.final_status).toBe('open');
      expect(adapter.updateCaseStatus).not.toHaveBeenCalled();
    });

    it('should not transition from ready_for_build (developer must start)', async () => {
      const case_ = makeCase({ status: 'ready_for_build' });
      const adapter = makeAdapter(case_);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(0);
      expect(result.final_status).toBe('ready_for_build');
    });

    it('should not transition from needs_human_decision (human gate)', async () => {
      const case_ = makeCase({ status: 'needs_human_decision' });
      const adapter = makeAdapter(case_);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(0);
      expect(result.final_status).toBe('needs_human_decision');
    });

    it('should not transition from verification_pending (manual gate)', async () => {
      const case_ = makeCase({ status: 'verification_pending' });
      const adapter = makeAdapter(case_);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(0);
      expect(result.final_status).toBe('verification_pending');
    });
  });

  describe('onRunCompleted — single auto-transition', () => {
    it('should transition exploration → ready_for_build when exploration_run completed', async () => {
      const case_ = makeCase({ status: 'exploration' });
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'exploration_run', status: 'completed' })],
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0]).toEqual({ from: 'exploration', to: 'ready_for_build' });
      expect(result.final_status).toBe('ready_for_build');
    });

    it('should NOT transition exploration → ready_for_build without completed run', async () => {
      const case_ = makeCase({ status: 'exploration' });
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'exploration_run', status: 'running' })],
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(0);
      expect(result.final_status).toBe('exploration');
    });

    it('should transition in_build → in_validation when branch is set and evidence is satisfied', async () => {
      const case_ = makeCase({ status: 'in_build', current_branch: 'feat/test' });
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'build_run', status: 'completed' })],
        evidence: [
          {
            evidence_id: 'ev_1',
            case_id: 'case_test',
            type: 'ci_result',
            source_type: 'automated',
            summary: 'CI green',
            machine_readable: true,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          } as any,
        ],
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions.length).toBeGreaterThanOrEqual(1);
      expect(result.transitions[0]).toEqual({ from: 'in_build', to: 'in_validation' });
    });
  });

  describe('onRunCompleted — in_review branching', () => {
    it('should auto-approve when no high/critical findings and rules pass', async () => {
      const case_ = makeCase({ status: 'in_review', validation_track: 'direct' });
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'review_run', status: 'completed' })],
        findings: [], // no findings
        ruleResults: [], // no failing rules
        decisions: [{ type: 'auto_approve', actor_id: 'system' }] as any,
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      // Should transition: in_review → approved → pending_merge (chain)
      expect(result.transitions.length).toBeGreaterThanOrEqual(1);
      expect(result.transitions[0]).toEqual({ from: 'in_review', to: 'approved' });
    });

    it('should transition to needs_human_decision when high findings exist', async () => {
      // Pre-fix, `dispatchTransitionNotification` was stubbed to a blanket
      // no-op and never asserted on — a dropped call here would have gone
      // unnoticed. Reverting `dispatchTransitionNotification`'s
      // `case 'needs_human_decision':` branch in `pipeline.ts` (or the
      // `executeTransition` call to it) would fail the `dispatchMock`
      // assertion below.
      const case_ = makeCase({ status: 'in_review', validation_track: 'direct' });
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'review_run', status: 'completed' })],
        findings: [
          { finding_id: 'f1', severity: 'high', status: 'open', category: 'bug' } as any,
        ],
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0]).toEqual({ from: 'in_review', to: 'needs_human_decision' });
      expect(result.final_status).toBe('needs_human_decision');
      expect(dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'case_needs_decision',
          case_: expect.objectContaining({ case_id: 'case_test' }),
        }),
      );
    });

    it('should transition Direct Track high-risk to needs_human_decision even with no high findings', async () => {
      // Regression guard for the auto-approve risk gate: a high-risk case must
      // always land in the human-decision path, even when the LLM produced only
      // low-severity findings. Without this, the case would auto-approve with
      // zero human involvement.
      const case_ = makeCase({ status: 'in_review', validation_track: 'direct', risk_level: 'high' });
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'review_run', status: 'completed' })],
        findings: [], // no high/critical findings
        ruleResults: [],
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0]).toEqual({ from: 'in_review', to: 'needs_human_decision' });
      expect(result.final_status).toBe('needs_human_decision');
    });

    it('should transition Direct Track critical-risk to needs_human_decision even with no high findings', async () => {
      const case_ = makeCase({ status: 'in_review', validation_track: 'direct', risk_level: 'critical' });
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'review_run', status: 'completed' })],
        findings: [],
        ruleResults: [],
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0]).toEqual({ from: 'in_review', to: 'needs_human_decision' });
    });

    it('should transition to verification_pending for manual track without high findings', async () => {
      const case_ = makeCase({ status: 'in_review', validation_track: 'manual' });
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'review_run', status: 'completed' })],
        findings: [
          { finding_id: 'f1', severity: 'low', status: 'open', category: 'maintainability_issue' } as any,
        ],
        ruleResults: [],
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0]).toEqual({ from: 'in_review', to: 'verification_pending' });
    });

    it.each(['high', 'critical'] as const)(
      'should still route manual track + %s risk (no high/critical findings) to verification_pending (#209)',
      async (riskLevel) => {
        // Regression guard (#209 case 4): the Manual Track route is gated by
        // `track_is_manual_and_no_high_critical`, which checks track + findings
        // only — NOT risk_level. The risk gate (`auto_approve_criteria_met`) and
        // the Direct-Track high-risk fallback (`track_is_direct_and_high_critical_risk`)
        // are direct-track concerns and must NOT divert a manual-track case into
        // needs_human_decision here. A high/critical manual-track case must still
        // land in verification_pending so the human gate is the
        // `four_eyes_if_required` check at verification_pending → approved, not an
        // earlier auto-route. This locks the path against a future edit that
        // accidentally couples manual-track routing to risk.
        const case_ = makeCase({
          status: 'in_review',
          validation_track: 'manual',
          risk_level: riskLevel,
        });
        const adapter = makeAdapter(case_, {
          runs: [makeRun({ run_type: 'review_run', status: 'completed' })],
          findings: [
            // low-severity only — no open high/critical findings
            { finding_id: 'f1', severity: 'low', status: 'open', category: 'maintainability_issue' } as any,
          ],
          ruleResults: [],
        });
        const handler = new RunCompletionHandler(adapter);

        const result = await handler.onRunCompleted('case_test');

        expect(result.transitions).toHaveLength(1);
        expect(result.transitions[0]).toEqual({ from: 'in_review', to: 'verification_pending' });
        expect(result.final_status).toBe('verification_pending');
      },
    );
  });


  // ── Approval pin on the two PIPELINE routes into `approved` (#1045) ──
  //
  // These drive a real approve through `RunCompletionHandler` rather than
  // constructing an already-`approved` case. That distinction is the whole
  // point: the first cut of the pin stamped it only in `transition-core.ts`
  // and every test passed, because every test built the end state instead of
  // reaching it. `lifecycle-presets.ts` sets `review_to_approved` to `auto`
  // in the autonomous and standard presets and `confirm` in strict, so BOTH
  // routes below are normal ways to approve — and neither touches the
  // transactional core.
  describe('approval pin — reached through a real approve (issue #1045)', () => {
    const APPROVABLE_CONTEXT = {
      // reviewed_head_sha matches the `current_head_sha: 'SHA_REVIEWED'` set
      // on the case in the tests below (issue #1054) — otherwise the
      // commit-binding gate blocks every one of these before it ever reaches
      // the approval-pin logic under test.
      runs: [makeRun({ run_type: 'review_run' as RunType, status: 'completed' as const, reviewed_head_sha: 'SHA_REVIEWED' })],
      findings: [],
      ruleResults: [],
      decisions: [{ type: 'auto_approve', actor_id: 'system' }] as never,
    };

    it('autonomous auto-approve (executeTransition) pins the observed head SHA', async () => {
      // Revert line: the `approvalPinPatch(...)` argument on
      // `adapter.updateCaseStatus` in `executeTransition`. Without it the
      // case reaches `approved` with `approved_head_sha: undefined`, and
      // `applyApprovalCommitPin` publishes a permanent red `arbitra/case`
      // that no re-review can clear.
      const case_ = makeCase({
        status: 'in_review',
        validation_track: 'direct',
        current_head_sha: 'SHA_REVIEWED',
      });
      const adapter = makeAdapter(case_, APPROVABLE_CONTEXT);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions[0]).toEqual({ from: 'in_review', to: 'approved' });
      expect((await adapter.getCase('case_test')).approved_head_sha).toBe('SHA_REVIEWED');
    });

    it('gate confirmation (executeGateConfirmation) pins the observed head SHA', async () => {
      // Revert line: the `...approvalPinPatch(...)` spread in
      // `executeGateConfirmation`'s `adapter.updateCase` call. This is the
      // strict preset's `review_to_approved: 'confirm'` route.
      const case_ = makeCase({
        status: 'in_review',
        validation_track: 'direct',
        current_head_sha: 'SHA_REVIEWED',
        pending_gate: {
          gate_id: 'review_to_approved',
          target_status: 'approved',
          since: '2026-01-01T00:00:00Z',
        },
      });
      const adapter = makeAdapter(case_, APPROVABLE_CONTEXT);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.executeGateConfirmation('case_test');

      // The confirmation reaches `approved` and the auto edges may chain on
      // from there; what matters is that the pin was stamped on the way in
      // and NOT re-stamped by the downstream edges.
      expect(result.final_status).not.toBe('in_review');
      expect((await adapter.getCase('case_test')).approved_head_sha).toBe('SHA_REVIEWED');
    });

    // Issue #1054 changed this test's premise: a case with NO observed head
    // SHA used to still auto-approve (the pin then cleared the stale value,
    // which is what this test originally proved). It can no longer reach
    // `approved` autonomously at all — `review_run_completed` /
    // `auto_approve_criteria_met` now fail closed when `current_head_sha`
    // is undefined, on the same reasoning documented on
    // `reviewRunCoversCurrentHead` (preconditions.ts): a case with no
    // observed head cannot reach a green `arbitra/case` today ANYWAY —
    // `applyApprovalCommitPin` already fails the check for an absent pin —
    // so blocking earlier costs nothing that wasn't already lost, and the
    // stale `approved_head_sha` this test seeded is left untouched because
    // no transition — and so no pin write — ever happens. The pure
    // clearing behavior this test used to cover through the full pipeline
    // is covered directly in `approval-pin.test.ts` instead.
    //
    // `current_pr_ref` is set explicitly (issue #1054 gap 1): the
    // fail-closed reasoning above holds only for a case that has a PR — a
    // no-PR case falls back to the pre-#1054 semantics instead
    // (`preconditions.test.ts`'s "no PR reference" describe blocks cover
    // that class), so this test must represent a genuine PR-bearing case to
    // keep proving what it says it proves.
    it('does NOT auto-approve with no observed head SHA — stays in_review (issue #1054)', async () => {
      const case_ = makeCase({
        status: 'in_review',
        validation_track: 'direct',
        current_pr_ref: 'owner/repo#42',
        current_head_sha: undefined,
        approved_head_sha: 'SHA_FROM_A_PREVIOUS_APPROVAL',
      });
      const adapter = makeAdapter(case_, APPROVABLE_CONTEXT);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(0);
      expect(result.final_status).toBe('in_review');
      // No transition happened, so the pin logic never ran — the stale
      // value is simply whatever it started as, not cleared and not
      // re-stamped.
      expect((await adapter.getCase('case_test')).approved_head_sha)
        .toBe('SHA_FROM_A_PREVIOUS_APPROVAL');
    });

    it('does NOT re-pin on the downstream approved → pending_merge edge', async () => {
      // Re-pinning there would advance the pin onto a commit pushed AFTER
      // the approval — the defect the pin exists to prevent.
      const case_ = makeCase({
        status: 'approved',
        current_head_sha: 'SHA_PUSHED_AFTER_APPROVAL',
        approved_head_sha: 'SHA_REVIEWED',
      });
      const adapter = makeAdapter(case_, {
        decisions: [{ type: 'approve', actor_id: 'usr_reviewer', created_at: '2026-01-01T00:00:00Z' }] as never,
      });
      const handler = new RunCompletionHandler(adapter);

      await handler.onRunCompleted('case_test');

      expect((await adapter.getCase('case_test')).approved_head_sha).toBe('SHA_REVIEWED');
    });
  });

  describe('onRunCompleted — concurrency (per-case pipeline lock)', () => {
    it('should produce exactly one transition + one auto-approve decision when two calls race for the same case', async () => {
      // Same setup as "should auto-approve when no high/critical findings and
      // rules pass" above — a case that's guaranteed to auto-transition on a
      // single call. Firing two `onRunCompleted` calls concurrently for the
      // SAME case_id simulates two of the ~15 real trigger sites completing
      // near-simultaneously (e.g. a webhook and a run-executor callback).
      // Without the per-case lock, both calls would read the same
      // pre-transition state, both pass preconditions, and both execute the
      // transition — duplicating the `auto_approve` decision/events. With the
      // lock, exactly one call wins the race; the other observes LOCK_HELD
      // and no-ops (transitions: []).
      const case_ = makeCase({ status: 'in_review', validation_track: 'direct' });
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'review_run', status: 'completed' })],
        findings: [],
        ruleResults: [],
        decisions: [{ type: 'auto_approve', actor_id: 'system' }] as any,
      });
      const handler = new RunCompletionHandler(adapter);

      const [resultA, resultB] = await Promise.all([
        handler.onRunCompleted('case_test'),
        handler.onRunCompleted('case_test'),
      ]);

      const results = [resultA, resultB];
      const withTransitions = results.filter((r) => r.transitions.length > 0);
      const withoutTransitions = results.filter((r) => r.transitions.length === 0);

      // Exactly one caller won the lock and drove the transition chain; the
      // other lost the race and no-op'd cleanly.
      expect(withTransitions).toHaveLength(1);
      expect(withoutTransitions).toHaveLength(1);
      expect(withTransitions[0]!.transitions[0]).toEqual({ from: 'in_review', to: 'approved' });

      // Exactly one auto-approve decision was attached — no duplicate from
      // the loser racing the same read-evaluate-write cycle.
      expect(adapter.createAutoApproveDecision).toHaveBeenCalledTimes(1);
    });
  });

  describe('onRunCompleted — chained transitions', () => {
    it('should chain approved → pending_merge when all_steps_completed (case has a PR ref)', async () => {
      const case_ = makeCase({ status: 'approved', current_pr_ref: 'owner/repo#42' });
      const adapter = makeAdapter(case_, {
        decisions: [{ type: 'auto_approve', actor_id: 'system' }] as any,
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0]).toEqual({ from: 'approved', to: 'pending_merge' });
      expect(result.final_status).toBe('pending_merge');
      // Merge gate untouched for cases WITH a PR — no auto-attached decision.
      expect(adapter.createMergeNotApplicableDecision).not.toHaveBeenCalled();
    });

    it('should chain pending_merge → done when pr_merged event exists', async () => {
      const case_ = makeCase({ status: 'pending_merge' });
      const adapter = makeAdapter(case_, {
        decisions: [{ type: 'auto_approve', actor_id: 'system' }] as any,
        events: [{ event_id: 'evt_1', case_id: 'case_test', type: 'pr_merged', actor_id: 'system', payload: {}, created_at: '2026-01-01T00:00:00Z' }] as any,
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0]).toEqual({ from: 'pending_merge', to: 'done' });
      expect(result.final_status).toBe('done');
    });

    it('should NOT transition pending_merge → done without pr_merged event', async () => {
      const case_ = makeCase({ status: 'pending_merge' });
      const adapter = makeAdapter(case_, {
        decisions: [{ type: 'auto_approve', actor_id: 'system' }] as any,
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(0);
      expect(result.final_status).toBe('pending_merge');
    });
  });

  describe('onRunCompleted — waiver cleanup on completion (issue #751)', () => {
    it('closes outstanding waiver proposals when a transition reaches done', async () => {
      const case_ = makeCase({ status: 'pending_merge' });
      const adapter = makeAdapter(case_, {
        decisions: [{ type: 'auto_approve', actor_id: 'system' }] as any,
        events: [{ event_id: 'evt_1', case_id: 'case_test', type: 'pr_merged', actor_id: 'system', payload: {}, created_at: '2026-01-01T00:00:00Z' }] as any,
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.final_status).toBe('done');
      expect(adapter.closeOutstandingWaiverProposals).toHaveBeenCalledTimes(1);
      expect(adapter.closeOutstandingWaiverProposals).toHaveBeenCalledWith('case_test');
    });

    it('does NOT close waiver proposals for a transition that does not reach done', async () => {
      const case_ = makeCase({ status: 'approved', current_pr_ref: 'owner/repo#42' });
      const adapter = makeAdapter(case_, {
        decisions: [{ type: 'auto_approve', actor_id: 'system' }] as any,
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.final_status).toBe('pending_merge');
      expect(adapter.closeOutstandingWaiverProposals).not.toHaveBeenCalled();
    });
  });

  describe('executeGateConfirmation — waiver cleanup on completion (issue #751)', () => {
    it('closes outstanding waiver proposals when a confirmed gate reaches done', async () => {
      const case_ = makeCase({
        status: 'pending_merge',
        pending_gate: {
          gate_id: 'pending_merge_to_done',
          target_status: 'done',
          since: '2026-01-01T00:00:00Z',
        },
      });
      // #1049: confirmation now re-evaluates preconditions for real, so the
      // `pr_merged` variant of pending_merge → done needs a `pr_merged`
      // event on record — matching what the webhook would have recorded
      // before a human ever sees the confirm button.
      const adapter = makeAdapter(case_, {
        events: [{ event_id: 'evt_1', case_id: 'case_test', type: 'pr_merged', actor_id: 'system', payload: {}, created_at: '2026-01-01T00:00:00Z' }] as any,
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.executeGateConfirmation('case_test');

      expect(result.final_status).toBe('done');
      expect(adapter.closeOutstandingWaiverProposals).toHaveBeenCalledTimes(1);
      expect(adapter.closeOutstandingWaiverProposals).toHaveBeenCalledWith('case_test');
    });

    it('does NOT close waiver proposals when the confirmed gate target is not done', async () => {
      const case_ = makeCase({
        status: 'approved',
        pending_gate: {
          gate_id: 'approved_to_pending_merge',
          target_status: 'pending_merge',
          since: '2026-01-01T00:00:00Z',
        },
      });
      // #1049: approved → pending_merge requires `all_steps_completed`
      // (an approve/auto_approve/manual_validation_confirmed decision).
      const adapter = makeAdapter(case_, {
        decisions: [{ type: 'approve', actor_id: 'usr_reviewer', created_at: '2026-01-01T00:00:00Z' }] as any,
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.executeGateConfirmation('case_test');

      expect(result.final_status).toBe('pending_merge');
      expect(adapter.closeOutstandingWaiverProposals).not.toHaveBeenCalled();
    });

    it('refuses and clears a stale gate whose marker no longer matches the case status (issue #1049 bypass leg)', async () => {
      // The case moved from in_review to in_build (e.g. via a case-level
      // Request Changes) after `emitGatePending` wrote this marker for
      // review_to_approved (from: in_review). Confirming it must NOT write
      // `status: 'approved'` — there is no in_build → approved matrix edge.
      const case_ = makeCase({
        status: 'in_build',
        pending_gate: {
          gate_id: 'review_to_approved',
          target_status: 'approved',
          since: '2026-01-01T00:00:00Z',
        },
      });
      const adapter = makeAdapter(case_);
      const handler = new RunCompletionHandler(adapter);

      await expect(handler.executeGateConfirmation('case_test')).rejects.toMatchObject({
        code: 'STALE_GATE',
      });

      // The marker is cleared but the status is untouched — no in_build →
      // approved write ever happened.
      const finalCase = await adapter.getCase('case_test');
      expect(finalCase.status).toBe('in_build');
      expect(finalCase.pending_gate).toBeUndefined();
      expect(adapter.events.some((e) => e.type === 'gate_confirmed')).toBe(false);
    });

    it('refuses (without clearing the marker) a gate whose preconditions regressed since it was emitted', async () => {
      // Status still matches the gate's expected `from` (in_review), but
      // the review_to_approved gate additionally requires
      // `auto_approve_criteria_met` — a high/critical risk case never
      // satisfies it. Confirming must fail closed, and the marker stays so
      // the case is not silently unstuck by a confirm that shouldn't count.
      const case_ = makeCase({
        status: 'in_review',
        risk_level: 'critical',
        pending_gate: {
          gate_id: 'review_to_approved',
          target_status: 'approved',
          since: '2026-01-01T00:00:00Z',
        },
      });
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'review_run', status: 'completed' })],
      });
      const handler = new RunCompletionHandler(adapter);

      await expect(handler.executeGateConfirmation('case_test')).rejects.toThrow();

      const finalCase = await adapter.getCase('case_test');
      expect(finalCase.status).toBe('in_review');
      expect(finalCase.pending_gate).toBeDefined();
    });
  });

  describe('onRunCompleted — merge-not-applicable auto-skip (issue #687)', () => {
    it('should route a repo-less approved case (no PR, no branch) straight to done with an auto-attached decision', async () => {
      const case_ = makeCase({
        status: 'approved',
        current_pr_ref: undefined,
        current_branch: undefined,
      });
      const adapter = makeAdapter(case_, {
        decisions: [{ type: 'approve', actor_id: 'usr_reviewer', created_at: '2026-01-01T00:00:00Z' }] as any,
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0]).toEqual({ from: 'approved', to: 'done' });
      expect(result.final_status).toBe('done');

      // Audit trail: system decision auto-attached exactly once + decision_created emitted.
      expect(adapter.createMergeNotApplicableDecision).toHaveBeenCalledTimes(1);
      expect(adapter.emitEvent).toHaveBeenCalledWith(
        'case_test',
        'decision_created',
        expect.objectContaining({
          type: 'merge_not_applicable',
          auto_attached: true,
          reason: 'no_pr_and_no_branch',
        }),
        'system:pipeline',
      );

      // Transition events of the skip variant.
      expect(adapter.events.some((e) => e.type === 'merge_skipped_not_applicable')).toBe(true);
      expect(adapter.events.some((e) => e.type === 'case_completed')).toBe(true);
      // It must NOT take the pending_merge route.
      expect(adapter.events.some((e) => e.type === 'merge_ready')).toBe(false);
    });

    it('should NOT auto-skip when a branch is recorded but no PR (PR may arrive via webhook branch-matching)', async () => {
      const case_ = makeCase({
        status: 'approved',
        current_pr_ref: undefined,
        current_branch: 'n/a-ops-config',
      });
      const adapter = makeAdapter(case_, {
        decisions: [{ type: 'approve', actor_id: 'usr_reviewer', created_at: '2026-01-01T00:00:00Z' }] as any,
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(adapter.createMergeNotApplicableDecision).not.toHaveBeenCalled();
      expect(result.transitions[0]).toEqual({ from: 'approved', to: 'pending_merge' });
      expect(result.final_status).toBe('pending_merge');
    });

    it('should NOT auto-attach twice when a current merge_not_applicable decision already exists', async () => {
      const case_ = makeCase({
        status: 'approved',
        current_pr_ref: undefined,
        current_branch: undefined,
      });
      const adapter = makeAdapter(case_, {
        decisions: [
          { type: 'approve', actor_id: 'usr_reviewer', created_at: '2026-01-01T00:00:00Z' },
          { type: 'merge_not_applicable', actor_id: 'system:pipeline', created_at: '2026-01-01T00:01:00Z' },
        ] as any,
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(adapter.createMergeNotApplicableDecision).not.toHaveBeenCalled();
      expect(result.transitions[0]).toEqual({ from: 'approved', to: 'done' });
    });
  });

  describe('onRunCompleted — full chain through in_validation', () => {
    it('should chain in_build → in_validation → in_review when rule_run auto-completes and evidence is satisfied', async () => {
      // Use a dynamic adapter that tracks runs created by the pipeline itself,
      // so loadPreconditionContext returns the auto-completed rule_run.
      let currentCase = makeCase({
        status: 'in_build',
        current_branch: 'feat/test',
        validation_track: 'direct',
        risk_level: 'low',
      });
      const createdRuns: Run[] = [];
      const transitions: Array<{ caseId: string; status: CaseStatus }> = [];
      const events: Array<{ type: EventType }> = [];

      const staticRuns = [makeRun({ run_type: 'build_run', status: 'completed' })];
      const staticEvidence = [
        { evidence_id: 'ev_1', case_id: 'case_test', type: 'ci_result', source_type: 'webhook', summary: 'CI passed', machine_readable: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      ] as any;

      const adapter: PipelineAdapter & { transitions: typeof transitions; events: typeof events } = {
        transitions,
        events,
        getCase: vi.fn(async () => currentCase),
        updateCaseStatus: vi.fn(async (_caseId: string, status: CaseStatus) => {
          transitions.push({ caseId: _caseId, status });
          currentCase = { ...currentCase, status };
          return currentCase;
        }),
        updateCase: vi.fn(async (_caseId: string, updates: Partial<Case>) => {
          currentCase = { ...currentCase, ...updates };
          return currentCase;
        }),
        loadPreconditionContext: vi.fn(async () => ({
          case_: currentCase,
          // Include both the initial runs AND any runs created by the pipeline
          runs: [...staticRuns, ...createdRuns],
          findings: [],
          ruleResults: [],
          evidence: staticEvidence,
          decisions: [],
          events: [],
          actorId: 'system',
        })),
        createRun: vi.fn(async (_caseId: string, runType: RunType) => {
          const run = makeRun({ run_id: `run_auto_${Date.now()}`, run_type: runType });
          createdRuns.push(run);
          return run;
        }),
        completeRun: vi.fn(async (runId: string) => {
          const run = createdRuns.find((r) => r.run_id === runId);
          if (run) run.status = 'completed';
          return run ?? makeRun({ status: 'completed' });
        }),
        failRun: vi.fn(async () => makeRun({ status: 'failed' })),
        createAutoApproveDecision: vi.fn(async () => ({ decision_id: 'dec_auto', case_id: 'case_test', type: 'auto_approve', actor_id: 'system', rationale: 'Auto-approved', snapshot: {}, created_at: '2026-01-01T00:00:00Z' })),
        closeOutstandingWaiverProposals: vi.fn(async () => ({ closed: 0 })),
          createMergeNotApplicableDecision: vi.fn(async () => ({ decision_id: 'dec_mna', case_id: 'case_test', type: 'merge_not_applicable', actor_id: 'system:pipeline', rationale: 'Auto-attached on approval: no PR and no branch', snapshot: {}, created_at: '2026-01-01T00:00:00Z' })),
        emitEvent: vi.fn(async (_caseId: string, type: EventType) => {
          events.push({ type });
        }),
        getActiveRuns: vi.fn(async () => []),
        getProjectLifecycleProfile: vi.fn(async () => undefined),
        scheduleRunRetry: vi.fn(async () => {}),
        claimRunRetryDispatch: vi.fn(async () => null),
        // review_run will be fire-and-forget — simulate an active pending review
        resolveAndRunReview: vi.fn(async () => ({ run: makeRun({ run_type: 'review_run', status: 'pending' }) })),
      };

      const handler = new RunCompletionHandler(adapter);
      const result = await handler.onRunCompleted('case_test');

      // Should chain: in_build → in_validation → in_review
      expect(result.transitions.length).toBeGreaterThanOrEqual(2);
      expect(result.transitions[0]).toEqual({ from: 'in_build', to: 'in_validation' });
      expect(result.transitions[1]).toEqual({ from: 'in_validation', to: 'in_review' });

      // Should have scheduled rule_run (auto-completed synchronously)
      expect(result.scheduled_runs.some((r) => r.run_type === 'rule_run')).toBe(true);
      // review_run is fire-and-forget — not tracked in scheduled_runs because the
      // .then() callback runs after scheduleRunsForStatus has already returned
      expect(result.scheduled_runs.some((r) => r.run_type === 'review_run')).toBe(false);

      // Final status should be in_review (waiting for async review to complete)
      expect(result.final_status).toBe('in_review');
    });

    it('should stay in_build when evidence is not satisfied', async () => {
      let currentCase = makeCase({
        status: 'in_build',
        current_branch: 'feat/test',
        validation_track: 'direct',
        risk_level: 'low',
      });
      const createdRuns: Run[] = [];

      const adapter = makeAdapter(currentCase, {
        runs: [makeRun({ run_type: 'build_run', status: 'completed' })],
      });

      // Override to track dynamic runs
      adapter.getCase = vi.fn(async () => currentCase);
      adapter.updateCaseStatus = vi.fn(async (_caseId: string, status: CaseStatus) => {
        adapter.transitions.push({ caseId: _caseId, status });
        currentCase = { ...currentCase, status };
        return currentCase;
      });
      adapter.loadPreconditionContext = vi.fn(async () => ({
        case_: currentCase,
        runs: [makeRun({ run_type: 'build_run', status: 'completed' }), ...createdRuns],
        findings: [],
        ruleResults: [],
        evidence: [], // No evidence → required_evidence_satisfied fails
        decisions: [],
        events: [],
        actorId: 'system',
      }));
      adapter.createRun = vi.fn(async (_caseId: string, runType: RunType) => {
        const run = makeRun({ run_id: `run_auto_${Date.now()}`, run_type: runType });
        createdRuns.push(run);
        return run;
      });
      adapter.completeRun = vi.fn(async (runId: string) => {
        const run = createdRuns.find((r) => r.run_id === runId);
        if (run) run.status = 'completed';
        return run ?? makeRun({ status: 'completed' });
      });

      const handler = new RunCompletionHandler(adapter);
      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(0);
      expect(result.final_status).toBe('in_build');
    });
  });

  describe('onRunCompleted — resolveAndRunReview returns null', () => {
    it('should emit comment_added event after retries when diff is missing', async () => {
      vi.useFakeTimers();
      try {
        let currentCase = makeCase({
          status: 'in_build',
          current_branch: 'feat/test',
          validation_track: 'direct',
          risk_level: 'low',
        });
        const createdRuns: Run[] = [];
        const transitions: Array<{ caseId: string; status: CaseStatus }> = [];
        const events: Array<{ type: EventType }> = [];

        const staticRuns = [makeRun({ run_type: 'build_run', status: 'completed' })];
        const staticEvidence = [
          { evidence_id: 'ev_1', case_id: 'case_test', type: 'ci_result', source_type: 'webhook', summary: 'CI passed', machine_readable: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
        ] as any;

        const adapter: PipelineAdapter & { transitions: typeof transitions; events: typeof events } = {
          transitions,
          events,
          getCase: vi.fn(async () => currentCase),
          updateCaseStatus: vi.fn(async (_caseId: string, status: CaseStatus) => {
            transitions.push({ caseId: _caseId, status });
            currentCase = { ...currentCase, status };
            return currentCase;
          }),
          updateCase: vi.fn(async (_caseId: string, updates: Partial<Case>) => {
            currentCase = { ...currentCase, ...updates };
            return currentCase;
          }),
          loadPreconditionContext: vi.fn(async () => ({
            case_: currentCase,
            runs: [...staticRuns, ...createdRuns],
            findings: [],
            ruleResults: [],
            evidence: staticEvidence,
            decisions: [],
            events: [],
            actorId: 'system',
          })),
          createRun: vi.fn(async (_caseId: string, runType: RunType) => {
            const run = makeRun({ run_id: `run_auto_${Date.now()}`, run_type: runType });
            createdRuns.push(run);
            return run;
          }),
          completeRun: vi.fn(async (runId: string) => {
            const run = createdRuns.find((r) => r.run_id === runId);
            if (run) run.status = 'completed';
            return run ?? makeRun({ status: 'completed' });
          }),
          failRun: vi.fn(async () => makeRun({ status: 'failed' })),
          createAutoApproveDecision: vi.fn(async () => ({ decision_id: 'dec_auto', case_id: 'case_test', type: 'auto_approve', actor_id: 'system', rationale: 'Auto-approved', snapshot: {}, created_at: '2026-01-01T00:00:00Z' })),
          closeOutstandingWaiverProposals: vi.fn(async () => ({ closed: 0 })),
          createMergeNotApplicableDecision: vi.fn(async () => ({ decision_id: 'dec_mna', case_id: 'case_test', type: 'merge_not_applicable', actor_id: 'system:pipeline', rationale: 'Auto-attached on approval: no PR and no branch', snapshot: {}, created_at: '2026-01-01T00:00:00Z' })),
          emitEvent: vi.fn(async (_caseId: string, type: EventType) => {
            events.push({ type });
          }),
          getActiveRuns: vi.fn(async () => []),
          getProjectLifecycleProfile: vi.fn(async () => undefined),
          scheduleRunRetry: vi.fn(async () => {}),
          claimRunRetryDispatch: vi.fn(async () => null),
          resolveAndRunReview: vi.fn(async () => ({ run: null })),
        };

        const handler = new RunCompletionHandler(adapter);
        const resultPromise = handler.onRunCompleted('case_test');

        // Flush microtasks to let the pipeline start the fire-and-forget attemptReview
        await vi.advanceTimersByTimeAsync(0);
        const result = await resultPromise;

        // scheduled_runs should NOT contain a review_run entry (fire-and-forget, not tracked)
        expect(result.scheduled_runs.some((r) => r.run_type === 'review_run')).toBe(false);
        // rule_run should still be tracked
        expect(result.scheduled_runs.some((r) => r.run_type === 'rule_run')).toBe(true);

        // Advance through all retry delays (3 retries × 3000ms)
        for (let i = 0; i < 3; i++) {
          await vi.advanceTimersByTimeAsync(3100);
        }

        // Should have emitted a comment_added event after all retries exhausted
        expect(adapter.emitEvent).toHaveBeenCalledWith(
          'case_test',
          'comment_added',
          expect.objectContaining({ comment_type: 'system' }),
          'system:pipeline',
        );
        expect(events.some((e) => e.type === 'comment_added')).toBe(true);

        // resolveAndRunReview should have been called 3 times (initial + 2 retries)
        expect(adapter.resolveAndRunReview).toHaveBeenCalledTimes(3);

        // No failed run should have been created (null is not an error, just no diff)
        expect(adapter.failRun).not.toHaveBeenCalled();

        // After all retries exhausted, the pipeline must mark the case as
        // review_not_applicable + emit the structured event so the case can
        // still be approved manually instead of getting stuck in_review.
        expect(adapter.updateCase).toHaveBeenCalledWith(
          'case_test',
          expect.objectContaining({ review_not_applicable: true }),
        );
        const naEvents = (adapter.emitEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
          (c) => c[1] === 'review_marked_not_applicable',
        );
        expect(naEvents).toHaveLength(1);
        expect(naEvents[0]![2]).toEqual(
          expect.objectContaining({ reason: 'diff_fetch_retries_exhausted', attempts: 3 }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('scheduleRunsForStatus — in_review without PR or branch (#419 bug 4)', () => {
    // Helper: build an adapter that chains in_validation → in_review via the
    // rule_run auto-complete path, parameterised on the case's current_pr_ref
    // and current_branch so we can exercise both the skip path and the
    // happy path without needing in_build → in_validation (which requires
    // current_branch to be set).
    function makeChainingAdapter(
      caseOverrides: Partial<Case>,
      resolveAndRunReviewImpl: () => Promise<ResolveAndRunReviewResult>,
    ): PipelineAdapter & { events: Array<{ type: EventType }>; transitions: Array<{ caseId: string; status: CaseStatus }> } {
      let currentCase = makeCase({
        status: 'in_validation',
        validation_track: 'direct',
        risk_level: 'low',
        ...caseOverrides,
      });
      const createdRuns: Run[] = [];
      const transitions: Array<{ caseId: string; status: CaseStatus }> = [];
      const events: Array<{ type: EventType }> = [];

      // rule_run completed satisfies rule_runs_completed for in_validation → in_review.
      const staticRuns = [makeRun({ run_type: 'rule_run', status: 'completed' })];
      const staticEvidence = [
        { evidence_id: 'ev_1', case_id: 'case_test', type: 'ci_result', source_type: 'webhook', summary: 'CI passed', machine_readable: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      ] as any;

      return {
        transitions,
        events,
        getCase: vi.fn(async () => currentCase),
        updateCaseStatus: vi.fn(async (_caseId: string, status: CaseStatus) => {
          transitions.push({ caseId: _caseId, status });
          currentCase = { ...currentCase, status };
          return currentCase;
        }),
        updateCase: vi.fn(async (_caseId: string, updates: Partial<Case>) => {
          currentCase = { ...currentCase, ...updates };
          return currentCase;
        }),
        loadPreconditionContext: vi.fn(async () => ({
          case_: currentCase,
          runs: [...staticRuns, ...createdRuns],
          findings: [],
          ruleResults: [],
          evidence: staticEvidence,
          decisions: [],
          events: [],
          actorId: 'system',
        })),
        createRun: vi.fn(async (_caseId: string, runType: RunType) => {
          const run = makeRun({ run_id: `run_auto_${Date.now()}_${createdRuns.length}`, run_type: runType });
          createdRuns.push(run);
          return run;
        }),
        completeRun: vi.fn(async (runId: string) => {
          const run = createdRuns.find((r) => r.run_id === runId);
          if (run) run.status = 'completed';
          return run ?? makeRun({ status: 'completed' });
        }),
        failRun: vi.fn(async () => makeRun({ status: 'failed' })),
        createAutoApproveDecision: vi.fn(async () => ({ decision_id: 'dec_auto', case_id: 'case_test', type: 'auto_approve', actor_id: 'system', rationale: 'Auto-approved', snapshot: {}, created_at: '2026-01-01T00:00:00Z' })),
        closeOutstandingWaiverProposals: vi.fn(async () => ({ closed: 0 })),
          createMergeNotApplicableDecision: vi.fn(async () => ({ decision_id: 'dec_mna', case_id: 'case_test', type: 'merge_not_applicable', actor_id: 'system:pipeline', rationale: 'Auto-attached on approval: no PR and no branch', snapshot: {}, created_at: '2026-01-01T00:00:00Z' })),
        emitEvent: vi.fn(async (_caseId: string, type: EventType) => {
          events.push({ type });
        }),
        getActiveRuns: vi.fn(async () => []),
        getProjectLifecycleProfile: vi.fn(async () => undefined),
        scheduleRunRetry: vi.fn(async () => {}),
        claimRunRetryDispatch: vi.fn(async () => null),
        resolveAndRunReview: vi.fn(resolveAndRunReviewImpl),
      };
    }

    it('should skip auto-review and emit one system comment when case has neither PR ref nor branch', async () => {
      // Regression guard: review-only cases entering in_review without a diff
      // source used to retry resolveAndRunReview 3× and fail with
      // "Diff could not be fetched from GitHub". The precondition check must
      // short-circuit before any retry runs.
      const resolveImpl = vi.fn(async () => ({ run: null }));
      const adapter = makeChainingAdapter(
        { current_pr_ref: undefined, current_branch: undefined },
        resolveImpl,
      );

      const handler = new RunCompletionHandler(adapter);
      await handler.onRunCompleted('case_test');

      // Pipeline should still chain in_validation → in_review.
      expect(adapter.transitions.some((t) => t.status === 'in_review')).toBe(true);

      // resolveAndRunReview must NOT have been called — no diff source.
      expect(adapter.resolveAndRunReview).not.toHaveBeenCalled();

      // Exactly one "Auto-review skipped" comment should have been emitted.
      const commentCalls = (adapter.emitEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[1] === 'comment_added',
      );
      expect(commentCalls).toHaveLength(1);
      expect(commentCalls[0]![2]).toEqual(
        expect.objectContaining({
          comment_type: 'system',
          body: expect.stringContaining('Auto-review skipped'),
        }),
      );

      // The pipeline must mark the case as review_not_applicable so the
      // approve precondition (review_run_completed) is satisfied without
      // a real review_run. Otherwise the case stays stuck in_review.
      expect(adapter.updateCase).toHaveBeenCalledWith(
        'case_test',
        expect.objectContaining({ review_not_applicable: true }),
      );
      const naEvents = (adapter.emitEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[1] === 'review_marked_not_applicable',
      );
      expect(naEvents).toHaveLength(1);
      expect(naEvents[0]![2]).toEqual(
        expect.objectContaining({ reason: 'no_diff_source' }),
      );
    });

    it('should still schedule auto-review when case has a PR ref', async () => {
      const resolveImpl = vi.fn(async () => ({ run: makeRun({ run_type: 'review_run', status: 'pending' }) }));
      const adapter = makeChainingAdapter(
        { current_pr_ref: 'owner/repo#42', current_branch: undefined },
        resolveImpl,
      );

      const handler = new RunCompletionHandler(adapter);
      await handler.onRunCompleted('case_test');

      // Flush microtasks so the fire-and-forget attemptReview runs.
      await new Promise((resolve) => setImmediate(resolve));

      expect(adapter.resolveAndRunReview).toHaveBeenCalled();
      const commentCalls = (adapter.emitEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[1] === 'comment_added',
      );
      expect(commentCalls).toHaveLength(0);
    });

    it('should auto-advance out of in_review after marking review_not_applicable (no_diff_source, direct track)', async () => {
      // Regression guard for the "stuck in_review" bug: when the case has no
      // diff source, scheduleRunsForStatus inline-marks review_not_applicable
      // but used to leave the case parked in_review. The agent context route
      // then advertised approve as blocked and the lifecycle never advanced.
      // The fix reloads the case after scheduleRunsForStatus so the next
      // tryAutoTransition iteration sees the flag and routes the case onward
      // (in_review → approved for a direct/low-risk case).
      const resolveImpl = vi.fn(async () => ({ run: null }));
      const adapter = makeChainingAdapter(
        { current_pr_ref: undefined, current_branch: undefined },
        resolveImpl,
      );

      const handler = new RunCompletionHandler(adapter);
      await handler.onRunCompleted('case_test');

      // The case must NOT terminate in in_review — it should chain to approved.
      const lastTransition = adapter.transitions[adapter.transitions.length - 1];
      expect(lastTransition?.status).toBe('approved');
      expect(adapter.transitions.map((t) => t.status)).toContain('in_review');
    });

    it('should auto-advance to verification_pending when review_not_applicable on manual track', async () => {
      // Manual-track variant: with no high/critical findings, the matching
      // auto-trigger is `in_review → verification_pending`
      // (track_is_manual_and_no_high_critical). Without the fix, the case
      // parked in in_review and the user had to force-transition manually.
      //
      // We build a bespoke adapter here so the precondition context has the
      // manual-track default evidence (`ci_result` + `manual_confirmation`)
      // available — otherwise `in_validation → in_review` never fires and the
      // chain stalls before the bug under test even matters.
      let currentCase = makeCase({
        status: 'in_validation',
        validation_track: 'manual',
        risk_level: 'low',
        current_pr_ref: undefined,
        current_branch: undefined,
      });
      const transitions: Array<{ caseId: string; status: CaseStatus }> = [];
      const events: Array<{ type: EventType }> = [];
      const staticRuns = [makeRun({ run_type: 'rule_run', status: 'completed' })];
      const staticEvidence = [
        { evidence_id: 'ev_1', case_id: 'case_test', type: 'ci_result', source_type: 'webhook', summary: 'CI passed', machine_readable: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
        { evidence_id: 'ev_2', case_id: 'case_test', type: 'manual_confirmation', source_type: 'manual', summary: 'Manual confirmation provided', machine_readable: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      ] as any;

      const adapter: PipelineAdapter & { transitions: typeof transitions; updateCase: ReturnType<typeof vi.fn> } = {
        getCase: vi.fn(async () => currentCase),
        updateCaseStatus: vi.fn(async (_id: string, status: CaseStatus) => {
          transitions.push({ caseId: _id, status });
          currentCase = { ...currentCase, status };
          return currentCase;
        }),
        updateCase: vi.fn(async (_id: string, updates: Partial<Case>) => {
          currentCase = { ...currentCase, ...updates };
          return currentCase;
        }),
        loadPreconditionContext: vi.fn(async () => ({
          case_: currentCase,
          runs: staticRuns,
          findings: [],
          ruleResults: [],
          evidence: staticEvidence,
          decisions: [],
          events: [],
          actorId: 'system',
        })),
        createRun: vi.fn(async (_id: string, runType: RunType) => makeRun({ run_type: runType })),
        completeRun: vi.fn(async () => makeRun({ status: 'completed' })),
        failRun: vi.fn(async () => makeRun({ status: 'failed' })),
        createAutoApproveDecision: vi.fn(async () => ({ decision_id: 'dec_auto', case_id: 'case_test', type: 'auto_approve', actor_id: 'system', rationale: 'Auto-approved', snapshot: {}, created_at: '2026-01-01T00:00:00Z' })),
        closeOutstandingWaiverProposals: vi.fn(async () => ({ closed: 0 })),
          createMergeNotApplicableDecision: vi.fn(async () => ({ decision_id: 'dec_mna', case_id: 'case_test', type: 'merge_not_applicable', actor_id: 'system:pipeline', rationale: 'Auto-attached on approval: no PR and no branch', snapshot: {}, created_at: '2026-01-01T00:00:00Z' })),
        emitEvent: vi.fn(async (_id: string, type: EventType) => {
          events.push({ type });
        }),
        getActiveRuns: vi.fn(async () => []),
        getProjectLifecycleProfile: vi.fn(async () => undefined),
        scheduleRunRetry: vi.fn(async () => {}),
        claimRunRetryDispatch: vi.fn(async () => null),
        resolveAndRunReview: vi.fn(async () => ({ run: null })),
        transitions,
      } as PipelineAdapter & { transitions: typeof transitions; updateCase: ReturnType<typeof vi.fn> };

      const handler = new RunCompletionHandler(adapter);
      await handler.onRunCompleted('case_test');

      const lastTransition = adapter.transitions[adapter.transitions.length - 1];
      expect(lastTransition?.status).toBe('verification_pending');
      expect(adapter.transitions.map((t) => t.status)).toContain('in_review');
      expect(adapter.updateCase).toHaveBeenCalledWith(
        'case_test',
        expect.objectContaining({ review_not_applicable: true }),
      );
    });

    it('should resume the pipeline after diff-fetch retries are exhausted', async () => {
      // The retries-exhausted path is fire-and-forget (the review attempt loop
      // runs after scheduleRunsForStatus returns). After the final attempt
      // marks review_not_applicable, the handler must call onRunCompleted on
      // its own — otherwise nothing drives the in_review → approved transition.
      vi.useFakeTimers();
      try {
        const resolveImpl = vi.fn(async () => ({ run: null }));
        const adapter = makeChainingAdapter(
          {
            current_pr_ref: undefined,
            current_branch: 'feat/has-branch-but-no-diff',
          },
          resolveImpl,
        );

        const handler = new RunCompletionHandler(adapter);
        await handler.onRunCompleted('case_test');

        // Flush each retry + delay so all three attempts run.
        for (let i = 0; i < 3; i++) {
          await vi.advanceTimersByTimeAsync(3100);
        }
        // Let the pipeline-resume microtasks settle.
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();

        expect(resolveImpl).toHaveBeenCalledTimes(3);
        expect(adapter.updateCase).toHaveBeenCalledWith(
          'case_test',
          expect.objectContaining({ review_not_applicable: true }),
        );
        // After the resume, the case must have transitioned out of in_review.
        const lastTransition = adapter.transitions[adapter.transitions.length - 1];
        expect(lastTransition?.status).toBe('approved');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('next_actions', () => {
    it('should suggest triage for open cases', async () => {
      const case_ = makeCase({ status: 'open' });
      const adapter = makeAdapter(case_);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.next_actions).toHaveLength(1);
      expect(result.next_actions[0]!.type).toBe('await_human');
    });

    it('should suggest case_complete for done cases', async () => {
      const case_ = makeCase({ status: 'done' });
      const adapter = makeAdapter(case_);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.next_actions).toHaveLength(1);
      expect(result.next_actions[0]!.type).toBe('case_complete');
    });

    it('should suggest exploration_run for exploration status', async () => {
      // exploration without completed run → stays in exploration
      const case_ = makeCase({ status: 'exploration' });
      const adapter = makeAdapter(case_);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.next_actions.some((a) => a.type === 'start_run')).toBe(true);
    });
  });

  describe('event emission', () => {
    it('should emit events for each auto-transition', async () => {
      const case_ = makeCase({ status: 'exploration' });
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'exploration_run', status: 'completed' })],
      });
      const handler = new RunCompletionHandler(adapter);

      await handler.onRunCompleted('case_test');

      expect(adapter.emitEvent).toHaveBeenCalled();
      // exploration → ready_for_build emits: exploration_completed, case_ready_for_build
      expect(adapter.events.some((e) => e.type === 'exploration_completed')).toBe(true);
      expect(adapter.events.some((e) => e.type === 'case_ready_for_build')).toBe(true);
    });
  });

  describe('lifecycle profile gates', () => {
    it('should block exploration → ready_for_build with strict profile', async () => {
      const strictProfile = { preset: 'strict' as const };
      const case_ = makeCase({ status: 'exploration' });
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'exploration_run', status: 'completed' })],
      }, strictProfile);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      // Should NOT transition — gate requires confirmation
      expect(result.transitions).toHaveLength(0);
      expect(result.final_status).toBe('exploration');
      // Should have emitted gate_pending event
      expect(adapter.events.some((e) => e.type === 'gate_pending')).toBe(true);
      // Should have set pending_gate on the case
      expect(adapter.updateCase).toHaveBeenCalledWith(
        'case_test',
        expect.objectContaining({
          pending_gate: expect.objectContaining({
            gate_id: 'exploration_to_ready',
            target_status: 'ready_for_build',
          }),
        }),
      );
    });

    it('should auto-transition exploration → ready_for_build with autonomous profile', async () => {
      const autonomousProfile = { preset: 'autonomous' as const };
      const case_ = makeCase({ status: 'exploration' });
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'exploration_run', status: 'completed' })],
      }, autonomousProfile);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      // Should transition normally — gate is auto. Autonomous also chains
      // ready_for_build → in_build since ready_to_build gate is 'auto'.
      expect(result.transitions.length).toBeGreaterThanOrEqual(1);
      expect(result.transitions[0]).toEqual({ from: 'exploration', to: 'ready_for_build' });
    });

    it('should auto-transition ready_for_build → in_build with autonomous profile', async () => {
      const autonomousProfile = { preset: 'autonomous' as const };
      const case_ = makeCase({ status: 'ready_for_build' });
      const adapter = makeAdapter(case_, {}, autonomousProfile);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      // Should transition — autonomous profile makes ready_to_build auto
      expect(result.transitions.length).toBeGreaterThanOrEqual(1);
      expect(result.transitions[0]).toEqual({ from: 'ready_for_build', to: 'in_build' });
    });

    it('should NOT auto-transition ready_for_build → in_build with standard profile (default)', async () => {
      const case_ = makeCase({ status: 'ready_for_build' });
      const adapter = makeAdapter(case_);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      // Standard profile: ready_to_build is 'confirm', and it's not even in auto_trigger
      expect(result.transitions).toHaveLength(0);
      expect(result.final_status).toBe('ready_for_build');
    });

    it('should not try auto-transition when case already has a pending_gate', async () => {
      const case_ = makeCase({
        status: 'exploration',
        pending_gate: {
          gate_id: 'exploration_to_ready',
          target_status: 'ready_for_build',
          since: '2026-01-01T00:00:00Z',
        },
      } as any);
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'exploration_run', status: 'completed' })],
      });
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toHaveLength(0);
      expect(result.final_status).toBe('exploration');
    });

    it('should respect per-gate overrides over preset', async () => {
      // Autonomous preset but with exploration_to_ready overridden to confirm
      const profile = {
        preset: 'autonomous' as const,
        overrides: { exploration_to_ready: 'confirm' as const },
      };
      const case_ = makeCase({ status: 'exploration' });
      const adapter = makeAdapter(case_, {
        runs: [makeRun({ run_type: 'exploration_run', status: 'completed' })],
      }, profile);
      const handler = new RunCompletionHandler(adapter);

      const result = await handler.onRunCompleted('case_test');

      // Override says confirm → should block
      expect(result.transitions).toHaveLength(0);
      expect(adapter.events.some((e) => e.type === 'gate_pending')).toBe(true);
    });
  });

  describe('handleRunFailure — retry/backoff', () => {
    /**
     * Realistic `claimRunRetryDispatch` stub: echoes back the given run with
     * `retry_dispatched: true`, exactly like the real Firestore transaction
     * does on a winning claim. Tests that don't care about the claim itself
     * (most of them) just want the retry to actually proceed.
     */
    function claimedFrom(run: Run) {
      return vi.fn(async () => ({ ...run, retry_dispatched: true }));
    }

    it.each(['done', 'rejected'] as const)(
      'does not schedule a retry when the failed Run belongs to a %s Case',
      async (status) => {
        vi.useFakeTimers();
        try {
          const adapter = makeAdapter(makeCase({ status }));
          const failedRun = makeRun({
            run_id: `run_terminal_${status}`,
            run_type: 'review_run',
            status: 'failed',
            attempt: 1,
            error_message: 'lease expired',
          });
          adapter.claimRunRetryDispatch = claimedFrom(failedRun);

          await new RunCompletionHandler(adapter).handleRunFailure(failedRun);
          await vi.advanceTimersByTimeAsync(60_000);

          // Removing the first terminal-Case guard in handleRunFailure makes
          // this exact assertion fail: the transient classifier persists a
          // retry intent even though the Case is already over.
          expect(adapter.scheduleRunRetry).not.toHaveBeenCalled();
          expect(adapter.claimRunRetryDispatch).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it('does not emit exhaustion or notify when the Case finishes during failure handling', async () => {
      notifyMock.mockClear();
      const active = makeCase({ status: 'in_review' });
      const terminal = makeCase({ status: 'done' });
      const adapter = makeAdapter(active);
      adapter.getCase = vi.fn()
        .mockResolvedValueOnce(active)
        .mockResolvedValueOnce(terminal);
      const failedRun = makeRun({
        run_id: 'run_exhausted_during_race',
        run_type: 'review_run',
        status: 'failed',
        attempt: 3,
        error_message: 'lease expired',
      });

      await new RunCompletionHandler(adapter).handleRunFailure(failedRun);

      // The second read belongs to emitRetriesExhausted. Removing that
      // boundary re-check makes both assertions fail even though the initial
      // handleRunFailure read was non-terminal.
      expect(adapter.events.some((event) => event.type === 'run_retries_exhausted')).toBe(false);
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it('fails closed when the owning Case cannot be read', async () => {
      const adapter = makeAdapter(makeCase({ status: 'in_review' }));
      adapter.getCase = vi.fn().mockRejectedValue(new Error('Firestore unavailable'));
      const failedRun = makeRun({
        run_id: 'run_case_unreadable',
        run_type: 'review_run',
        status: 'failed',
        attempt: 1,
        error_message: 'lease expired',
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await new RunCompletionHandler(adapter).handleRunFailure(failedRun);
      } finally {
        error.mockRestore();
      }

      // Replacing the fail-closed Case read with classification-first behavior
      // schedules recovery under an unknown lifecycle state and fails here.
      expect(adapter.scheduleRunRetry).not.toHaveBeenCalled();
    });

    it('persists the retry intent (durable backstop) BEFORE the in-process timer fires', async () => {
      vi.useFakeTimers();
      try {
        const case_ = makeCase({ status: 'in_review' });
        const adapter = makeAdapter(case_);
        adapter.getActiveRuns = vi.fn(async () => []);

        const handler = new RunCompletionHandler(adapter);
        const failedRun = makeRun({
          run_id: 'run_failed_1',
          case_id: 'case_test',
          run_type: 'review_run',
          status: 'failed',
          attempt: 1,
          error_message: 'ETIMEDOUT: connect timeout',
        });
        adapter.claimRunRetryDispatch = claimedFrom(failedRun);

        await handler.handleRunFailure(failedRun);

        // Persisted immediately, not after the backoff delay — this is what
        // survives an instance dying before the timer below fires.
        expect(adapter.scheduleRunRetry).toHaveBeenCalledTimes(1);
        const [runId, retryAt] = (adapter.scheduleRunRetry as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(runId).toBe('run_failed_1');
        expect(new Date(retryAt as string).getTime()).toBeGreaterThan(Date.now());
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries a transient review_run failure with the first backoff step and increments attempt', async () => {
      vi.useFakeTimers();
      try {
        const case_ = makeCase({ status: 'in_review' });
        const adapter = makeAdapter(case_);
        adapter.getActiveRuns = vi.fn(async () => []);
        adapter.resolveAndRunReview = vi.fn(async () => ({ run: makeRun({ run_id: 'run_retry', run_type: 'review_run' }) }));

        const handler = new RunCompletionHandler(adapter);
        const failedRun = makeRun({
          run_id: 'run_failed_1',
          case_id: 'case_test',
          run_type: 'review_run',
          status: 'failed',
          attempt: 1,
          error_message: 'ETIMEDOUT: connect timeout',
        });
        adapter.claimRunRetryDispatch = claimedFrom(failedRun);

        await handler.handleRunFailure(failedRun);
        // Not yet — backoff hasn't elapsed.
        expect(adapter.resolveAndRunReview).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(10_000);

        expect(adapter.claimRunRetryDispatch).toHaveBeenCalledWith('run_failed_1');
        expect(adapter.resolveAndRunReview).toHaveBeenCalledWith('case_test', 2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not retry when a run of the same type is already active', async () => {
      vi.useFakeTimers();
      try {
        const case_ = makeCase({ status: 'in_review' });
        const adapter = makeAdapter(case_);
        adapter.getActiveRuns = vi.fn(async () => [makeRun({ run_type: 'review_run', status: 'running' })]);
        adapter.resolveAndRunReview = vi.fn(async () => ({ run: makeRun({ run_type: 'review_run' }) }));

        const handler = new RunCompletionHandler(adapter);
        const failedRun = makeRun({
          run_id: 'run_failed_1',
          case_id: 'case_test',
          run_type: 'review_run',
          status: 'failed',
          attempt: 1,
          error_message: 'ETIMEDOUT',
        });
        adapter.claimRunRetryDispatch = claimedFrom(failedRun);

        await handler.handleRunFailure(failedRun);
        await vi.advanceTimersByTimeAsync(10_000);

        expect(adapter.resolveAndRunReview).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not retry a permanently-classified failure, and never emits run_retries_exhausted for it', async () => {
      vi.useFakeTimers();
      try {
        const case_ = makeCase({ status: 'in_review' });
        const adapter = makeAdapter(case_);
        adapter.resolveAndRunReview = vi.fn(async () => ({ run: makeRun({ run_type: 'review_run' }) }));

        const handler = new RunCompletionHandler(adapter);
        const failedRun = makeRun({
          run_id: 'run_failed_1',
          case_id: 'case_test',
          run_type: 'review_run',
          status: 'failed',
          attempt: 1,
          error_message: 'Validation failed: malformed diff',
        });

        await handler.handleRunFailure(failedRun);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(adapter.resolveAndRunReview).not.toHaveBeenCalled();
        expect(adapter.events.some((e) => e.type === 'run_retries_exhausted')).toBe(false);
        // Permanent failures never even reach the durable-persist step.
        expect(adapter.scheduleRunRetry).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('emits run_retries_exhausted (with no ad hoc owner notify of its own) once MAX_RUN_RETRIES is reached', async () => {
      // Pre-fix this asserted a direct `notificationService.notify(...)` call
      // from inside `Pipeline.emitRetriesExhausted` — that call is now
      // deleted (`docs/specs/clerk-config-scheduling-chat.md` slice C item 1):
      // the roadmap-promised case-owner notification for this event comes
      // from `EventNotifier.notifyRunRetriesExhausted` instead, reached via
      // the REAL `EventService.emit` on the production adapter, not this
      // fake one. Re-adding the direct call to `emitRetriesExhausted` would
      // make `notifyMock` see its exact title again and fail the assertion
      // below; the notifier-side behavior itself is pinned in
      // `event-notifier.test.ts`.
      const case_ = makeCase({ status: 'in_review', owner_user_id: 'usr_owner', title: 'My Case' });
      const adapter = makeAdapter(case_);

      const handler = new RunCompletionHandler(adapter);
      // attempt=3 → retriesSoFar=2 >= MAX_RUN_RETRIES(2) → exhausted, no more retries.
      const failedRun = makeRun({
        run_id: 'run_failed_3',
        case_id: 'case_test',
        run_type: 'review_run',
        status: 'failed',
        attempt: 3,
        error_message: 'ETIMEDOUT',
      });

      await handler.handleRunFailure(failedRun);

      expect(adapter.events.some((e) => e.type === 'run_retries_exhausted')).toBe(true);
      expect(adapter.emitEvent).toHaveBeenCalledWith(
        'case_test',
        'run_retries_exhausted',
        expect.objectContaining({ run_type: 'review_run', attempts: 3 }),
        expect.anything(),
      );
      expect(notifyMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Pipeline task failed after retries' }),
      );
      expect(adapter.scheduleRunRetry).not.toHaveBeenCalled();
    });

    // Reverting either the terminal wait reason or the abandonment event sends
    // Clerk back into the dead needs_human_decision resume path.
    it('documents exhausted assistant retries as a terminal run-scoped verdict', async () => {
      const case_ = makeCase({
        status: 'in_build',
        case_type: 'assistant_task',
        assistant_context: {
          channel: 'google_chat',
          conversation_visibility: 'direct',
          requester_user_id: 'usr_owner',
          risk_level: 'low',
          policy_version: 'assistant-policy:v1',
          prompt_version: 'assistant-system:v1',
        },
      } as Partial<Case>);
      const exhaustedRun = makeRun({
        run_id: 'run_assistant_3',
        case_id: 'case_test',
        run_type: 'assistant_task_run',
        status: 'failed',
        attempt: 3,
        error_message: 'ETIMEDOUT',
      });
      const adapter = makeAdapter(case_, { runs: [exhaustedRun] });
      const handler = new RunCompletionHandler(adapter);

      await handler.handleRunFailure(exhaustedRun);

      expect(adapter.emitEvent).toHaveBeenCalledWith(
        'case_test',
        'assistant_task_abandoned',
        expect.objectContaining({
          run_id: 'run_assistant_3',
          classification: 'retry_exhausted',
        }),
        'system:pipeline',
      );
      expect(adapter.updateCase).toHaveBeenCalledWith(
        'case_test',
        expect.objectContaining({
          assistant_context: expect.objectContaining({
            wait_reason: 'failed_permanently',
            wait_run_id: 'run_assistant_3',
            wait_attempt: 3,
            // The rest of the context survives the hold write.
            prompt_version: 'assistant-system:v1',
          }),
        }),
      );

      // The stock double serves a fixed event list, so replay the events the
      // terminal verdict actually emitted before re-evaluating.
      adapter.loadPreconditionContext = vi.fn(async () => ({
        case_: await adapter.getCase('case_test'),
        runs: [exhaustedRun],
        findings: [],
        ruleResults: [],
        evidence: [],
        decisions: [],
        events: adapter.events.map((event, index) => ({
          event_id: `evt_${index}`,
          case_id: 'case_test',
          type: event.type,
          actor_id: 'system:pipeline',
          payload: { run_id: 'run_assistant_3' },
          created_at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 1000).toISOString(),
        })),
        actorId: 'system',
      }));

      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions).toEqual([{ from: 'in_build', to: 'rejected' }]);
      expect(result.final_status).toBe('rejected');
    });

    it('does not retry a run whose attempt is already at MAX_RUN_RETRIES + 1', async () => {
      vi.useFakeTimers();
      try {
        const case_ = makeCase({ status: 'in_review' });
        const adapter = makeAdapter(case_);
        adapter.resolveAndRunReview = vi.fn(async () => ({ run: makeRun({ run_type: 'review_run' }) }));

        const handler = new RunCompletionHandler(adapter);
        const failedRun = makeRun({
          run_id: 'run_failed_4',
          case_id: 'case_test',
          run_type: 'review_run',
          status: 'failed',
          attempt: 4,
          error_message: 'ETIMEDOUT',
        });

        await handler.handleRunFailure(failedRun);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(adapter.resolveAndRunReview).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-dispatches a non-review run type via a fresh createRun carrying the incremented attempt', async () => {
      vi.useFakeTimers();
      try {
        const case_ = makeCase({ status: 'in_build' });
        const adapter = makeAdapter(case_);
        adapter.getActiveRuns = vi.fn(async () => []);
        adapter.createRun = vi.fn(async (caseId: string, runType: RunType, triggerSource: string, attempt?: number) =>
          makeRun({ run_id: 'run_retry_generic', case_id: caseId, run_type: runType, trigger_source: triggerSource, attempt }),
        );

        const handler = new RunCompletionHandler(adapter);
        // build_run has no RunExecutor case (falls to its "no executor" branch) —
        // exercising it here only asserts the retry's createRun call, not what
        // RunExecutor does afterward (covered by RunExecutor's own scope).
        const failedRun = makeRun({
          run_id: 'run_failed_build',
          case_id: 'case_test',
          run_type: 'build_run',
          trigger_source: 'usr_agent',
          status: 'failed',
          attempt: 1,
          error_message: 'socket hang up',
        });
        adapter.claimRunRetryDispatch = claimedFrom(failedRun);

        await handler.handleRunFailure(failedRun);
        await vi.advanceTimersByTimeAsync(10_000);

        expect(adapter.createRun).toHaveBeenCalledWith('case_test', 'build_run', 'usr_agent', 2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('first attempt fails transiently while the case is still open — the retry is claimed and the case still reaches in_build', async () => {
      vi.useFakeTimers();
      try {
        const case_ = makeCase({ case_type: 'assistant_task', status: 'open' });
        const adapter = makeAdapter(case_);
        const liveRuns: Run[] = [];
        adapter.getActiveRuns = vi.fn(async () => []);
        adapter.loadPreconditionContext = vi.fn(async () => ({
          case_,
          runs: liveRuns,
          findings: [],
          ruleResults: [],
          evidence: [],
          decisions: [],
          events: [],
          actorId: 'system',
        }));
        // Mirrors `FirestorePipelineAdapter.createRun`: the run IS persisted and
        // therefore visible to the precondition context, but pending-and-owned
        // (lease + worker stamped at creation), so `claimRun` can never take it
        // and nothing promotes it to `running`. That fidelity is what makes the
        // `in_build` assertion below fail on the pre-fix code for the real
        // reason rather than because the fake dropped the run.
        adapter.createRun = vi.fn(async (caseId, runType, triggerSource, attempt) => {
          const created = makeRun({
            run_id: 'run_retry_assistant',
            case_id: caseId,
            run_type: runType,
            trigger_source: triggerSource,
            status: 'pending',
            worker_id: 'worker_precreated',
            lease_expires_at: '2026-01-01T00:05:00.000Z',
            attempt,
          });
          liveRuns.push(created);
          return created;
        });
        adapter.prepareAssistantReattempt = vi.fn(async (caseId, runType, triggerSource, attempt) => {
          const retried = makeRun({
            run_id: 'run_retry_assistant',
            case_id: caseId,
            run_type: runType,
            trigger_source: triggerSource,
            status: 'pending',
            awaiting_claim: true,
            attempt,
          });
          liveRuns.push(retried);
          return retried;
        });
        adapter.claimRun = vi.fn(async (runId) => {
          const retried = liveRuns.find((run) => run.run_id === runId)!;
          retried.status = 'running';
          retried.worker_id = 'worker_retry';
          retried.lease_expires_at = '2026-01-01T00:05:00.000Z';
          delete retried.awaiting_claim;
          return { claimed: true, run: retried };
        });
        // Keep the claimed run live while this focused retry test evaluates the
        // transition. The placeholder assistant executor normally completes
        // immediately, but the production task handler will hold this state.
        adapter.completeRun = vi.fn(async (runId) => liveRuns.find((run) => run.run_id === runId)!);

        const handler = new RunCompletionHandler(adapter);
        const failedRun = makeRun({
          run_id: 'run_failed_assistant',
          case_id: 'case_test',
          run_type: 'assistant_task_run',
          trigger_source: 'usr_agent',
          status: 'failed',
          attempt: 1,
          error_message: 'ETIMEDOUT: requester reload timed out',
        });
        adapter.claimRunRetryDispatch = claimedFrom(failedRun);

        await handler.handleRunFailure(failedRun);
        await vi.advanceTimersByTimeAsync(10_000);
        await vi.runAllTimersAsync();

        // Outcome first — this is the regression: on the pre-fix code the
        // retried run stays `pending`, `assistant_run_claimed` never holds and
        // the case parks in `open`.
        // Third argument is the approval-pin fragment (issue #1045) — empty
        // for every target status except `approved`.
        expect(adapter.updateCaseStatus).toHaveBeenCalledWith('case_test', 'in_build', {});
        expect(liveRuns).toContainEqual(expect.objectContaining({
          run_id: 'run_retry_assistant',
          status: 'running',
        }));
        // …and it got there through the claim path, not through `createRun`.
        expect(adapter.prepareAssistantReattempt).toHaveBeenCalledWith(
          'case_test', 'assistant_task_run', 'usr_agent', 2,
        );
        expect(adapter.createRun).not.toHaveBeenCalledWith(
          'case_test', 'assistant_task_run', expect.anything(), expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not dispatch a second executor onto a prepared replacement that is already claimed and bound', async () => {
      // `prepareAssistantReattempt` is idempotent on a deterministic attempt
      // key, so a re-drive of the same retry gets back the EXISTING run — which
      // the assistant claim sweep may already own. `claimIfUnclaimed` does not
      // stop that: it returns the run untouched when `awaiting_claim` is absent
      // (`run-executor.ts:238`), and dispatch proceeds to heartbeat and execute
      // it. Until #835 the policy-bind conflict throw is what happened to stop
      // this loser; the subset re-bind removes that accident.
      //
      // Deleting the `isClaimableAssistantReattempt` early return in
      // `pipeline.ts` makes this test see a `run_started` event.
      vi.useFakeTimers();
      try {
        const case_ = makeCase({ case_type: 'assistant_task', status: 'in_build' });
        const adapter = makeAdapter(case_);
        adapter.getActiveRuns = vi.fn(async () => []);
        const alreadyOwned = makeRun({
          run_id: 'run_retry_assistant',
          case_id: 'case_test',
          run_type: 'assistant_task_run',
          trigger_source: 'usr_agent',
          status: 'running',
          worker_id: 'worker_sweeper',
          lease_expires_at: '2026-01-01T00:05:00.000Z',
          attempt: 2,
          assistant_policy_state: 'bound',
        });
        adapter.prepareAssistantReattempt = vi.fn(async () => alreadyOwned);
        adapter.claimRun = vi.fn(async () => ({ claimed: false, run: null }));

        const handler = new RunCompletionHandler(adapter);
        const failedRun = makeRun({
          run_id: 'run_failed_assistant',
          case_id: 'case_test',
          run_type: 'assistant_task_run',
          trigger_source: 'usr_agent',
          status: 'failed',
          attempt: 1,
          error_message: 'ETIMEDOUT: requester reload timed out',
        });
        adapter.claimRunRetryDispatch = claimedFrom(failedRun);

        await handler.handleRunFailure(failedRun);
        await vi.advanceTimersByTimeAsync(10_000);
        await vi.runAllTimersAsync();

        expect(adapter.prepareAssistantReattempt).toHaveBeenCalledTimes(1);
        expect(adapter.emitEvent).not.toHaveBeenCalledWith(
          'case_test',
          'run_started',
          expect.objectContaining({ run_id: 'run_retry_assistant' }),
          expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps createRun behavior for an assistant retry when the adapter has no claimRun', async () => {
      vi.useFakeTimers();
      try {
        const case_ = makeCase({ case_type: 'assistant_task', status: 'open' });
        const adapter = makeAdapter(case_);
        adapter.getActiveRuns = vi.fn(async () => []);
        adapter.claimRun = undefined;
        adapter.createRun = vi.fn(async (caseId, runType, triggerSource, attempt) =>
          makeRun({ case_id: caseId, run_type: runType, trigger_source: triggerSource, attempt }),
        );

        const handler = new RunCompletionHandler(adapter);
        const failedRun = makeRun({
          run_id: 'run_failed_assistant_without_claim',
          case_id: 'case_test',
          run_type: 'assistant_task_run',
          trigger_source: 'usr_agent',
          status: 'failed',
          attempt: 1,
          error_message: 'ETIMEDOUT: requester reload timed out',
        });
        adapter.claimRunRetryDispatch = claimedFrom(failedRun);

        await handler.handleRunFailure(failedRun);
        await vi.advanceTimersByTimeAsync(10_000);

        expect(adapter.createRun).toHaveBeenCalledWith(
          'case_test', 'assistant_task_run', 'usr_agent', 2,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses the second backoff step (30s) for a run already on its first retry (attempt=2)', async () => {
      vi.useFakeTimers();
      try {
        const case_ = makeCase({ status: 'in_review' });
        const adapter = makeAdapter(case_);
        adapter.getActiveRuns = vi.fn(async () => []);
        adapter.resolveAndRunReview = vi.fn(async () => ({ run: makeRun({ run_type: 'review_run' }) }));

        const handler = new RunCompletionHandler(adapter);
        const failedRun = makeRun({
          run_id: 'run_failed_2',
          case_id: 'case_test',
          run_type: 'review_run',
          status: 'failed',
          attempt: 2,
          error_message: 'ETIMEDOUT',
        });
        adapter.claimRunRetryDispatch = claimedFrom(failedRun);

        await handler.handleRunFailure(failedRun);

        // Not yet at 10s (that was the FIRST retry's delay).
        await vi.advanceTimersByTimeAsync(10_000);
        expect(adapter.resolveAndRunReview).not.toHaveBeenCalled();

        // Fires at the 30s mark (20s more).
        await vi.advanceTimersByTimeAsync(20_000);
        expect(adapter.resolveAndRunReview).toHaveBeenCalledWith('case_test', 3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('dispatchScheduledRetry — durable-retry double-dispatch guard (PR #742)', () => {
    it('leaves a terminal Case retry unclaimed and reports it as not eligible', async () => {
      const adapter = makeAdapter(makeCase({ status: 'done' }));
      const failedRun = makeRun({
        run_id: 'run_terminal_retry_intent',
        run_type: 'review_run',
        status: 'failed',
        attempt: 1,
        error_message: 'lease expired',
      });
      adapter.claimRunRetryDispatch = vi.fn(async () => ({ ...failedRun, retry_dispatched: true }));

      const outcome = await new RunCompletionHandler(adapter).dispatchScheduledRetry(failedRun);

      // Removing the pre-claim terminal guard consumes the durable intent and
      // enters retry dispatch; both facts below then invert.
      expect(outcome).toBe('not_eligible');
      expect(adapter.claimRunRetryDispatch).not.toHaveBeenCalled();
    });

    it('does not create a replacement if the Case becomes terminal after the retry claim', async () => {
      const active = makeCase({ status: 'in_review' });
      const terminal = makeCase({ status: 'done' });
      const adapter = makeAdapter(active);
      const failedRun = makeRun({
        run_id: 'run_terminal_after_claim',
        run_type: 'review_run',
        status: 'failed',
        attempt: 1,
        error_message: 'lease expired',
      });
      adapter.getCase = vi.fn()
        .mockResolvedValueOnce(active)
        .mockResolvedValueOnce(terminal);
      adapter.claimRunRetryDispatch = vi.fn(async () => ({ ...failedRun, retry_dispatched: true }));
      adapter.resolveAndRunReview = vi.fn(async () => ({ run: makeRun({ run_id: 'run_should_not_exist' }) }));

      const outcome = await new RunCompletionHandler(adapter).dispatchScheduledRetry(failedRun);

      // The second read is retryRun's post-claim race guard. Removing it makes
      // resolveAndRunReview create a fresh Run on the now-completed Case.
      expect(outcome).toBe('not_eligible');
      expect(adapter.resolveAndRunReview).not.toHaveBeenCalled();
    });

    it('claims and dispatches when the claim succeeds', async () => {
      const case_ = makeCase({ status: 'in_review' });
      const adapter = makeAdapter(case_);
      adapter.getActiveRuns = vi.fn(async () => []);
      adapter.resolveAndRunReview = vi.fn(async () => ({ run: makeRun({ run_type: 'review_run' }) }));

      const failedRun = makeRun({
        run_id: 'run_failed_1',
        case_id: 'case_test',
        run_type: 'review_run',
        status: 'failed',
        attempt: 1,
      });
      adapter.claimRunRetryDispatch = vi.fn(async () => ({ ...failedRun, retry_dispatched: true }));

      const handler = new RunCompletionHandler(adapter);
      const outcome = await handler.dispatchScheduledRetry(failedRun);

      expect(outcome).toBe('dispatched');
      expect(adapter.resolveAndRunReview).toHaveBeenCalledWith('case_test', 2);
    });

    it('no-ops when the claim is already held (second caller loses the race)', async () => {
      const case_ = makeCase({ status: 'in_review' });
      const adapter = makeAdapter(case_);
      adapter.getActiveRuns = vi.fn(async () => []);
      adapter.resolveAndRunReview = vi.fn(async () => ({ run: makeRun({ run_type: 'review_run' }) }));
      adapter.claimRunRetryDispatch = vi.fn(async () => null); // already claimed

      const failedRun = makeRun({
        run_id: 'run_failed_1',
        case_id: 'case_test',
        run_type: 'review_run',
        status: 'failed',
        attempt: 1,
      });

      const handler = new RunCompletionHandler(adapter);
      const outcome = await handler.dispatchScheduledRetry(failedRun);

      expect(outcome).toBe('already_claimed');
      expect(adapter.resolveAndRunReview).not.toHaveBeenCalled();
    });

    it('double-dispatch guard: when the in-process timer AND the sweep both fire, exactly one dispatch proceeds', async () => {
      const case_ = makeCase({ status: 'in_review' });
      const adapter = makeAdapter(case_);
      adapter.getActiveRuns = vi.fn(async () => []);
      adapter.resolveAndRunReview = vi.fn(async () => ({ run: makeRun({ run_type: 'review_run' }) }));

      const failedRun = makeRun({
        run_id: 'run_failed_1',
        case_id: 'case_test',
        run_type: 'review_run',
        status: 'failed',
        attempt: 1,
      });

      // Simulate the real Firestore transaction's exactly-once semantics:
      // the FIRST caller (whichever of {timer, sweep} gets there first)
      // claims; every subsequent call for the same run gets null.
      let claimed = false;
      adapter.claimRunRetryDispatch = vi.fn(async () => {
        if (claimed) return null;
        claimed = true;
        return { ...failedRun, retry_dispatched: true };
      });

      const handler = new RunCompletionHandler(adapter);

      // "Timer" and "sweep" both fire for the same overdue retry.
      const [timerOutcome, sweepOutcome] = await Promise.all([
        handler.dispatchScheduledRetry(failedRun),
        handler.dispatchScheduledRetry(failedRun),
      ]);

      const outcomes = [timerOutcome, sweepOutcome].sort();
      expect(outcomes).toEqual(['already_claimed', 'dispatched']);
      // Exactly ONE new run got created for the retry, not two.
      expect(adapter.resolveAndRunReview).toHaveBeenCalledTimes(1);
    });

    it('returns not_eligible when the adapter has no claim support', async () => {
      const case_ = makeCase({ status: 'in_review' });
      const adapter = makeAdapter(case_);
      adapter.claimRunRetryDispatch = undefined as unknown as typeof adapter.claimRunRetryDispatch;

      const handler = new RunCompletionHandler(adapter);
      const failedRun = makeRun({ run_id: 'run_x', case_id: 'case_test', run_type: 'review_run', status: 'failed' });

      const outcome = await handler.dispatchScheduledRetry(failedRun);
      expect(outcome).toBe('not_eligible');
    });
  });

  describe('alreadyRunning guard stays honest across a failure', () => {
    it('schedules a fresh rule_run entering in_validation even though a FAILED rule_run exists in the case history', async () => {
      const case_ = makeCase({ status: 'in_build', current_branch: 'feat/test' });
      const createdRuns: Run[] = [];
      const adapter = makeAdapter(case_, {
        runs: [
          makeRun({ run_type: 'build_run', status: 'completed' }),
          // A previously-failed rule_run is part of history/context...
          makeRun({ run_type: 'rule_run', status: 'failed', run_id: 'run_old_failed' }),
        ],
        evidence: [
          {
            evidence_id: 'ev_1',
            case_id: 'case_test',
            type: 'ci_result',
            source_type: 'automated',
            summary: 'CI green',
            machine_readable: true,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          } as any,
        ],
      });
      // ...but `getActiveRuns` (status in [pending, running]) correctly excludes
      // it — this is the guard `scheduleRunsForStatus`'s `alreadyRunning` check
      // reads, and it must stay honest so a retry is never blocked by its own
      // prior failure.
      adapter.getActiveRuns = vi.fn(async () => []);
      adapter.createRun = vi.fn(async (_caseId: string, runType: RunType) => {
        const run = makeRun({ run_id: `run_new_${createdRuns.length}`, run_type: runType });
        createdRuns.push(run);
        return run;
      });
      adapter.completeRun = vi.fn(async (runId: string) => {
        const run = createdRuns.find((r) => r.run_id === runId);
        if (run) run.status = 'completed';
        return run ?? makeRun({ status: 'completed' });
      });

      const handler = new RunCompletionHandler(adapter);
      const result = await handler.onRunCompleted('case_test');

      expect(result.transitions[0]).toEqual({ from: 'in_build', to: 'in_validation' });
      expect(result.scheduled_runs.some((r) => r.run_type === 'rule_run')).toBe(true);
    });
  });
});
