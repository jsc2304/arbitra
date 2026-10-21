import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  setPolicy,
  getPolicy,
  queryByProject,
  checkIsAdmin,
  getAccessibleProjectIds,
  generateId,
} = vi.hoisted(() => ({
  setPolicy: vi.fn(),
  getPolicy: vi.fn(),
  // Terminal of the POST uniqueness guard: where('project_id','==',...).limit(1).get()
  queryByProject: vi.fn(),
  checkIsAdmin: vi.fn(),
  getAccessibleProjectIds: vi.fn(),
  generateId: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  collections: {
    evidencePolicies: () => ({
      get: getPolicy,
      where: () => ({ limit: () => ({ get: queryByProject }) }),
      doc: () => ({
        set: setPolicy,
      }),
    }),
  },
  checkIsAdmin,
  getAccessibleProjectIds,
  generateId,
}));

const { authenticate, requireProjectScopedRole } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireProjectScopedRole: vi.fn(),
}));

// `requireProjectScopedRole` itself is unit-tested against its real
// dependencies in `lib/__tests__/api-helpers.test.ts` — here we mock it
// directly (mirrors `decisions/route.test.ts`'s style of mocking
// `@/lib/api-helpers` wholesale) so these tests assert what the ROUTE does
// with the gate's result, not the gate's own internals.
vi.mock('@/lib/api-helpers', async () => ({
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
}));

import { GET, POST } from './route';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/evidence-policies', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function makeGetRequest(): NextRequest {
  return new NextRequest('http://localhost/api/evidence-policies', { method: 'GET' });
}

describe('POST /api/evidence-policies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.mockResolvedValue({ userId: 'user_1' });
    requireProjectScopedRole.mockResolvedValue(null);
    getPolicy.mockResolvedValue({ docs: [] });
    // Default: no existing policy for the project → POST is allowed to create.
    queryByProject.mockResolvedValue({ empty: true, docs: [] });
    setPolicy.mockResolvedValue(undefined);
    generateId.mockReturnValue('ep_generated_1');
  });

  const validBody = {
    project_id: 'proj_1',
    rules: {
      high: {
        manual: {
          required_evidence_types: ['manual_confirmation'],
          optional_evidence_types: [],
          four_eyes_required: true,
          allow_self_approval: false,
        },
      },
    },
  };

  it('rejects (404) when caller is not a member of the target project', async () => {
    requireProjectScopedRole.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(404);
    expect(requireProjectScopedRole).toHaveBeenCalledWith('user_1', 'proj_1', ['tech_lead', 'admin']);
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('rejects (403) when caller is a project member but lacks tech_lead/admin role', async () => {
    requireProjectScopedRole.mockRejectedValueOnce(
      Object.assign(new Error('Required role: tech_lead or admin'), { statusCode: 403 }),
    );

    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(403);
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('rejects rules missing required evidence-policy booleans', async () => {
    const response = await POST(makeRequest({
      project_id: 'proj_1',
      rules: {
        high: {
          manual: {
            required_evidence_types: ['manual_confirmation'],
            optional_evidence_types: [],
            allow_self_approval: false,
          },
        },
      },
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const issuePaths = body.error.details.issues.map((issue: { path: unknown[] }) => issue.path.join('.'));
    expect(issuePaths).toContain('rules.high.manual.four_eyes_required');
    expect(setPolicy).not.toHaveBeenCalled();
  });

  // ── #851: reject track-first rules maps instead of silently emptying them ──

  it('rejects a track-first rules map (rules.direct.low instead of rules.low.direct)', async () => {
    const response = await POST(makeRequest({
      project_id: 'proj_1',
      rules: {
        direct: {
          low: {
            required_evidence_types: ['ci_result'],
            optional_evidence_types: [],
            four_eyes_required: false,
            allow_self_approval: false,
          },
        },
      },
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('expands a no_ci_no_unit preset into a full rules map (no ci_result/unit_test_result required)', async () => {
    const response = await POST(makeRequest({
      project_id: 'proj_1',
      preset: 'no_ci_no_unit',
    }));

    expect(response.status).toBe(201);
    expect(setPolicy).toHaveBeenCalledOnce();
    const persisted = setPolicy.mock.calls[0]![0] as {
      rules: Record<string, Record<string, { required_evidence_types: string[] }>>;
      preset?: unknown;
    };
    // The transient `preset` key must not be persisted onto the doc.
    expect(persisted.preset).toBeUndefined();
    // Every cell drops ci_result/unit_test_result and requires manual_confirmation.
    const directMedium = persisted.rules.medium!.direct!;
    expect(directMedium.required_evidence_types).not.toContain('ci_result');
    expect(directMedium.required_evidence_types).not.toContain('unit_test_result');
    expect(directMedium.required_evidence_types).toContain('manual_confirmation');
  });

  it('rejects when both rules and preset are supplied', async () => {
    const response = await POST(makeRequest({
      project_id: 'proj_1',
      preset: 'no_ci_no_unit',
      rules: validBody.rules,
    }));

    expect(response.status).toBe(400);
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('rejects when neither rules nor preset nor capabilities are supplied', async () => {
    const response = await POST(makeRequest({ project_id: 'proj_1' }));
    expect(response.status).toBe(400);
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('persists a valid rules payload', async () => {
    const response = await POST(makeRequest({
      project_id: 'proj_1',
      repository_id: 'repo_1',
      rules: validBody.rules,
    }));

    expect(response.status).toBe(201);
    expect(requireProjectScopedRole).toHaveBeenCalledWith('user_1', 'proj_1', ['tech_lead', 'admin']);
    expect(setPolicy).toHaveBeenCalledOnce();
    expect(setPolicy).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'proj_1',
      repository_id: 'repo_1',
      rules: validBody.rules,
    }));
  });

  // ── Collidable `ep_${Date.now()}` id replaced with generateId ──

  it("uses generateId('evidencePolicy') for the new policy id, never Date.now()", async () => {
    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(201);
    expect(generateId).toHaveBeenCalledWith('evidencePolicy');
    const persisted = setPolicy.mock.calls[0]![0] as { policy_id: string };
    // Format assertion — no `ep_<digits-only>` (Date.now()) pattern remains.
    expect(persisted.policy_id).toBe('ep_generated_1');
    expect(persisted.policy_id).not.toMatch(/^ep_\d+$/);
  });

  // ── #626: one evidence policy per project ──────────────────────────────

  it('creates the policy (201) when none exists for the project', async () => {
    queryByProject.mockResolvedValue({ empty: true, docs: [] });

    const response = await POST(makeRequest({
      project_id: 'proj_new',
      preset: 'no_ci_no_unit',
    }));

    expect(response.status).toBe(201);
    expect(setPolicy).toHaveBeenCalledOnce();
    const persisted = setPolicy.mock.calls[0]![0] as { project_id: string };
    expect(persisted.project_id).toBe('proj_new');
  });

  it('returns 409 with the existing policy id when a policy already exists for the project', async () => {
    const existing = {
      policy_id: 'ep_existing',
      project_id: 'proj_1',
      rules: validBody.rules,
      version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    queryByProject.mockResolvedValue({ empty: false, docs: [{ data: () => existing }] });

    const response = await POST(makeRequest({
      project_id: 'proj_1',
      preset: 'no_ci_no_unit',
    }));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe('POLICY_ALREADY_EXISTS');
    expect(body.error.details.existing_policy_id).toBe('ep_existing');
    // The existing policy must be left untouched — no write of any kind.
    expect(setPolicy).not.toHaveBeenCalled();
  });
});

describe('GET /api/evidence-policies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.mockResolvedValue({ userId: 'user_1' });
    checkIsAdmin.mockResolvedValue(false);
    getAccessibleProjectIds.mockResolvedValue('all');
  });

  it('filters out policies belonging to projects the caller cannot access', async () => {
    checkIsAdmin.mockResolvedValueOnce(false);
    getAccessibleProjectIds.mockResolvedValueOnce(['proj_1']);
    getPolicy.mockResolvedValueOnce({
      docs: [
        { data: () => ({ policy_id: 'ep_visible', project_id: 'proj_1' }) },
        { data: () => ({ policy_id: 'ep_hidden', project_id: 'proj_2' }) },
      ],
    });

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    const ids = body.policies.map((p: { policy_id: string }) => p.policy_id);
    expect(ids).toEqual(['ep_visible']);
  });

  it("admin sees every project's policies unfiltered", async () => {
    checkIsAdmin.mockResolvedValueOnce(true);
    getPolicy.mockResolvedValueOnce({
      docs: [
        { data: () => ({ policy_id: 'ep_a', project_id: 'proj_1' }) },
        { data: () => ({ policy_id: 'ep_b', project_id: 'proj_2' }) },
      ],
    });

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.policies).toHaveLength(2);
    expect(getAccessibleProjectIds).not.toHaveBeenCalled();
  });
});
