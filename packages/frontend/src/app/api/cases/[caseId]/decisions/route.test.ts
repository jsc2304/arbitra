import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { createDecision, getDecisionsForCase } = vi.hoisted(() => ({
  createDecision: vi.fn(),
  getDecisionsForCase: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  DecisionService: class {
    createDecision = createDecision;
    getDecisionsForCase = getDecisionsForCase;
  },
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T =>
    schema.parse(body),
}));

const { authenticate, requireCaseAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireCaseAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => ({
  authenticate,
  requireCaseAccess,
  handleError: (error: unknown) => {
    const isValidation = error instanceof Error && 'issues' in error;
    return NextResponse.json(
      {
        error: {
          code: isValidation ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
          details: isValidation
            ? { issues: (error as Error & { issues: unknown[] }).issues }
            : undefined,
        },
      },
      { status: isValidation ? 400 : 500 },
    );
  },
}));

import { POST } from './route';

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/cases/case_1/decisions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireCaseAccess.mockResolvedValue(null);
  createDecision.mockResolvedValue({
    decision: {
      decision_id: 'decision_1',
      case_id: 'case_1',
      type: 'approve',
      rationale: 'Looks good',
      actor_id: 'user_1',
      snapshot: {
        active_rule_set_versions: {},
        evidence_policy_version: 1,
        knowledge_asset_refs: [],
      },
      created_at: '2026-04-21T10:00:00Z',
    },
  });
});

describe('POST /api/cases/:caseId/decisions', () => {
  it('returns structured validation errors for invalid decision payloads', async () => {
    const response = await POST(
      makeReq({ type: 'approve' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const issuePaths = body.error.details.issues.map((issue: { path: unknown[] }) => issue.path.join('.'));
    expect(issuePaths).toContain('rationale');
    expect(createDecision).not.toHaveBeenCalled();
  });

  it.each(['auto_approve', 'waived_on_completion'])(
    'rejects the system-only decision type %s with a 400 and never reaches the service',
    async (type) => {
      // System decisions are written by the pipeline with actor `system:pipeline`.
      // A caller must not be able to forge one through this route (issue #751).
      const response = await POST(
        makeReq({ type, rationale: 'Trying to forge a system decision' }),
        { params: Promise.resolve({ caseId: 'case_1' }) },
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      const issuePaths = body.error.details.issues.map((issue: { path: unknown[] }) =>
        issue.path.join('.'),
      );
      expect(issuePaths).toContain('type');
      expect(createDecision).not.toHaveBeenCalled();
    },
  );

  it('injects the route caseId and creates a decision', async () => {
    const response = await POST(
      makeReq({
        type: 'approve',
        rationale: 'Ready to approve after review',
      }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(response.status).toBe(201);
    expect(createDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        case_id: 'case_1',
        type: 'approve',
        rationale: 'Ready to approve after review',
      }),
      'user_1',
    );
  });

  it('normalizes actor_metadata before passing to the service (lowercases client_name)', async () => {
    // Mirrors the comments route: caller-supplied casing is normalized at the
    // boundary so persisted documents stay consistent regardless of how the
    // MCP client cased its client_name.
    const response = await POST(
      makeReq({
        type: 'approve',
        rationale: 'Filed via Cursor session',
        actor_metadata: {
          client_name: 'Cursor',
          client_version: '0.42.1',
          model: 'Claude-Opus-4-7',
        },
      }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(response.status).toBe(201);
    expect(createDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        case_id: 'case_1',
        type: 'approve',
        actor_metadata: {
          client_name: 'cursor',
          client_version: '0.42.1',
          model: 'claude-opus-4-7',
        },
      }),
      'user_1',
    );
  });

  it('omits actor_metadata when the request body did not include it (back-compat)', async () => {
    await POST(
      makeReq({ type: 'approve', rationale: 'Filed from web UI' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(createDecision).toHaveBeenCalledTimes(1);
    const call = createDecision.mock.calls[0] ?? [];
    const serviceInput = call[0] as { actor_metadata?: unknown };
    expect(serviceInput.actor_metadata).toBeUndefined();
  });

  it('reaches the service with the client type review_not_applicable', async () => {
    // Covers: `DECISION_TYPES` in packages/shared/src/types/decision.ts — if
    // `review_not_applicable` were removed from the client-derived union (or
    // moved into `SYSTEM_DECISION_TYPES`), `createDecisionSchema` would reject
    // this payload with a 400 and `createDecision` would never be called.
    createDecision.mockResolvedValueOnce({
      decision: {
        decision_id: 'decision_3',
        case_id: 'case_1',
        type: 'review_not_applicable',
        rationale: 'Review run fails permanently — provider billing error.',
        actor_id: 'user_1',
        snapshot: {
          active_rule_set_versions: {},
          evidence_policy_version: 1,
          knowledge_asset_refs: [],
        },
        created_at: '2026-04-21T12:00:00Z',
      },
    });

    const response = await POST(
      makeReq({
        type: 'review_not_applicable',
        rationale: 'Review run fails permanently — provider billing error.',
      }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(response.status).toBe(201);
    expect(createDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        case_id: 'case_1',
        type: 'review_not_applicable',
      }),
      'user_1',
    );
  });

  it('surfaces a service guard error (e.g. wrong status) with its message', async () => {
    // Covers: decision-service.ts createReviewNotApplicableDecision's
    // `REVIEW_NOT_APPLICABLE_WRONG_STATUS` guard — the route must forward the
    // thrown error's message to the caller rather than swallowing it.
    createDecision.mockRejectedValueOnce(
      Object.assign(new Error('Cannot record review_not_applicable: case case_1 is in_build, not in_review.'), {
        code: 'REVIEW_NOT_APPLICABLE_WRONG_STATUS',
        statusCode: 409,
      }),
    );

    const response = await POST(
      makeReq({ type: 'review_not_applicable', rationale: 'trying too early' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    const body = await response.json();
    expect(body.error.message).toMatch(/not in_review/i);
  });

  it('forwards transition_error from the service into the response body', async () => {
    // Regression: when the post-decision transition fails (e.g. case stuck
    // in_review with no review run), the service still persists the decision
    // and returns a structured `transition_error`. The route must forward it
    // so the UI can warn instead of toasting "submitted successfully".
    createDecision.mockResolvedValueOnce({
      decision: {
        decision_id: 'decision_2',
        case_id: 'case_1',
        type: 'approve',
        rationale: 'Approved despite stuck status',
        actor_id: 'user_1',
        snapshot: {
          active_rule_set_versions: {},
          evidence_policy_version: 1,
          knowledge_asset_refs: [],
        },
        created_at: '2026-04-21T11:00:00Z',
      },
      transition_error: {
        code: 'TRANSITION_FAILED',
        message: 'preconditions not met: review_run_completed',
      },
    });

    const response = await POST(
      makeReq({ type: 'approve', rationale: 'Approved despite stuck status' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.decision_id).toBe('decision_2');
    expect(body.transition_error).toEqual({
      code: 'TRANSITION_FAILED',
      message: 'preconditions not met: review_run_completed',
    });
  });
});
