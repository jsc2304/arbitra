import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  getDoc,
  updateDoc,
  deleteDoc,
} = vi.hoisted(() => ({
  getDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  collections: {
    evidencePolicies: () => ({
      doc: () => ({
        get: getDoc,
        update: updateDoc,
        delete: deleteDoc,
      }),
    }),
  },
}));

const { authenticate, requireProjectScopedRole } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireProjectScopedRole: vi.fn(),
}));

// `requireProjectScopedRole`'s own admin-bypass / project-access / role-gate
// logic is unit-tested against its real dependencies in
// `lib/__tests__/api-helpers.test.ts`. Mocking it directly here (mirrors
// `decisions/route.test.ts`'s style of mocking `@/lib/api-helpers`
// wholesale) lets these tests focus on what the ROUTE does with the gate's
// result — in particular, that PATCH/DELETE load the policy doc BEFORE
// gating so the check runs against the policy's *stored* project_id.
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

import { DELETE, PATCH } from './route';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/evidence-policies/policy_1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function makeDeleteRequest(): NextRequest {
  return new NextRequest('http://localhost/api/evidence-policies/policy_1', {
    method: 'DELETE',
  });
}

describe('PATCH /api/evidence-policies/[policyId]', () => {
  beforeEach(() => {
    // `resetAllMocks` (not `clearAllMocks`) so a test that doesn't drain
    // both queued `getDoc` responses (e.g. an early validation/gate return
    // before the post-update refetch) can never leak a stale queued value
    // into the next test — PATCH now calls `docRef.get()` at the very start
    // of every request (to gate on the stored project_id), so nearly every
    // test path touches this queue.
    vi.resetAllMocks();
    authenticate.mockResolvedValue({ userId: 'user_1' });
    requireProjectScopedRole.mockResolvedValue(null);
    getDoc
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({ policy_id: 'policy_1', project_id: 'proj_1', version: 3 }),
      })
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({ policy_id: 'policy_1', project_id: 'proj_1', version: 4 }),
      });
    updateDoc.mockResolvedValue(undefined);
  });

  it('rejects invalid nested rule payloads before update', async () => {
    const response = await PATCH(
      makeRequest({
        rules: {
          critical: {
            direct: {
              required_evidence_types: [],
              optional_evidence_types: [],
              four_eyes_required: true,
            },
          },
        },
      }),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const issuePaths = body.error.details.issues.map((issue: { path: unknown[] }) => issue.path.join('.'));
    expect(issuePaths).toContain('rules.critical.direct.allow_self_approval');
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("404s when the policy doesn't exist, without ever consulting the role gate", async () => {
    getDoc.mockReset();
    getDoc.mockResolvedValue({ exists: false, data: () => undefined });

    const response = await PATCH(
      makeRequest({ preset: 'no_ci_no_unit' }),
      { params: Promise.resolve({ policyId: 'missing_policy' }) },
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.message).toBe('Policy not found');
    expect(requireProjectScopedRole).not.toHaveBeenCalled();
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("rejects (404) a tech_lead of project X mutating project Y's policy (gated on the policy's STORED project_id)", async () => {
    getDoc.mockReset();
    getDoc.mockResolvedValueOnce({
      exists: true,
      data: () => ({ policy_id: 'policy_1', project_id: 'proj_y', version: 3 }),
    });
    requireProjectScopedRole.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const response = await PATCH(
      makeRequest({ preset: 'no_ci_no_unit' }),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(404);
    expect(requireProjectScopedRole).toHaveBeenCalledWith('user_1', 'proj_y', ['tech_lead', 'admin']);
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('rejects (403) when caller is a member of the policy project but lacks tech_lead/admin role', async () => {
    requireProjectScopedRole.mockRejectedValueOnce(
      Object.assign(new Error('Required role: tech_lead or admin'), { statusCode: 403 }),
    );

    const response = await PATCH(
      makeRequest({
        rules: {
          critical: {
            direct: {
              required_evidence_types: ['ci_result'],
              optional_evidence_types: [],
              four_eyes_required: true,
              allow_self_approval: false,
            },
          },
        },
      }),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(403);
    expect(requireProjectScopedRole).toHaveBeenCalledWith('user_1', 'proj_1', ['tech_lead', 'admin']);
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('updates valid policy fields and bumps version (admin/tech_lead-of-project allowed)', async () => {
    const response = await PATCH(
      makeRequest({
        rules: {
          critical: {
            direct: {
              required_evidence_types: ['ci_result'],
              optional_evidence_types: [],
              four_eyes_required: true,
              allow_self_approval: false,
            },
          },
        },
      }),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(200);
    expect(requireProjectScopedRole).toHaveBeenCalledWith('user_1', 'proj_1', ['tech_lead', 'admin']);
    expect(updateDoc).toHaveBeenCalledOnce();
    expect(updateDoc).toHaveBeenCalledWith(expect.objectContaining({
      rules: {
        critical: {
          direct: {
            required_evidence_types: ['ci_result'],
            optional_evidence_types: [],
            four_eyes_required: true,
            allow_self_approval: false,
          },
        },
      },
      version: 4,
      updated_at: expect.any(String),
    }));
  });

  it("drops a client-supplied project_id from the persisted update (can't re-home the policy past the gate)", async () => {
    const response = await PATCH(
      makeRequest({
        project_id: 'proj_evil',
        rules: {
          critical: {
            direct: {
              required_evidence_types: ['ci_result'],
              optional_evidence_types: [],
              four_eyes_required: true,
              allow_self_approval: false,
            },
          },
        },
      }),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(200);
    expect(updateDoc).toHaveBeenCalledOnce();
    const persisted = updateDoc.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('project_id');
  });

  // Issue #749 item 5: the re-homing regression test above only covered the
  // direct `rules` branch. `preset`/`capabilities` take a different code path
  // (the expanded-rules branch in `PATCH`) that also spreads `rest` — these
  // pin that a spoofed `project_id` is dropped there too, not just when the
  // caller supplies `rules` directly.
  it("drops a client-supplied project_id from the persisted update via a preset expansion (can't re-home the policy past the gate)", async () => {
    const response = await PATCH(
      makeRequest({ project_id: 'proj_evil', preset: 'no_ci_no_unit' }),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(200);
    expect(updateDoc).toHaveBeenCalledOnce();
    const persisted = updateDoc.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('project_id');
  });

  it("drops a client-supplied project_id from the persisted update via a capabilities expansion (can't re-home the policy past the gate)", async () => {
    const response = await PATCH(
      makeRequest({ project_id: 'proj_evil', capabilities: { ci_available: false } }),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(200);
    expect(updateDoc).toHaveBeenCalledOnce();
    const persisted = updateDoc.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('project_id');
  });

  it('expands a preset into a full rules map and persists only rules (no preset key)', async () => {
    const response = await PATCH(
      makeRequest({ preset: 'no_ci_no_unit' }),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(200);
    expect(updateDoc).toHaveBeenCalledOnce();
    const persisted = updateDoc.mock.calls[0]![0] as {
      rules: Record<string, Record<string, { required_evidence_types: string[] }>>;
      preset?: unknown;
      capabilities?: unknown;
      version: number;
    };
    // Transient preset/capabilities keys must never be persisted onto the doc.
    expect(persisted.preset).toBeUndefined();
    expect(persisted.capabilities).toBeUndefined();
    expect(persisted.version).toBe(4);
    // Every cell drops ci_result/unit_test_result and gains manual_confirmation.
    const directMedium = persisted.rules.medium!.direct!;
    expect(directMedium.required_evidence_types).not.toContain('ci_result');
    expect(directMedium.required_evidence_types).not.toContain('unit_test_result');
    expect(directMedium.required_evidence_types).toContain('manual_confirmation');
  });

  it('expands a capabilities declaration (ci_available: false) into a full rules map', async () => {
    const response = await PATCH(
      makeRequest({ capabilities: { ci_available: false } }),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(200);
    expect(updateDoc).toHaveBeenCalledOnce();
    const persisted = updateDoc.mock.calls[0]![0] as {
      rules: Record<string, Record<string, { required_evidence_types: string[] }>>;
      capabilities?: unknown;
    };
    expect(persisted.capabilities).toBeUndefined();
    const directMedium = persisted.rules.medium!.direct!;
    // ci dropped; unit tests still available so unit_test_result stays required.
    expect(directMedium.required_evidence_types).not.toContain('ci_result');
    expect(directMedium.required_evidence_types).toContain('unit_test_result');
    expect(directMedium.required_evidence_types).toContain('manual_confirmation');
  });

  it('treats an empty capabilities object as a no-op (does NOT overwrite existing custom cells)', async () => {
    const response = await PATCH(
      makeRequest({ capabilities: {} }),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(200);
    expect(updateDoc).toHaveBeenCalledOnce();
    const persisted = updateDoc.mock.calls[0]![0] as Record<string, unknown>;
    // The destructive trap: an empty `capabilities` must NOT trigger a full-map
    // rebuild. With no `rules` key in the update, Firestore preserves the
    // policy's existing custom cells.
    expect(persisted).not.toHaveProperty('rules');
    expect(persisted).not.toHaveProperty('capabilities');
    expect(persisted.version).toBe(4);
  });

  it('merges a partial rules body into the stored map instead of deleting the other risk keys (defect 4)', async () => {
    // Reproduces the whole-field-replacement footgun: the stored policy has
    // `low` and `medium` populated; the caller only sends `high`. Without
    // the server-side merge, `docRef.update({ rules: { high: {...} } })`
    // would wipe `low`/`medium` because Firestore treats `rules` as an
    // atomic top-level field.
    getDoc.mockReset();
    getDoc
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({
          policy_id: 'policy_1',
          project_id: 'proj_1',
          version: 3,
          rules: {
            low: {
              direct: {
                required_evidence_types: ['ci_result'],
                optional_evidence_types: [],
                four_eyes_required: false,
                allow_self_approval: false,
              },
            },
            medium: {
              direct: {
                required_evidence_types: ['ci_result', 'unit_test_result'],
                optional_evidence_types: [],
                four_eyes_required: false,
                allow_self_approval: false,
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({ policy_id: 'policy_1', project_id: 'proj_1', version: 4 }),
      });

    const response = await PATCH(
      makeRequest({
        rules: {
          high: {
            direct: {
              required_evidence_types: ['ci_result', 'unit_test_result', 'runtime_log'],
              optional_evidence_types: [],
              four_eyes_required: true,
              allow_self_approval: false,
            },
          },
        },
      }),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(200);
    expect(updateDoc).toHaveBeenCalledOnce();
    const persisted = updateDoc.mock.calls[0]![0] as {
      rules: Record<string, Record<string, unknown> | undefined>;
    };
    expect(persisted.rules.low).toEqual({
      direct: {
        required_evidence_types: ['ci_result'],
        optional_evidence_types: [],
        four_eyes_required: false,
        allow_self_approval: false,
      },
    });
    expect(persisted.rules.medium).toEqual({
      direct: {
        required_evidence_types: ['ci_result', 'unit_test_result'],
        optional_evidence_types: [],
        four_eyes_required: false,
        allow_self_approval: false,
      },
    });
    expect(persisted.rules.high).toEqual({
      direct: {
        required_evidence_types: ['ci_result', 'unit_test_result', 'runtime_log'],
        optional_evidence_types: [],
        four_eyes_required: true,
        allow_self_approval: false,
      },
    });
  });

  it('rejects an ambiguous payload carrying both preset and rules with 400', async () => {
    const response = await PATCH(
      makeRequest({
        preset: 'no_ci_no_unit',
        rules: {
          critical: {
            direct: {
              required_evidence_types: ['ci_result'],
              optional_evidence_types: [],
              four_eyes_required: true,
              allow_self_approval: false,
            },
          },
        },
      }),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(updateDoc).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/evidence-policies/[policyId]', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authenticate.mockResolvedValue({ userId: 'user_1' });
    requireProjectScopedRole.mockResolvedValue(null);
    deleteDoc.mockResolvedValue(undefined);
  });

  it('rejects when caller is unauthenticated', async () => {
    authenticate.mockReset();
    authenticate.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));

    const response = await DELETE(
      makeDeleteRequest(),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(401);
    expect(requireProjectScopedRole).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it('returns 404 when the policy doc does not exist, without consulting the role gate', async () => {
    getDoc.mockResolvedValue({ exists: false, data: () => undefined });

    const response = await DELETE(
      makeDeleteRequest(),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.message).toBe('Policy not found');
    expect(requireProjectScopedRole).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it("rejects (404) a tech_lead of project X deleting project Y's policy (gated on the policy's STORED project_id)", async () => {
    getDoc.mockResolvedValue({
      exists: true,
      data: () => ({ policy_id: 'policy_1', project_id: 'proj_y', version: 3 }),
    });
    requireProjectScopedRole.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const response = await DELETE(
      makeDeleteRequest(),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(404);
    expect(requireProjectScopedRole).toHaveBeenCalledWith('user_1', 'proj_y', ['tech_lead', 'admin']);
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it('rejects (403) when caller is a project member but lacks tech_lead/admin role', async () => {
    getDoc.mockResolvedValue({
      exists: true,
      data: () => ({ policy_id: 'policy_1', project_id: 'proj_1', version: 3 }),
    });
    requireProjectScopedRole.mockRejectedValueOnce(
      Object.assign(new Error('Required role: tech_lead or admin'), { statusCode: 403 }),
    );

    const response = await DELETE(
      makeDeleteRequest(),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(403);
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it('deletes the policy doc and returns 204 on success (admin, or tech_lead of the policy project)', async () => {
    getDoc.mockResolvedValue({
      exists: true,
      data: () => ({ policy_id: 'policy_1', project_id: 'proj_1', version: 3 }),
    });

    const response = await DELETE(
      makeDeleteRequest(),
      { params: Promise.resolve({ policyId: 'policy_1' }) },
    );

    expect(response.status).toBe(204);
    expect(requireProjectScopedRole).toHaveBeenCalledWith('user_1', 'proj_1', ['tech_lead', 'admin']);
    expect(deleteDoc).toHaveBeenCalledOnce();
  });
});
