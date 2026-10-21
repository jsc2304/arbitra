import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  requireRole,
  checkIsAdmin,
  getAccessibleProjectIds,
  createOverrideMock,
  listOverridesMock,
  RuleOverrideServiceMock,
} = vi.hoisted(() => {
  const createOverrideMock = vi.fn();
  const listOverridesMock = vi.fn();
  class RuleOverrideServiceMock {
    createOverride = createOverrideMock;
    listOverrides = listOverridesMock;
  }
  return {
    requireRole: vi.fn(),
    checkIsAdmin: vi.fn(),
    getAccessibleProjectIds: vi.fn(),
    createOverrideMock,
    listOverridesMock,
    RuleOverrideServiceMock,
  };
});

vi.mock('@arbitra/backend', () => ({
  requireRole,
  checkIsAdmin,
  getAccessibleProjectIds,
  RuleOverrideService: RuleOverrideServiceMock,
}));

const { authenticate, requireProjectAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    requireProjectAccess,
    // Real passthrough — the schema itself (imported for real from
    // @arbitra/shared by route.ts) does the actual validating, so a bad
    // payload genuinely throws a ZodError here rather than a mocked stub
    // silently accepting anything.
    validate: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T => schema.parse(body),
    handleError: (error: unknown) => {
      const isValidation = error instanceof Error && 'issues' in error;
      if (isValidation) {
        return NextResponse.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid request payload',
              details: { issues: (error as Error & { issues: unknown[] }).issues },
            },
          },
          { status: 400 },
        );
      }
      const status = (error as { statusCode?: number })?.statusCode ?? 500;
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: { message } }, { status });
    },
  };
});

import { GET, POST } from './route';

function makePostReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/rules/overrides', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function makeGetReq(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/rules/overrides${query}`, { method: 'GET' });
}

const validBody = {
  rule_id: 'rule_global_1',
  overriding_rule_id: 'rule_project_1',
  scope: { layer: 'project' as const, ref: 'proj_1' },
  rationale: 'Project needs console logging for this integration debug tooling.',
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_1' });
  requireProjectAccess.mockResolvedValue(null);
  requireRole.mockResolvedValue(['tech_lead']);
  checkIsAdmin.mockResolvedValue(false);
  getAccessibleProjectIds.mockResolvedValue('all');
  createOverrideMock.mockResolvedValue({
    override_id: 'ro_1',
    rule_id: validBody.rule_id,
    overriding_rule_id: validBody.overriding_rule_id,
    scope: validBody.scope,
    rationale: validBody.rationale,
    version: 1,
    rule_version: 1,
    overriding_rule_version: 1,
    created_by: 'usr_1',
    created_at: '2026-07-22T00:00:00.000Z',
  });
  listOverridesMock.mockResolvedValue([]);
});

describe('POST /api/rules/overrides', () => {
  it('401 when unauthenticated', async () => {
    authenticate.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 401 }));

    const res = await POST(makePostReq(validBody));

    expect(res.status).toBe(401);
    expect(createOverrideMock).not.toHaveBeenCalled();
  });

  it('403 when caller lacks tech_lead/admin role', async () => {
    requireRole.mockRejectedValueOnce(Object.assign(new Error('Required role: tech_lead or admin'), { statusCode: 403 }));

    const res = await POST(makePostReq(validBody));

    expect(res.status).toBe(403);
    expect(createOverrideMock).not.toHaveBeenCalled();
  });

  it('403 when caller lacks project access (project-scoped override)', async () => {
    requireProjectAccess.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const res = await POST(makePostReq(validBody));

    // requireProjectAccess returns a ready-made NextResponse (404 by
    // convention, mirroring requireCaseAccess) which the route forwards as-is.
    expect(res.status).toBe(404);
    expect(requireRole).not.toHaveBeenCalled();
    expect(createOverrideMock).not.toHaveBeenCalled();
  });

  it('requires admin (not just tech_lead) for a global-scope override', async () => {
    requireRole.mockRejectedValueOnce(Object.assign(new Error('Required role: admin'), { statusCode: 403 }));

    const res = await POST(makePostReq({ ...validBody, scope: { layer: 'global', ref: 'global' } }));

    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith('usr_1', ['admin']);
    // A global-scope override must never consult project access.
    expect(requireProjectAccess).not.toHaveBeenCalled();
    expect(createOverrideMock).not.toHaveBeenCalled();
  });

  it('400 when the body fails schema validation (missing rationale)', async () => {
    const { rationale: _omit, ...invalidBody } = validBody;

    const res = await POST(makePostReq(invalidBody));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const issuePaths = body.error.details.issues.map((issue: { path: unknown[] }) => issue.path.join('.'));
    expect(issuePaths).toContain('rationale');
    expect(createOverrideMock).not.toHaveBeenCalled();
  });

  it('400 when rule_id and overriding_rule_id are identical', async () => {
    const res = await POST(makePostReq({ ...validBody, overriding_rule_id: validBody.rule_id }));

    expect(res.status).toBe(400);
    expect(createOverrideMock).not.toHaveBeenCalled();
  });

  it('200 happy path: creates the override for a tech_lead on their project', async () => {
    const res = await POST(makePostReq(validBody));

    expect(res.status).toBe(201);
    expect(requireProjectAccess).toHaveBeenCalledWith('proj_1', 'usr_1');
    expect(requireRole).toHaveBeenCalledWith('usr_1', ['tech_lead', 'admin']);
    expect(createOverrideMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rule_id: validBody.rule_id,
        overriding_rule_id: validBody.overriding_rule_id,
        rationale: validBody.rationale,
      }),
      'usr_1',
    );
    const body = await res.json();
    expect(body.override_id).toBe('ro_1');
  });
});

describe('GET /api/rules/overrides', () => {
  it('lists overrides, filtering project-scoped rows to accessible projects for non-admins', async () => {
    getAccessibleProjectIds.mockResolvedValueOnce(['proj_1']);
    listOverridesMock.mockResolvedValueOnce([
      { override_id: 'ro_visible', scope: { layer: 'project', ref: 'proj_1' } },
      { override_id: 'ro_hidden', scope: { layer: 'project', ref: 'proj_2' } },
      { override_id: 'ro_global', scope: { layer: 'global', ref: 'global' } },
    ]);

    const res = await GET(makeGetReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.overrides.map((o: { override_id: string }) => o.override_id);
    expect(ids).toEqual(['ro_visible', 'ro_global']);
  });

  it('passes rule_id/overriding_rule_id query params through to the service', async () => {
    await GET(makeGetReq('?rule_id=rule_global_1&overriding_rule_id=rule_project_1'));

    expect(listOverridesMock).toHaveBeenCalledWith({
      rule_id: 'rule_global_1',
      overriding_rule_id: 'rule_project_1',
    });
  });
});
