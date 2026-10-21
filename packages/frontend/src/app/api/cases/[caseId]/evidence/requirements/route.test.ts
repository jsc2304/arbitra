/**
 * @file GET /api/cases/:id/evidence/requirements — where the optional-evidence
 * list comes from.
 *
 * The Clerk evidence policy declares `optional_evidence_types: []`, but this
 * route used to answer with the built-in direct-track default for every case,
 * which is how Test Results / Lint / Code Diff appeared as optional evidence on
 * a Clerk task and made a complete case read as unfinished (#779, assistant
 * cases only). Issue #780: every other case type had the same defect — a
 * project's stored custom policy was ignored and the built-in default answered
 * instead. Both the required and the optional list now come from the same
 * `CompletenessEvaluator.getEffectivePolicyRule` resolution, for every case
 * type.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { getCase, evaluate, getEffectivePolicyRule, getEvidenceForCase } = vi.hoisted(() => ({
  getCase: vi.fn(),
  evaluate: vi.fn(),
  getEffectivePolicyRule: vi.fn(),
  getEvidenceForCase: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  CaseService: class {
    getCase = getCase;
  },
  EvidenceService: class {
    getEvidenceForCase = getEvidenceForCase;
  },
  CompletenessEvaluator: class {
    evaluate = evaluate;
    getEffectivePolicyRule = getEffectivePolicyRule;
  },
}));

const { authenticate, requireCaseAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireCaseAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', () => ({
  authenticate,
  requireCaseAccess,
  handleError: () => NextResponse.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 }),
}));

import { GET } from './route';

function request(): NextRequest {
  return new NextRequest('http://localhost/api/cases/case_1/evidence/requirements');
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_1' });
  requireCaseAccess.mockResolvedValue(null);
  getEvidenceForCase.mockResolvedValue([]);
  evaluate.mockResolvedValue({
    required: ['task_result'],
    present: ['task_result'],
    missing: [],
    satisfied: true,
    four_eyes_required: false,
    allow_self_approval: true,
  });
  getEffectivePolicyRule.mockResolvedValue({
    required_evidence_types: ['task_result'],
    optional_evidence_types: [],
    four_eyes_required: false,
    allow_self_approval: true,
  });
});

describe('optional evidence types', () => {
  it('answers a Clerk task from its own policy, not the engineering default', async () => {
    getCase.mockResolvedValue({
      case_id: 'case_1',
      case_type: 'assistant_task',
      validation_track: 'direct',
      risk_level: 'low',
    });

    const body = await (await GET(request(), { params: Promise.resolve({ caseId: 'case_1' }) })).json();

    expect(body.optional).toEqual([]);
    expect(getEffectivePolicyRule).toHaveBeenCalledWith(
      expect.objectContaining({ case_id: 'case_1' }),
    );
  });

  // Reverting the fix (branching optional-list source on case_type, with
  // non-assistant types reading `getDefaultPolicyRule(...).optional_evidence_types`
  // instead of the resolved policy rule) makes this test fail: it would return
  // the built-in default's `['unit_test_result', 'lint_result', 'diff_snapshot']`
  // instead of the project's custom `[]`, and `getEffectivePolicyRule` would
  // never be called for this case type.
  it('answers a non-assistant case from its project policy, not the engineering default (#780)', async () => {
    getCase.mockResolvedValue({
      case_id: 'case_2',
      case_type: 'bugfix',
      validation_track: 'direct',
      risk_level: 'low',
    });
    getEffectivePolicyRule.mockResolvedValue({
      required_evidence_types: ['ci_result'],
      optional_evidence_types: ['manual_test_notes'],
      four_eyes_required: false,
      allow_self_approval: true,
    });

    const body = await (await GET(request(), { params: Promise.resolve({ caseId: 'case_2' }) })).json();

    expect(body.optional).toEqual(['manual_test_notes']);
    expect(getEffectivePolicyRule).toHaveBeenCalledWith(
      expect.objectContaining({ case_id: 'case_2' }),
    );
  });

  it('falls back to the built-in default when the resolver has no project policy', async () => {
    getCase.mockResolvedValue({
      case_id: 'case_3',
      case_type: 'refactoring',
      validation_track: 'direct',
      risk_level: 'low',
    });
    // The evaluator's own fallback path (no stored policy) resolves to the
    // built-in default rule — same value, just returned through the resolver
    // instead of a constant read directly from `@arbitra/shared` in the route.
    getEffectivePolicyRule.mockResolvedValue({
      required_evidence_types: ['unit_test_result'],
      optional_evidence_types: ['unit_test_result', 'lint_result', 'diff_snapshot'],
      four_eyes_required: false,
      allow_self_approval: true,
    });

    const body = await (await GET(request(), { params: Promise.resolve({ caseId: 'case_3' }) })).json();

    expect(body.optional).toEqual(['unit_test_result', 'lint_result', 'diff_snapshot']);
  });
});
