import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  requireRole,
  checkIsAdmin,
  getAccessibleProjectIds,
  generateId,
  rulesGet,
  ruleSetsGet,
  rulesSet,
} = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkIsAdmin: vi.fn(),
  getAccessibleProjectIds: vi.fn(),
  generateId: vi.fn(() => 'rule_new'),
  rulesGet: vi.fn(),
  ruleSetsGet: vi.fn(),
  rulesSet: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  requireRole,
  checkIsAdmin,
  getAccessibleProjectIds,
  generateId,
  collections: {
    rules: () => ({
      get: rulesGet,
      doc: () => ({ set: rulesSet }),
    }),
    ruleSets: () => ({
      get: ruleSetsGet,
    }),
  },
}));

const { authenticate, requireProjectScopedRole } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireProjectScopedRole: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    requireProjectScopedRole,
    // Real passthrough — the schema itself (imported for real from
    // @arbitra/shared by route.ts) does the actual validating.
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

function makeGetReq(): NextRequest {
  return new NextRequest('http://localhost/api/rules', { method: 'GET' });
}

function makePostReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/rules', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const validGlobalBody = {
  name: 'No console.log',
  category: 'code_quality_rule',
  evaluation_mode: 'diff_pattern',
  severity_if_failed: 'medium',
  scope: { layer: 'global', ref: 'global' },
  description: 'Disallow console.log in production code.',
  rationale: 'Console statements leak into prod logs and bloat noise.',
};

const validProjectBody = {
  ...validGlobalBody,
  scope: { layer: 'project', ref: 'proj_1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_1' });
  requireProjectScopedRole.mockResolvedValue(null);
  requireRole.mockResolvedValue(['admin']);
  checkIsAdmin.mockResolvedValue(false);
  getAccessibleProjectIds.mockResolvedValue('all');
  rulesGet.mockResolvedValue({ docs: [] });
  ruleSetsGet.mockResolvedValue({ docs: [] });
  rulesSet.mockResolvedValue(undefined);
});

describe('GET /api/rules', () => {
  it('non-member sees only global rows (rules + rule sets)', async () => {
    checkIsAdmin.mockResolvedValueOnce(false);
    getAccessibleProjectIds.mockResolvedValueOnce(['proj_1']);
    rulesGet.mockResolvedValueOnce({
      docs: [
        { data: () => ({ rule_id: 'rule_global', scope: { layer: 'global', ref: 'global' } }) },
        { data: () => ({ rule_id: 'rule_visible', scope: { layer: 'project', ref: 'proj_1' } }) },
        { data: () => ({ rule_id: 'rule_hidden', scope: { layer: 'project', ref: 'proj_2' } }) },
      ],
    });
    ruleSetsGet.mockResolvedValueOnce({
      docs: [
        { data: () => ({ rule_set_id: 'rs_global' }) },
        { data: () => ({ rule_set_id: 'rs_visible', project_id: 'proj_1' }) },
        { data: () => ({ rule_set_id: 'rs_hidden', project_id: 'proj_2' }) },
      ],
    });

    const res = await GET(makeGetReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rules.map((r: { rule_id: string }) => r.rule_id)).toEqual(['rule_global', 'rule_visible']);
    expect(body.ruleSets.map((rs: { rule_set_id: string }) => rs.rule_set_id)).toEqual(['rs_global', 'rs_visible']);
  });

  it('admin sees every row unfiltered (no getAccessibleProjectIds call)', async () => {
    checkIsAdmin.mockResolvedValueOnce(true);
    rulesGet.mockResolvedValueOnce({
      docs: [{ data: () => ({ rule_id: 'rule_a', scope: { layer: 'project', ref: 'proj_2' } }) }],
    });
    ruleSetsGet.mockResolvedValueOnce({
      docs: [{ data: () => ({ rule_set_id: 'rs_a', project_id: 'proj_2' }) }],
    });

    const res = await GET(makeGetReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rules).toHaveLength(1);
    expect(body.ruleSets).toHaveLength(1);
    expect(getAccessibleProjectIds).not.toHaveBeenCalled();
  });
});

describe('POST /api/rules', () => {
  it('401 when unauthenticated', async () => {
    authenticate.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 401 }));

    const res = await POST(makePostReq(validGlobalBody));

    expect(res.status).toBe(401);
    expect(rulesSet).not.toHaveBeenCalled();
  });

  it('403 developer role on global-scope create (admin required)', async () => {
    requireRole.mockRejectedValueOnce(Object.assign(new Error('Required role: admin'), { statusCode: 403 }));

    const res = await POST(makePostReq(validGlobalBody));

    expect(res.status).toBe(403);
    expect(requireProjectScopedRole).not.toHaveBeenCalled();
    expect(rulesSet).not.toHaveBeenCalled();
  });

  it('403/404 when caller lacks project access (project-scoped create)', async () => {
    requireProjectScopedRole.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const res = await POST(makePostReq(validProjectBody));

    expect(res.status).toBe(404);
    expect(rulesSet).not.toHaveBeenCalled();
  });

  it('400 on malformed body (missing rationale)', async () => {
    const { rationale: _omit, ...invalidBody } = validGlobalBody;

    const res = await POST(makePostReq(invalidBody));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(rulesSet).not.toHaveBeenCalled();
  });

  it('201 happy path: admin creates a global-scope rule', async () => {
    const res = await POST(makePostReq(validGlobalBody));

    expect(res.status).toBe(201);
    expect(requireRole).toHaveBeenCalledWith('usr_1', ['admin']);
    expect(requireProjectScopedRole).not.toHaveBeenCalled();
    expect(rulesSet).toHaveBeenCalled();
    const body = await res.json();
    expect(body.rule_id).toBe('rule_new');
    expect(body.updated_by).toBe('usr_1');
  });

  it('201 happy path: tech_lead of the project creates a project-scoped rule', async () => {
    const res = await POST(makePostReq(validProjectBody));

    expect(res.status).toBe(201);
    expect(requireProjectScopedRole).toHaveBeenCalledWith('usr_1', 'proj_1', ['tech_lead', 'admin']);
    expect(requireRole).not.toHaveBeenCalled();
    expect(rulesSet).toHaveBeenCalled();
  });
});
