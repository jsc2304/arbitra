import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { requireRole, generateId, ruleSetsSet } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  generateId: vi.fn(() => 'rs_new'),
  ruleSetsSet: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  requireRole,
  generateId,
  // Real passthrough — createRuleSetSchema (imported for real from
  // @arbitra/shared by route.ts) does the actual validating/defaulting.
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T => schema.parse(body),
  collections: {
    ruleSets: () => ({ doc: () => ({ set: ruleSetsSet }) }),
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

import { POST } from './route';

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/rule-sets', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_1' });
  requireProjectScopedRole.mockResolvedValue(null);
  requireRole.mockResolvedValue(['admin']);
  ruleSetsSet.mockResolvedValue(undefined);
});

describe('POST /api/rule-sets', () => {
  it('401 when unauthenticated', async () => {
    authenticate.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 401 }));

    const res = await POST(makeReq({ name: 'Release gates' }));

    expect(res.status).toBe(401);
    expect(ruleSetsSet).not.toHaveBeenCalled();
  });

  it('403 developer role on global (unscoped) create — admin required', async () => {
    requireRole.mockRejectedValueOnce(Object.assign(new Error('Required role: admin'), { statusCode: 403 }));

    const res = await POST(makeReq({ name: 'Release gates' }));

    expect(res.status).toBe(403);
    expect(requireProjectScopedRole).not.toHaveBeenCalled();
    expect(ruleSetsSet).not.toHaveBeenCalled();
  });

  it('403/404 when caller lacks project access (project-scoped create)', async () => {
    requireProjectScopedRole.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const res = await POST(makeReq({ name: 'Project rules', project_id: 'proj_1' }));

    expect(res.status).toBe(404);
    expect(ruleSetsSet).not.toHaveBeenCalled();
  });

  it('400 when the body fails schema validation (blank name)', async () => {
    const res = await POST(makeReq({ name: '   ' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(ruleSetsSet).not.toHaveBeenCalled();
  });

  it('201 happy path: admin creates a global rule set, defaults applied', async () => {
    const res = await POST(makeReq({ name: 'Release gates' }));

    expect(res.status).toBe(201);
    expect(requireRole).toHaveBeenCalledWith('usr_1', ['admin']);
    expect(ruleSetsSet).toHaveBeenCalled();
    const body = await res.json();
    expect(body.rule_set_id).toBe('rs_new');
    expect(body.status).toBe('draft');
    expect(body.description).toBe('');
    expect(body.rule_refs).toEqual([]);
    expect(body.updated_by).toBe('usr_1');
  });

  it('201 happy path: tech_lead creates a project-scoped rule set', async () => {
    const res = await POST(makeReq({ name: 'Project rules', project_id: 'proj_1' }));

    expect(res.status).toBe(201);
    expect(requireProjectScopedRole).toHaveBeenCalledWith('usr_1', 'proj_1', ['tech_lead', 'admin']);
    expect(requireRole).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.project_id).toBe('proj_1');
  });
});
