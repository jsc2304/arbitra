import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { requireRole, docGet, docUpdate } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  docGet: vi.fn(),
  docUpdate: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  requireRole,
  collections: {
    rules: () => ({
      doc: () => ({ get: docGet, update: docUpdate }),
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

import { PATCH } from './route';

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/rules/rule_1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const params = { params: Promise.resolve({ ruleId: 'rule_1' }) };

/** Stored rule fixture, mutated in place by `docUpdate` so the follow-up `docGet` reflects the patch. */
function existingRule(overrides: Record<string, unknown> = {}) {
  return {
    rule_id: 'rule_1',
    name: 'Existing rule',
    category: 'code_quality_rule',
    scope: { layer: 'global', ref: 'global' },
    evaluation_mode: 'diff_pattern',
    severity_if_failed: 'medium',
    description: 'desc',
    rationale: 'rationale',
    config: {},
    status: 'draft',
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_1' });
  requireProjectScopedRole.mockResolvedValue(null);
  requireRole.mockResolvedValue(['admin']);
});

describe('PATCH /api/rules/[ruleId]', () => {
  it('401 when unauthenticated', async () => {
    authenticate.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 401 }));

    const res = await PATCH(makeReq({ status: 'active' }), params);

    expect(res.status).toBe(401);
    expect(docGet).not.toHaveBeenCalled();
  });

  it('404 when the rule does not exist', async () => {
    docGet.mockResolvedValueOnce({ exists: false });

    const res = await PATCH(makeReq({ status: 'active' }), params);

    expect(res.status).toBe(404);
    expect(requireRole).not.toHaveBeenCalled();
    expect(requireProjectScopedRole).not.toHaveBeenCalled();
  });

  it('403 developer role patching a global-scope rule (admin required)', async () => {
    docGet.mockResolvedValueOnce({ exists: true, data: () => existingRule() });
    requireRole.mockRejectedValueOnce(Object.assign(new Error('Required role: admin'), { statusCode: 403 }));

    const res = await PATCH(makeReq({ status: 'active' }), params);

    expect(res.status).toBe(403);
    expect(docUpdate).not.toHaveBeenCalled();
  });

  it('403/404 when a tech_lead of project X patches a project-Y-scoped rule (load-resource-first proof)', async () => {
    docGet.mockResolvedValueOnce({
      exists: true,
      data: () => existingRule({ scope: { layer: 'project', ref: 'proj_Y' } }),
    });
    requireProjectScopedRole.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    // Body carries no scope (not patchable) — the gate must come from the
    // loaded doc's own scope, not anything client-supplied.
    const res = await PATCH(makeReq({ status: 'active' }), params);

    expect(res.status).toBe(404);
    expect(requireProjectScopedRole).toHaveBeenCalledWith('usr_1', 'proj_Y', ['tech_lead', 'admin']);
    expect(docUpdate).not.toHaveBeenCalled();
  });

  it('400 when the body fails schema validation (bad status enum value)', async () => {
    docGet.mockResolvedValueOnce({ exists: true, data: () => existingRule() });

    const res = await PATCH(makeReq({ status: 'bogus' }), params);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(docUpdate).not.toHaveBeenCalled();
  });

  it('400 when no valid fields are supplied', async () => {
    docGet.mockResolvedValueOnce({ exists: true, data: () => existingRule() });

    const res = await PATCH(makeReq({}), params);

    expect(res.status).toBe(400);
    expect(docUpdate).not.toHaveBeenCalled();
  });

  it('200 happy path: admin patches a global-scope rule and stamps updated_by', async () => {
    const stored = existingRule();
    docGet.mockImplementation(() => Promise.resolve({ exists: true, data: () => stored }));
    docUpdate.mockImplementation((patch: Record<string, unknown>) => {
      Object.assign(stored, patch);
      return Promise.resolve();
    });

    const res = await PATCH(makeReq({ status: 'active' }), params);

    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith('usr_1', ['admin']);
    expect(docUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', updated_by: 'usr_1' }),
    );
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(body.updated_by).toBe('usr_1');
  });

  it('200 happy path: tech_lead of the owning project patches a project-scoped rule', async () => {
    const stored = existingRule({ scope: { layer: 'project', ref: 'proj_X' } });
    docGet.mockImplementation(() => Promise.resolve({ exists: true, data: () => stored }));
    docUpdate.mockImplementation((patch: Record<string, unknown>) => {
      Object.assign(stored, patch);
      return Promise.resolve();
    });

    const res = await PATCH(makeReq({ name: 'Renamed' }), params);

    expect(res.status).toBe(200);
    expect(requireProjectScopedRole).toHaveBeenCalledWith('usr_1', 'proj_X', ['tech_lead', 'admin']);
    const body = await res.json();
    expect(body.name).toBe('Renamed');
  });
});
