import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getDefaultPolicyRule } from '@arbitra/shared';
import type { CaseStatus, CaseType, LifecycleProfile } from '@arbitra/shared';

// ---------------------------------------------------------------------------
// Mocks — wired before importing the route so the module picks them up.
//
// The route uses dynamic `await import('@arbitra/backend')` for `collections`
// and `DecisionService`, so the factory is invoked multiple times per request.
// All service methods are spied so tests can assert exact shapes.
// ---------------------------------------------------------------------------

const {
  getCase,
  getEvidenceForCase,
  completenessEvaluate,
  getEffectivePolicyRule,
  getHistory,
  loadPreconditionContext,
  evaluatePrecondition,
  projectsDocGet,
  findingsWhereGet,
  getDecisionsForCase,
  safeHeartbeat,
} = vi.hoisted(() => ({
  getCase: vi.fn(),
  getEvidenceForCase: vi.fn(),
  completenessEvaluate: vi.fn(),
  getEffectivePolicyRule: vi.fn(),
  getHistory: vi.fn(),
  loadPreconditionContext: vi.fn(),
  evaluatePrecondition: vi.fn(),
  projectsDocGet: vi.fn(),
  findingsWhereGet: vi.fn(),
  getDecisionsForCase: vi.fn(),
  safeHeartbeat: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  CaseService: vi.fn().mockImplementation(() => ({ getCase })),
  EvidenceService: vi.fn().mockImplementation(() => ({ getEvidenceForCase })),
  CompletenessEvaluator: vi.fn().mockImplementation(() => ({
    evaluate: completenessEvaluate,
    getEffectivePolicyRule,
  })),
  EventService: vi.fn().mockImplementation(() => ({ getHistory })),
  FirestorePipelineAdapter: vi.fn().mockImplementation(() => ({ loadPreconditionContext })),
  createPreconditionEvaluator: vi.fn().mockImplementation(() => ({
    evaluate: evaluatePrecondition,
  })),
  DecisionService: vi.fn().mockImplementation(() => ({ getDecisionsForCase })),
  safeHeartbeat,
  collections: {
    projects: () => ({
      doc: () => ({ get: projectsDocGet }),
    }),
    findings: () => ({
      where: () => ({ where: () => ({ get: findingsWhereGet }) }),
    }),
  },
}));

const { authenticate, requireCaseAccess, handleError } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireCaseAccess: vi.fn(),
  handleError: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    requireCaseAccess,
    handleError: (err: unknown) => {
      handleError(err);
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status: 500 });
    },
  };
});

import { GET } from './route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(caseId: string): NextRequest {
  return new NextRequest(`http://localhost/api/agent/context/${caseId}`);
}

function baseCase(overrides: Record<string, unknown> = {}) {
  return {
    case_id: 'case_1',
    title: 'Test',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'user_1',
    status: 'in_build',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireCaseAccess.mockResolvedValue(null);

  getEvidenceForCase.mockResolvedValue([]);
  completenessEvaluate.mockResolvedValue({
    required: [],
    optional: [],
    present: [],
    missing: [],
    satisfied: true,
  });
  getHistory.mockResolvedValue([]);
  // The Clerk policy cell, as `clerk-core-documents.ts` writes it.
  getEffectivePolicyRule.mockResolvedValue({
    required_evidence_types: ['task_result'],
    optional_evidence_types: [],
    four_eyes_required: false,
    allow_self_approval: true,
  });

  // Default precondition context and evaluator — overridden per test.
  loadPreconditionContext.mockResolvedValue({
    case_: {},
    runs: [],
    findings: [],
    ruleResults: [],
    evidence: [],
    decisions: [],
    events: [],
    actorId: 'system',
  });
  evaluatePrecondition.mockImplementation(async (_id: string) => ({
    satisfied: false,
    reason: 'not met',
  }));

  projectsDocGet.mockResolvedValue({
    exists: true,
    data: () => ({
      name: 'Proj One',
      reviewer_pool: ['user_r'],
      default_evidence_policy_id: undefined,
      default_validation_track: 'direct',
    }),
  });

  findingsWhereGet.mockResolvedValue({ docs: [] });
  getDecisionsForCase.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/agent/context/[caseId] — presence heartbeat', () => {
  it('writes an ide_agent presence heartbeat for the authenticated user', async () => {
    getCase.mockResolvedValue(baseCase({ status: 'in_build' }));

    await GET(makeReq('case_alpha'), { params: Promise.resolve({ caseId: 'case_alpha' }) });

    expect(safeHeartbeat).toHaveBeenCalledWith({
      caseId: 'case_alpha',
      userId: 'user_1',
      source: 'ide_agent',
    });
  });
});

describe('GET /api/agent/context/[caseId] — preconditions', () => {
  it('populates preconditions with satisfied + reason for every outgoing transition precondition on in_build', async () => {
    getCase.mockResolvedValue(baseCase({ status: 'in_build' }));

    // Evaluator returns mixed results to prove per-ID flow-through.
    evaluatePrecondition.mockImplementation(async (id: string) => {
      if (id === 'build_run_completed') return { satisfied: true };
      if (id === 'has_diff_and_test_strategy') {
        return { satisfied: false, reason: 'No diff/commit reference found' };
      }
      return { satisfied: false, reason: 'not met' };
    });

    const res = await GET(makeReq('case_1'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    // in_build has outgoing transitions referencing (at minimum)
    // has_diff_and_test_strategy, build_run_completed, explicit_rejection.
    expect(body.preconditions).toBeDefined();
    expect(body.preconditions.build_run_completed).toEqual({ satisfied: true });
    expect(body.preconditions.has_diff_and_test_strategy).toEqual({
      satisfied: false,
      reason: 'No diff/commit reference found',
    });
    expect(body.preconditions.explicit_rejection).toBeDefined();
    // Sanity: every entry has a `satisfied` boolean.
    for (const [id, val] of Object.entries(body.preconditions)) {
      expect(typeof (val as { satisfied: boolean }).satisfied).toBe('boolean');
      expect(id).toBeTruthy();
    }
  });

  it('populates preconditions for in_validation (rule_runs + required_evidence)', async () => {
    getCase.mockResolvedValue(baseCase({ status: 'in_validation' }));

    evaluatePrecondition.mockImplementation(async (id: string) => {
      if (id === 'rule_runs_completed') return { satisfied: true };
      if (id === 'required_evidence_satisfied') {
        return { satisfied: false, reason: 'Missing required evidence: ci_result' };
      }
      return { satisfied: false, reason: 'not met' };
    });

    const res = await GET(makeReq('case_1'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.preconditions.rule_runs_completed).toEqual({ satisfied: true });
    expect(body.preconditions.required_evidence_satisfied).toEqual({
      satisfied: false,
      reason: 'Missing required evidence: ci_result',
    });
  });

  it('falls back to unsatisfied + "Evaluation failed" for every expected ID when precondition evaluation throws', async () => {
    getCase.mockResolvedValue(baseCase({ status: 'in_build' }));
    loadPreconditionContext.mockRejectedValue(new Error('boom'));

    const res = await GET(makeReq('case_1'), { params: Promise.resolve({ caseId: 'case_1' }) });
    // Route must stay 200 — precondition failure is swallowed by the catch.
    expect(res.status).toBe(200);
    const body = await res.json();

    // Every precondition ID for in_build outgoing transitions must be present,
    // each with satisfied: false and reason: 'Evaluation failed'.
    const { getTransitionsFrom } = await import('@arbitra/shared');
    const expectedIds = new Set<string>();
    for (const t of getTransitionsFrom('in_build')) {
      for (const p of t.preconditions) expectedIds.add(p);
    }
    expect(expectedIds.size).toBeGreaterThan(0);
    for (const id of expectedIds) {
      expect(body.preconditions[id]).toEqual({
        satisfied: false,
        reason: 'Evaluation failed',
      });
    }
    // Evaluator itself should never have been invoked.
    expect(evaluatePrecondition).not.toHaveBeenCalled();
  });

  it('returns empty preconditions object for terminal status `done`', async () => {
    getCase.mockResolvedValue(baseCase({ status: 'done' }));

    const res = await GET(makeReq('case_1'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.preconditions).toEqual({});
    expect(loadPreconditionContext).not.toHaveBeenCalled();
  });
});

describe('GET /api/agent/context/[caseId] — project.lifecycle_profile', () => {
  it('flows lifecycle_profile through when set on the project', async () => {
    const lifecycleProfile: LifecycleProfile = {
      preset: 'autonomous',
      overrides: { review_to_approved: 'confirm' },
      gate_confirmer_roles: ['tech_lead'],
    };
    getCase.mockResolvedValue(baseCase());
    projectsDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        name: 'Proj One',
        reviewer_pool: ['user_r'],
        default_validation_track: 'direct',
        lifecycle_profile: lifecycleProfile,
      }),
    });

    const res = await GET(makeReq('case_1'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.project).toBeTruthy();
    expect(body.project.lifecycle_profile).toEqual(lifecycleProfile);
  });

  it('leaves lifecycle_profile undefined when project has none', async () => {
    getCase.mockResolvedValue(baseCase());
    projectsDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        name: 'Proj One',
        reviewer_pool: [],
        default_validation_track: 'direct',
      }),
    });

    const res = await GET(makeReq('case_1'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.project).toBeTruthy();
    // JSON.stringify drops undefined — either absent or explicitly undefined.
    expect(body.project.lifecycle_profile).toBeUndefined();
  });
});

describe('GET /api/agent/context/[caseId] — project.default_language', () => {
  it('flows default_language through when set on the project', async () => {
    getCase.mockResolvedValue(baseCase());
    projectsDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        name: 'Proj One',
        reviewer_pool: ['user_r'],
        default_validation_track: 'direct',
        default_language: 'de',
      }),
    });

    const res = await GET(makeReq('case_1'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.project).toBeTruthy();
    expect(body.project.default_language).toBe('de');
  });

  it("defaults default_language to 'en' when the project doc omits it", async () => {
    getCase.mockResolvedValue(baseCase());
    projectsDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        name: 'Proj One',
        reviewer_pool: [],
        default_validation_track: 'direct',
      }),
    });

    const res = await GET(makeReq('case_1'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.project).toBeTruthy();
    expect(body.project.default_language).toBe('en');
  });
});

describe('GET /api/agent/context/[caseId] — case.pending_gate', () => {
  it('flows pending_gate through on the case object when set', async () => {
    const pendingGate = {
      gate_id: 'review_to_approved' as const,
      target_status: 'approved' as const,
      since: '2026-04-16T12:00:00.000Z',
    };
    getCase.mockResolvedValue(
      baseCase({ status: 'in_review', pending_gate: pendingGate }),
    );

    const res = await GET(makeReq('case_1'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.case.pending_gate).toEqual(pendingGate);
  });

  it('leaves pending_gate undefined on the case when not set', async () => {
    getCase.mockResolvedValue(baseCase());

    const res = await GET(makeReq('case_1'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.case.pending_gate).toBeUndefined();
  });
});

describe('GET /api/agent/context/[caseId] — review findings framing', () => {
  it('reframes findings as charges to answer when the case is returned to in_build', async () => {
    getCase.mockResolvedValue(baseCase({ status: 'in_build' }));
    getHistory.mockResolvedValue([
      {
        event_id: 'evt_1',
        case_id: 'case_1',
        type: 'changes_requested',
        actor_id: 'user_r',
        created_at: '2026-04-16T01:00:00.000Z',
      },
    ]);
    getDecisionsForCase.mockResolvedValue([
      {
        type: 'request_changes',
        actor_id: 'user_r',
        rationale: 'Please address the findings.',
      },
    ]);
    findingsWhereGet.mockResolvedValue({
      docs: [
        {
          data: () => ({
            finding_id: 'find_1',
            title: 'Possible null deref',
            severity: 'medium',
            category: 'correctness',
          }),
        },
      ],
    });

    const res = await GET(makeReq('case_1'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    // return_context carries the reframing guidance.
    expect(body.return_context).toBeTruthy();
    expect(typeof body.return_context.guidance).toBe('string');
    expect(body.return_context.guidance.length).toBeGreaterThan(0);
    expect(body.return_context.guidance).toContain('charges to answer');

    // next_steps step 1 reframes "fix all findings" into fix-or-defend.
    expect(
      body.next_steps.some((s: string) => s.includes('defend')),
    ).toBe(true);
  });
});

const NON_ASSISTANT_CASE_TYPES: Exclude<CaseType, 'assistant_task'>[] = [
  'ticket_implementation',
  'bugfix',
  'refactoring',
  'security_review',
  'pr_review',
  'manual_verification',
  'other',
];

async function getContextBody(status: CaseStatus, caseType?: CaseType) {
  getCase.mockResolvedValue(baseCase({
    status,
    ...(caseType !== undefined ? { case_type: caseType } : {}),
  }));
  const response = await GET(makeReq('case_1'), { params: Promise.resolve({ caseId: 'case_1' }) });
  expect(response.status).toBe(200);
  return response.json();
}

describe('agent-context guidance helpers — engineering regression coverage', () => {
  it('keeps getAllowedActions output unchanged for every non-assistant case type', async () => {
    const expected = [
      'build_complete',
      'reject',
      'add_evidence',
      'add_comment',
    ];
    for (const caseType of NON_ASSISTANT_CASE_TYPES) {
      const body = await getContextBody('in_build', caseType);
      expect(body.phase.allowed_actions).toEqual(expected);
    }
  });

  it('keeps getBlockedActions output unchanged for every non-assistant case type', async () => {
    const expected = ['merge', 'approve', 'explore'];
    for (const caseType of NON_ASSISTANT_CASE_TYPES) {
      const body = await getContextBody('in_build', caseType);
      expect(body.phase.blocked_actions).toEqual(expected);
    }
  });

  it('keeps getWarnings output unchanged for every non-assistant case type', async () => {
    const expected = [
      'Do NOT merge PR before reaching pending_merge status',
      'Do NOT skip the build-complete confirmation step',
      'Do NOT stop after committing — push, create PR, and call build-complete to finish',
    ];
    for (const caseType of NON_ASSISTANT_CASE_TYPES) {
      const body = await getContextBody('in_build', caseType);
      expect(body.phase.warnings).toEqual(expected);
    }
  });

  it('keeps getNextSteps output unchanged for every non-assistant case type', async () => {
    const expected = ['1. Run /explore to start exploration'];
    for (const caseType of NON_ASSISTANT_CASE_TYPES) {
      const body = await getContextBody('open', caseType);
      expect(body.next_steps).toEqual(expected);
    }
  });
});

describe('agent-context guidance helpers — assistant lifecycle', () => {
  it('returns assistant-task allowed actions without engineering lifecycle commands', async () => {
    const body = await getContextBody('needs_human_decision', 'assistant_task');
    expect(body.phase.allowed_actions).toEqual([
      'approve',
      'request_changes',
      'reject',
      'add_comment',
    ]);
  });

  it('blocks engineering lifecycle actions for an assistant task', async () => {
    const body = await getContextBody('in_build', 'assistant_task');
    expect(body.phase.blocked_actions).toEqual([
      'explore',
      'build',
      'build_complete',
      'merge',
      'approve',
      'request_changes',
    ]);
  });

  it('warns an in-build assistant task against PR and build-complete guidance', async () => {
    const body = await getContextBody('in_build', 'assistant_task');
    expect(body.phase.warnings).toEqual([
      'Do NOT open or merge a PR, or call build-complete, for an assistant task',
    ]);
  });

  it('describes run-linked result evidence instead of engineering delivery steps', async () => {
    const body = await getContextBody('in_build', 'assistant_task');
    expect(body.next_steps).toEqual([
      '1. Continue the current assistant task run',
      '2. Register task_result evidence with an artifact_ref and the current run_id',
      '3. Complete the assistant_task_run',
      '4. Wait for the case to transition to done automatically',
    ]);
  });
});

describe('GET /api/agent/context/[caseId] — optional evidence', () => {
  it('answers an assistant task from its own policy, not the engineering default', async () => {
    const body = await getContextBody('in_build', 'assistant_task');

    // The Clerk policy declares no optional evidence, so an agent must not be
    // offered test/lint/diff evidence an assistant task cannot produce — and it
    // must read the same as `GET /api/cases/:id/evidence/requirements` does.
    expect(getEffectivePolicyRule).toHaveBeenCalled();
    expect(body.evidence.optional).toEqual([]);
  });

  it('keeps the default-based optional list for every non-assistant case type', async () => {
    for (const caseType of NON_ASSISTANT_CASE_TYPES) {
      getEffectivePolicyRule.mockClear();
      const body = await getContextBody('in_build', caseType);

      expect(getEffectivePolicyRule).not.toHaveBeenCalled();
      // The real direct/low default rule, unchanged by this route.
      expect(body.evidence.optional.map((e: { type: string }) => e.type)).toEqual(
        getDefaultPolicyRule('direct', 'low').optional_evidence_types,
      );
    }
  });
});
