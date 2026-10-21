import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  updateAssetMock,
  deleteAssetMock,
  getAssetMock,
  KnowledgeServiceMock,
  requireRole,
  repoProjectMap,
  existingProjectIds,
} = vi.hoisted(() => {
  const updateAssetMock = vi.fn();
  const deleteAssetMock = vi.fn();
  const getAssetMock = vi.fn();
  class KnowledgeServiceMock {
    updateAsset = updateAssetMock;
    getAsset = getAssetMock;
    deleteAsset = deleteAssetMock;
  }
  // repo_id -> project_id (absent => repo doesn't exist)
  const repoProjectMap = new Map<string, string>();
  const existingProjectIds = new Set<string>();
  return {
    updateAssetMock,
    deleteAssetMock,
    getAssetMock,
    KnowledgeServiceMock,
    requireRole: vi.fn(),
    repoProjectMap,
    existingProjectIds,
  };
});

vi.mock('@arbitra/backend', () => ({
  KnowledgeService: KnowledgeServiceMock,
  requireRole,
  collections: {
    projects: () => ({
      doc: (projectId: string) => ({
        get: async () => ({ exists: existingProjectIds.has(projectId) }),
      }),
    }),
    repositories: () => ({
      doc: (repoId: string) => ({
        get: async () => {
          const projectId = repoProjectMap.get(repoId);
          return projectId === undefined
            ? { exists: false }
            : { exists: true, data: () => ({ project_id: projectId }) };
        },
      }),
    }),
  },
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T =>
    schema.parse(body),
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
    handleError: (err: unknown) => {
      // Zod validation errors carry an `issues` array, not `statusCode` —
      // mirrors the real `formatError`'s ZodError duck-typing.
      const isValidation = err instanceof Error && 'issues' in err;
      const status = isValidation ? 400 : ((err as { statusCode?: number })?.statusCode ?? 500);
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status });
    },
  };
});

import { GET, PATCH, DELETE } from './route';

function makeRequest(method: string, body?: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/knowledge/kn_1', {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  });
}

const params = Promise.resolve({ knowledgeId: 'kn_1' });

function globalAsset(overrides: Record<string, unknown> = {}) {
  return { knowledge_id: 'kn_1', scope_type: 'global', scope_ref: 'global', version: 1, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireRole.mockResolvedValue(['tech_lead']);
  requireProjectAccess.mockResolvedValue(null);
  getAssetMock.mockResolvedValue(globalAsset());
  updateAssetMock.mockResolvedValue({ knowledge_id: 'kn_1' });
  deleteAssetMock.mockResolvedValue(undefined);
  repoProjectMap.clear();
  existingProjectIds.clear();
  existingProjectIds.add('proj_x');
  existingProjectIds.add('proj_y');
  existingProjectIds.add('proj_a');
  existingProjectIds.add('proj_b');
});

describe('GET /api/knowledge/[knowledgeId] project scoping', () => {
  it('404s an asset scoped to a missing project before checking membership', async () => {
    getAssetMock.mockResolvedValue(globalAsset({ scope_type: 'project', scope_ref: 'proj_missing' }));

    const res = await GET(makeRequest('GET'), { params });

    expect(res.status).toBe(404);
    expect(requireProjectAccess).not.toHaveBeenCalled();
  });

  it('404s a project-scoped asset for a caller without project access', async () => {
    getAssetMock.mockResolvedValue(globalAsset({ scope_type: 'project', scope_ref: 'proj_x' }));
    requireProjectAccess.mockResolvedValue(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const res = await GET(makeRequest('GET'), { params });
    expect(res.status).toBe(404);
    expect(requireProjectAccess).toHaveBeenCalledWith('proj_x', 'user_1');
  });

  it('allows a global-scope asset through for any authenticated caller', async () => {
    const res = await GET(makeRequest('GET'), { params });
    expect(res.status).toBe(200);
    expect(requireProjectAccess).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/knowledge/[knowledgeId] project scoping', () => {
  it('denies a PATCH on a project-scoped asset for a non-member, even with a global tech_lead role', async () => {
    getAssetMock.mockResolvedValue(globalAsset({ scope_type: 'project', scope_ref: 'proj_x' }));
    requireProjectAccess.mockResolvedValue(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const res = await PATCH(makeRequest('PATCH', { title: 'Renamed' }), { params });
    expect(res.status).toBe(404);
    expect(requireProjectAccess).toHaveBeenCalledWith('proj_x', 'user_1');
    expect(updateAssetMock).not.toHaveBeenCalled();
  });

  it('allows a PATCH on a project-scoped asset for a member+tech_lead', async () => {
    getAssetMock.mockResolvedValue(globalAsset({ scope_type: 'project', scope_ref: 'proj_x' }));

    const res = await PATCH(makeRequest('PATCH', { title: 'Renamed' }), { params });
    expect(res.status).toBe(200);
    expect(updateAssetMock).toHaveBeenCalledOnce();
  });

  it('resolves repo scope to its owning project before checking access', async () => {
    getAssetMock.mockResolvedValue(globalAsset({ scope_type: 'repo', scope_ref: 'repo_1' }));
    repoProjectMap.set('repo_1', 'proj_y');
    requireProjectAccess.mockResolvedValue(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const res = await PATCH(makeRequest('PATCH', { title: 'Renamed' }), { params });
    expect(res.status).toBe(404);
    expect(requireProjectAccess).toHaveBeenCalledWith('proj_y', 'user_1');
  });

  it('checks access to the destination project when a PATCH retargets scope_ref', async () => {
    // existing asset is in a project the caller can access...
    getAssetMock.mockResolvedValue(globalAsset({ scope_type: 'project', scope_ref: 'proj_a' }));
    requireProjectAccess.mockImplementation(async (projectId: string) =>
      projectId === 'proj_b'
        ? NextResponse.json({ error: { message: 'Not found' } }, { status: 404 })
        : null,
    );

    // ...but the PATCH tries to retarget it into a project the caller can't access
    const res = await PATCH(
      makeRequest('PATCH', { scope_type: 'project', scope_ref: 'proj_b' }),
      { params },
    );

    expect(res.status).toBe(404);
    expect(requireProjectAccess).toHaveBeenCalledWith('proj_b', 'user_1');
    expect(updateAssetMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/knowledge/[knowledgeId] project scoping', () => {
  it('denies deleting a project-scoped asset for a non-member', async () => {
    getAssetMock.mockResolvedValue(globalAsset({ scope_type: 'project', scope_ref: 'proj_x' }));
    requireProjectAccess.mockResolvedValue(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(404);
    expect(deleteAssetMock).not.toHaveBeenCalled();
  });

  it('allows deleting a project-scoped asset for a member+tech_lead', async () => {
    getAssetMock.mockResolvedValue(globalAsset({ scope_type: 'project', scope_ref: 'proj_x' }));

    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(200);
    expect(deleteAssetMock).toHaveBeenCalledOnce();
  });
});

describe('PATCH /api/knowledge/[knowledgeId] body validation (Zod)', () => {
  it('succeeds when body is omitted (partial patch)', async () => {
    const res = await PATCH(makeRequest('PATCH', { title: 'Renamed' }), { params });
    expect(res.status).toBe(200);
    expect(updateAssetMock).toHaveBeenCalledOnce();
  });

  it('rejects an empty body string field', async () => {
    const res = await PATCH(makeRequest('PATCH', { body: '' }), { params });
    expect(res.status).toBe(400);
    expect(updateAssetMock).not.toHaveBeenCalled();
  });

  it('rejects a body just under 50 chars', async () => {
    const res = await PATCH(makeRequest('PATCH', { body: 'x'.repeat(49) }), { params });
    expect(res.status).toBe(400);
  });

  it('accepts a body of exactly 50 chars', async () => {
    const res = await PATCH(makeRequest('PATCH', { body: 'x'.repeat(50) }), { params });
    expect(res.status).toBe(200);
    expect(updateAssetMock).toHaveBeenCalledOnce();
  });

  it('rejects a summary just under 10 chars', async () => {
    const res = await PATCH(makeRequest('PATCH', { summary: 'y'.repeat(9) }), { params });
    expect(res.status).toBe(400);
  });

  it('accepts a summary of exactly 10 chars', async () => {
    const res = await PATCH(makeRequest('PATCH', { summary: 'y'.repeat(10) }), { params });
    expect(res.status).toBe(200);
  });

  it('rejects an unknown field (replaces the old ALLOWED_PATCH_KEYS check)', async () => {
    const res = await PATCH(makeRequest('PATCH', { not_a_real_field: 'x' }), { params });
    expect(res.status).toBe(400);
    expect(updateAssetMock).not.toHaveBeenCalled();
  });

  it('rejects a forbidden lifecycle field (replaces the old FORBIDDEN_PATCH_KEYS check)', async () => {
    const res = await PATCH(makeRequest('PATCH', { status: 'verified' }), { params });
    expect(res.status).toBe(400);
    expect(updateAssetMock).not.toHaveBeenCalled();
  });
});
