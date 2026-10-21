/**
 * Issue #1079 — end-to-end regression: a case created via
 * `CaseService.createCase` with `git_context.commit_sha` set must have
 * something for the autonomous approval pin (#1045, `approval-pin.ts`) to
 * pin. Before the fix, `createCase` never copied `commit_sha` onto
 * `current_head_sha`, so a case approved by the autonomous pipeline before
 * any PR webhook arrived reached `approved` with `approved_head_sha`
 * unset — the next push then failed the `arbitra/case` required check
 * closed (PR #1077).
 *
 * This test DRIVES the transition through `RunCompletionHandler`, starting
 * from the case `CaseService.createCase` actually produced — it does not
 * construct an already-`approved` case with `current_head_sha` hand-set,
 * which is exactly the shortcut that let the pin's first cut ship broken
 * (see the comment on the `approval pin` describe block in
 * `pipeline.test.ts`).
 *
 * Scope: only the `create_case` persistence fix from #1079 is exercised
 * here. Pipeline refusal behaviour and GitHub-backfill for a case created
 * with no commit SHA at all are separate concerns (#1079
 * "Expected"), not covered by this test.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Case, CaseStatus, EventType, Run, RunType } from '@arbitra/shared';
import type { PipelineAdapter } from './pipeline-adapter.js';
import type { PreconditionContext } from './preconditions.js';

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

// Minimal Firestore double: just enough `collections.cases()` for
// `CaseService.createCase` (via `CaseRepository.create`) to persist the
// case this test then hands to the pipeline's fake adapter.
const caseDocs = new Map<string, Case>();
vi.mock('../../lib/firestore.js', () => ({
  collections: {
    cases: () => ({
      doc: (id: string) => ({
        set: async (data: Case) => {
          caseDocs.set(id, data);
        },
        get: async () => {
          const c = caseDocs.get(id);
          return { exists: c !== undefined, data: () => c };
        },
      }),
    }),
    projects: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }),
  },
  // Minimal double for `case-pipeline-lock.ts` (per-case lock): the lock
  // is best-effort (it logs and proceeds without it on failure), so this
  // only needs to not throw.
  getDb: () => ({
    collection: () => ({ doc: () => ({}) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async () => ({ exists: false, data: () => undefined }),
        set: () => undefined,
        delete: () => undefined,
      }),
  }),
}));

const { CaseService } = await import('../case/case-service.js');
const { CaseRepository } = await import('../case/case-repository.js');
const { RunCompletionHandler } = await import('./pipeline.js');

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: 'run_test',
    case_id: 'case_test',
    run_type: 'review_run',
    trigger_source: 'system',
    status: 'completed',
    input_refs: [],
    output_refs: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// Same fake pipeline adapter shape as pipeline.test.ts: `updateCaseStatus`
// must apply `extraUpdates` (the approval pin patch) for this test to mean
// anything.
function makeAdapter(
  initialCase: Case,
  context?: Partial<PreconditionContext>,
): PipelineAdapter & { transitions: Array<{ caseId: string; status: CaseStatus }> } {
  let currentCase = { ...initialCase };
  const transitions: Array<{ caseId: string; status: CaseStatus }> = [];

  return {
    transitions,
    getCase: vi.fn(async () => currentCase),
    updateCaseStatus: vi.fn(async (
      _caseId: string,
      status: CaseStatus,
      extraUpdates: Partial<Case> = {},
    ) => {
      transitions.push({ caseId: _caseId, status });
      currentCase = { ...currentCase, ...extraUpdates, status };
      return currentCase;
    }),
    updateCase: vi.fn(async (_caseId: string, updates: Partial<Case>) => {
      currentCase = { ...currentCase, ...updates };
      return currentCase;
    }),
    loadPreconditionContext: vi.fn(async () => ({
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
    createAutoApproveDecision: vi.fn(async () => ({
      decision_id: 'dec_auto',
      case_id: 'case_test',
      type: 'auto_approve',
      actor_id: 'system',
      rationale: 'Auto-approved',
      snapshot: {},
      created_at: '2026-01-01T00:00:00Z',
    })),
    closeOutstandingWaiverProposals: vi.fn(async () => ({ closed: 0 })),
    createMergeNotApplicableDecision: vi.fn(async () => ({
      decision_id: 'dec_mna',
      case_id: 'case_test',
      type: 'merge_not_applicable',
      actor_id: 'system:pipeline',
      rationale: 'Auto-attached on approval: no PR and no branch',
      snapshot: {},
      created_at: '2026-01-01T00:00:00Z',
    })),
    emitEvent: vi.fn(async (_caseId: string, _type: EventType) => undefined),
    getActiveRuns: vi.fn(async () => []),
    getProjectLifecycleProfile: vi.fn(async () => undefined),
    scheduleRunRetry: vi.fn(async () => {}),
    claimRunRetryDispatch: vi.fn(async () => null),
  } as unknown as PipelineAdapter & { transitions: Array<{ caseId: string; status: CaseStatus }> };
}

describe('create_case -> autonomous approve pins the observed head SHA (#1079)', () => {
  it('a case created with git_context.commit_sha reaches approved with approved_head_sha set', async () => {
    // Revert line to make this fail: drop
    // `current_head_sha: input.git_context?.commit_sha,` from the `newCase`
    // object literal in `CaseService.createCase`
    // (packages/backend/src/services/case/case-service.ts). Without it the
    // case created below has no `current_head_sha`, and
    // `approvalPinPatch` clears the pin instead of stamping it.
    const caseService = new CaseService(new CaseRepository(), { emit: vi.fn().mockResolvedValue(undefined) } as never);

    const created = await caseService.createCase(
      {
        title: 'Fix deploy path risk pattern',
        description: 'Repro of #1079',
        source_type: 'manual',
        project_id: 'proj_test',
        repository_id: 'repo_test',
        risk_level: 'low',
        priority: 'normal',
        validation_track: 'direct',
        case_type: 'bugfix',
        current_branch: 'fix/deploy-path-risk-pattern',
        git_context: {
          branch: 'fix/deploy-path-risk-pattern',
          remote_url: 'https://github.com/acme/primary.git',
          commit_sha: '41ecf2aa',
        },
      },
      'usr_owner',
    );

    // Sanity check on the create-path fix itself before driving the pipeline.
    expect(created.current_head_sha).toBe('41ecf2aa');

    const inReview: Case = { ...created, status: 'in_review' };
    const adapter = makeAdapter(inReview, {
      // reviewed_head_sha matches `created.current_head_sha` (issue #1054)
      // — otherwise the commit-binding gate blocks this before it ever
      // reaches the approval-pin behavior under test.
      runs: [makeRun({ run_type: 'review_run', status: 'completed', reviewed_head_sha: '41ecf2aa' })],
      findings: [],
      ruleResults: [],
      decisions: [{ type: 'auto_approve', actor_id: 'system' }] as never,
    });
    const handler = new RunCompletionHandler(adapter);

    const result = await handler.onRunCompleted(created.case_id);

    expect(result.transitions[0]).toEqual({ from: 'in_review', to: 'approved' });
    expect((await adapter.getCase(created.case_id)).approved_head_sha).toBe('41ecf2aa');
  });
});
