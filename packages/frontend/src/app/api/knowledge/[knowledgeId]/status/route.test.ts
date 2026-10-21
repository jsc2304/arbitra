import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  updateStatusMock,
  getAssetMock,
  KnowledgeServiceMock,
  getUserMock,
  docMock,
  getRepoMock,
  existingProjectIds,
  collectionsMock,
} = vi.hoisted(() => {
  const updateStatusMock = vi.fn(
    async (
      _knowledgeId: string,
      status: string,
      _actorId: string,
      actorRoles: string[],
    ) => {
      if (
        (status === 'verified' || status === 'canonical') &&
        !actorRoles.some((role) => role === 'tech_lead' || role === 'admin')
      ) {
        throw Object.assign(new Error(`Cannot set knowledge assets to ${status}`), {
          statusCode: 403,
        });
      }

      return { knowledge_id: 'kn_1', status };
    },
  );
  // Default: a global-scope asset, so the new project-scoping check is a
  // no-op for the pre-existing role-loading tests below.
  const getAssetMock = vi.fn().mockResolvedValue({
    knowledge_id: 'kn_1',
    scope_type: 'global',
    scope_ref: 'global',
  });
  class KnowledgeServiceMock {
    updateStatus = updateStatusMock;
    getAsset = getAssetMock;
  }
  const getUserMock = vi.fn();
  const docMock = vi.fn(() => ({ get: getUserMock }));
  // Defaults to "repo not found" — tests that exercise repo scope resolution
  // override this with mockResolvedValue.
  const getRepoMock = vi.fn().mockResolvedValue({ exists: false });
  const existingProjectIds = new Set<string>();
  const collectionsMock = {
    users: vi.fn(() => ({ doc: docMock })),
    projects: vi.fn(() => ({
      doc: vi.fn((projectId: string) => ({
        get: async () => ({ exists: existingProjectIds.has(projectId) }),
      })),
    })),
    repositories: vi.fn(() => ({ doc: vi.fn(() => ({ get: getRepoMock })) })),
  };

  return {
    updateStatusMock,
    getAssetMock,
    KnowledgeServiceMock,
    getUserMock,
    docMock,
    getRepoMock,
    existingProjectIds,
    collectionsMock,
  };
});

vi.mock('@arbitra/backend', () => ({
  KnowledgeService: KnowledgeServiceMock,
  collections: collectionsMock,
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

import { PATCH } from './route';

function makeRequest(status: string): NextRequest {
  return new NextRequest('http://localhost/api/knowledge/kn_1/status', {
    method: 'PATCH',
    body: JSON.stringify({ status }),
    headers: { 'content-type': 'application/json' },
  });
}

const params = Promise.resolve({ knowledgeId: 'kn_1' });

function mockUserRoles(roles: string[]): void {
  getUserMock.mockResolvedValue({
    exists: true,
    data: () => ({ roles }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireProjectAccess.mockResolvedValue(null);
  getAssetMock.mockResolvedValue({
    knowledge_id: 'kn_1',
    scope_type: 'global',
    scope_ref: 'global',
  });
  getRepoMock.mockResolvedValue({ exists: false });
  existingProjectIds.clear();
  existingProjectIds.add('proj_x');
  existingProjectIds.add('proj_y');
  mockUserRoles([]);
});

describe('PATCH /api/knowledge/[knowledgeId]/status role loading', () => {
  it('returns 403 when a non-privileged caller promotes suggested to verified', async () => {
    mockUserRoles(['developer']);

    const response = await PATCH(makeRequest('verified'), { params });

    expect(response.status).toBe(403);
    expect(updateStatusMock).toHaveBeenCalledWith(
      'kn_1',
      'verified',
      'user_1',
      ['developer'],
    );
  });

  it.each(['tech_lead', 'admin'])(
    'allows a %s caller to promote suggested to verified',
    async (role) => {
      mockUserRoles([role]);

      const response = await PATCH(makeRequest('verified'), { params });

      expect(response.status).toBe(200);
      expect(updateStatusMock).toHaveBeenCalledWith(
        'kn_1',
        'verified',
        'user_1',
        [role],
      );
    },
  );

  it('keeps canonical promotion gated', async () => {
    mockUserRoles(['developer']);

    const response = await PATCH(makeRequest('canonical'), { params });

    expect(response.status).toBe(403);
    expect(updateStatusMock).toHaveBeenCalledWith(
      'kn_1',
      'canonical',
      'user_1',
      ['developer'],
    );
  });

  it('does not load roles for other target statuses', async () => {
    const response = await PATCH(makeRequest('deprecated'), { params });

    expect(response.status).toBe(200);
    expect(collectionsMock.users).not.toHaveBeenCalled();
    expect(updateStatusMock).toHaveBeenCalledWith(
      'kn_1',
      'deprecated',
      'user_1',
      [],
    );
  });
});

describe('PATCH /api/knowledge/[knowledgeId]/status project scoping', () => {
  it('denies a status change on a project-scoped asset when the caller lacks project access, even with a global privileged role', async () => {
    getAssetMock.mockResolvedValue({
      knowledge_id: 'kn_2',
      scope_type: 'project',
      scope_ref: 'proj_x',
    });
    requireProjectAccess.mockResolvedValue(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );
    mockUserRoles(['tech_lead']);

    const response = await PATCH(makeRequest('verified'), { params });

    expect(response.status).toBe(404);
    expect(requireProjectAccess).toHaveBeenCalledWith('proj_x', 'user_1');
    expect(updateStatusMock).not.toHaveBeenCalled();
  });

  it('allows a status change on a project-scoped asset for a member', async () => {
    getAssetMock.mockResolvedValue({
      knowledge_id: 'kn_2',
      scope_type: 'project',
      scope_ref: 'proj_x',
    });
    requireProjectAccess.mockResolvedValue(null);
    mockUserRoles(['tech_lead']);

    const response = await PATCH(makeRequest('verified'), { params });

    expect(response.status).toBe(200);
    expect(updateStatusMock).toHaveBeenCalledWith('kn_1', 'verified', 'user_1', ['tech_lead']);
  });

  it('resolves repo scope to its owning project before checking access', async () => {
    getAssetMock.mockResolvedValue({
      knowledge_id: 'kn_3',
      scope_type: 'repo',
      scope_ref: 'repo_1',
    });
    getRepoMock.mockResolvedValue({ exists: true, data: () => ({ project_id: 'proj_y' }) });
    requireProjectAccess.mockResolvedValue(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const response = await PATCH(makeRequest('deprecated'), { params });

    expect(response.status).toBe(404);
    expect(requireProjectAccess).toHaveBeenCalledWith('proj_y', 'user_1');
    expect(updateStatusMock).not.toHaveBeenCalled();
  });

  it('404s a repo-scoped asset when its owning project is missing', async () => {
    getAssetMock.mockResolvedValue({
      knowledge_id: 'kn_3',
      scope_type: 'repo',
      scope_ref: 'repo_1',
    });
    getRepoMock.mockResolvedValue({
      exists: true,
      data: () => ({ project_id: 'proj_missing' }),
    });

    const response = await PATCH(makeRequest('deprecated'), { params });

    expect(response.status).toBe(404);
    expect(requireProjectAccess).not.toHaveBeenCalled();
    expect(updateStatusMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed status body with 400 (Zod validation)', async () => {
    const response = await PATCH(makeRequest('not_a_real_status'), { params });

    expect(response.status).toBe(400);
    expect(getAssetMock).not.toHaveBeenCalled();
    expect(updateStatusMock).not.toHaveBeenCalled();
  });
});
