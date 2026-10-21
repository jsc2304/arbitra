/**
 * @file GET /api/cases/[caseId]/human-confirmation-gates — no route test
 * existed before this file (issue #738 point 3). Covers: authz (case-access denial short-circuits before any repository
 * read), the happy path (blocked `human_confirmation` results enriched with
 * the rule name; non-blocked and non-`human_confirmation` results filtered
 * out; the no-blocked-results early return), and the error path (an
 * unexpected repository failure is handled, not left to crash the route).
 *
 * Follows the `vi.hoisted` + `vi.mock('@arbitra/backend', ...)` +
 * `vi.mock('@/lib/api-helpers', ...)` shape used across the sibling case
 * routes (e.g. `evidence/requirements/route.test.ts`, `runs/route.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { Rule, RuleResult } from '@arbitra/shared';

const { getRuleResultsByCaseId, getRulesByIds } = vi.hoisted(() => ({
  getRuleResultsByCaseId: vi.fn(),
  getRulesByIds: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  RuleRepository: class {
    getRuleResultsByCaseId = getRuleResultsByCaseId;
    getRulesByIds = getRulesByIds;
  },
}));

const { authenticate, requireCaseAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireCaseAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', () => ({
  authenticate,
  requireCaseAccess,
  handleError: (error: unknown) =>
    NextResponse.json(
      { error: { message: error instanceof Error ? error.message : String(error) } },
      { status: 500 },
    ),
}));

import { GET } from './route';

function request(): NextRequest {
  return new NextRequest('http://localhost/api/cases/case_1/human-confirmation-gates');
}

function makeRuleResult(overrides: Partial<RuleResult> = {}): RuleResult {
  return {
    rule_result_id: 'rr_1',
    rule_id: 'rule_1',
    case_id: 'case_1',
    run_id: 'run_1',
    result_status: 'blocked',
    message: 'Human confirmation required',
    evidence_refs: [],
    evaluated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    rule_id: 'rule_1',
    name: 'Deployment window confirmation',
    category: 'release_gate',
    scope: { layer: 'global', ref: 'global' },
    evaluation_mode: 'human_confirmation',
    severity_if_failed: 'high',
    config: {},
    description: '',
    rationale: '',
    status: 'active',
    version: 1,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_1' });
  requireCaseAccess.mockResolvedValue(null);
  getRuleResultsByCaseId.mockResolvedValue([]);
  getRulesByIds.mockResolvedValue([]);
});

describe('GET /api/cases/[caseId]/human-confirmation-gates — authz', () => {
  it('returns the case-access denial and never reads rule results', async () => {
    requireCaseAccess.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const response = await GET(request(), { params: Promise.resolve({ caseId: 'case_1' }) });

    expect(response.status).toBe(404);
    expect(requireCaseAccess).toHaveBeenCalledWith('case_1', 'usr_1');
    expect(getRuleResultsByCaseId).not.toHaveBeenCalled();
  });
});

describe('GET /api/cases/[caseId]/human-confirmation-gates — happy path', () => {
  it('returns an enriched gate for a blocked human_confirmation result', async () => {
    getRuleResultsByCaseId.mockResolvedValue([
      makeRuleResult({ rule_result_id: 'rr_1', rule_id: 'rule_1', result_status: 'blocked' }),
    ]);
    getRulesByIds.mockResolvedValue([makeRule({ rule_id: 'rule_1', name: 'Deployment window confirmation' })]);

    const body = await (await GET(request(), { params: Promise.resolve({ caseId: 'case_1' }) })).json();

    expect(body.gates).toEqual([
      {
        rule_result_id: 'rr_1',
        rule_id: 'rule_1',
        rule_name: 'Deployment window confirmation',
        message: 'Human confirmation required',
      },
    ]);
  });

  it('excludes a blocked result whose rule is NOT human_confirmation', async () => {
    getRuleResultsByCaseId.mockResolvedValue([
      makeRuleResult({ rule_result_id: 'rr_1', rule_id: 'rule_1', result_status: 'blocked' }),
    ]);
    getRulesByIds.mockResolvedValue([
      makeRule({ rule_id: 'rule_1', evaluation_mode: 'metadata_check' }),
    ]);

    const body = await (await GET(request(), { params: Promise.resolve({ caseId: 'case_1' }) })).json();

    expect(body.gates).toEqual([]);
  });

  it('excludes a human_confirmation result that already passed', async () => {
    getRuleResultsByCaseId.mockResolvedValue([
      makeRuleResult({ rule_result_id: 'rr_1', rule_id: 'rule_1', result_status: 'pass' }),
    ]);

    const body = await (await GET(request(), { params: Promise.resolve({ caseId: 'case_1' }) })).json();

    expect(body.gates).toEqual([]);
    // Nothing blocked -> the route's early return skips the rule lookup entirely.
    expect(getRulesByIds).not.toHaveBeenCalled();
  });

  it('returns an empty list without calling getRulesByIds when there are no results at all', async () => {
    getRuleResultsByCaseId.mockResolvedValue([]);

    const body = await (await GET(request(), { params: Promise.resolve({ caseId: 'case_1' }) })).json();

    expect(body.gates).toEqual([]);
    expect(getRulesByIds).not.toHaveBeenCalled();
  });
});

describe('GET /api/cases/[caseId]/human-confirmation-gates — error path', () => {
  it('hands an unexpected repository failure to handleError instead of throwing', async () => {
    getRuleResultsByCaseId.mockRejectedValue(new Error('Firestore unavailable'));

    const response = await GET(request(), { params: Promise.resolve({ caseId: 'case_1' }) });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.message).toBe('Firestore unavailable');
  });
});
