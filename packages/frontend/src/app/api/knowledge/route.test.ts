import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  createAssetMock,
  KnowledgeServiceMock,
  knowledgeAssetsGetMock,
  checkIsAdmin,
  getAccessibleProjectIds,
  repoProjectMap,
  decisionDocs,
  existingProjectIds,
  existingCaseIds,
  collectionsMock,
} = vi.hoisted(() => {
  const createAssetMock = vi.fn();
  class KnowledgeServiceMock {
    createAsset = createAssetMock;
  }

  const knowledgeAssetsGetMock = vi.fn();
  const checkIsAdmin = vi.fn();
  const getAccessibleProjectIds = vi.fn();

  // repo_id -> project_id (absent => repo doesn't exist)
  const repoProjectMap = new Map<string, string>();
  // decision_id -> { case_id } (absent => decision doesn't exist)
  const decisionDocs = new Map<string, { case_id: string }>();
  const existingProjectIds = new Set<string>();
  const existingCaseIds = new Set<string>();

  const collectionsMock = {
    knowledgeAssets: () => ({ get: knowledgeAssetsGetMock }),
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
    cases: () => ({
      doc: (caseId: string) => ({
        get: async () => ({ exists: existingCaseIds.has(caseId) }),
      }),
    }),
    decisions: () => ({
      doc: (decisionId: string) => ({
        get: async () => {
          const rec = decisionDocs.get(decisionId);
          return rec ? { exists: true, data: () => rec } : { exists: false };
        },
      }),
    }),
  };

  return {
    createAssetMock,
    KnowledgeServiceMock,
    knowledgeAssetsGetMock,
    checkIsAdmin,
    getAccessibleProjectIds,
    repoProjectMap,
    decisionDocs,
    existingProjectIds,
    existingCaseIds,
    collectionsMock,
  };
});

vi.mock('@arbitra/backend', () => ({
  KnowledgeService: KnowledgeServiceMock,
  collections: collectionsMock,
  checkIsAdmin,
  getAccessibleProjectIds,
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T =>
    schema.parse(body),
}));

const { authenticate, requireCaseAccess, requireProjectAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireCaseAccess: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    requireCaseAccess,
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

import { GET, POST } from './route';

function makeGetRequest(): NextRequest {
  return new NextRequest('http://localhost/api/knowledge', { method: 'GET' });
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/knowledge', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const VALID_BODY = 'x'.repeat(50);
const VALID_SUMMARY = 'y'.repeat(10);

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Title',
    type: 'pattern',
    summary: VALID_SUMMARY,
    body: VALID_BODY,
    scope_type: 'global',
    scope_ref: 'global',
    ...overrides,
  };
}

function asset(overrides: Record<string, unknown>): Record<string, unknown> {
  return { knowledge_id: 'kn_x', scope_type: 'global', scope_ref: 'global', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireCaseAccess.mockResolvedValue(null);
  requireProjectAccess.mockResolvedValue(null);
  createAssetMock.mockResolvedValue({ knowledge_id: 'kn_1' });
  checkIsAdmin.mockResolvedValue(false);
  getAccessibleProjectIds.mockResolvedValue([]);
  repoProjectMap.clear();
  decisionDocs.clear();
  existingProjectIds.clear();
  existingProjectIds.add('proj_x');
  existingCaseIds.clear();
  existingCaseIds.add('case_x');
  existingCaseIds.add('case_ok');
});

describe('GET /api/knowledge project scoping', () => {
  it('hides project-scoped assets from a non-member but keeps global ones visible', async () => {
    getAccessibleProjectIds.mockResolvedValue(['proj_member']);
    knowledgeAssetsGetMock.mockResolvedValue({
      docs: [
        { data: () => asset({ knowledge_id: 'kn_global', scope_type: 'global', scope_ref: 'global' }) },
        { data: () => asset({ knowledge_id: 'kn_proj_x', scope_type: 'project', scope_ref: 'proj_x' }) },
        { data: () => asset({ knowledge_id: 'kn_proj_member', scope_type: 'project', scope_ref: 'proj_member' }) },
      ],
    });

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = json.assets.map((a: { knowledge_id: string }) => a.knowledge_id);
    expect(ids).toContain('kn_global');
    expect(ids).toContain('kn_proj_member');
    expect(ids).not.toContain('kn_proj_x');
  });

  it('resolves repo-scoped assets to their owning project before filtering', async () => {
    getAccessibleProjectIds.mockResolvedValue(['proj_member']);
    repoProjectMap.set('repo_member', 'proj_member');
    repoProjectMap.set('repo_x', 'proj_x');
    knowledgeAssetsGetMock.mockResolvedValue({
      docs: [
        { data: () => asset({ knowledge_id: 'kn_repo_member', scope_type: 'repo', scope_ref: 'repo_member' }) },
        { data: () => asset({ knowledge_id: 'kn_repo_x', scope_type: 'repo', scope_ref: 'repo_x' }) },
      ],
    });

    const res = await GET(makeGetRequest());
    const json = await res.json();
    const ids = json.assets.map((a: { knowledge_id: string }) => a.knowledge_id);
    expect(ids).toEqual(['kn_repo_member']);
  });

  it('returns every asset unfiltered for an admin', async () => {
    checkIsAdmin.mockResolvedValue(true);
    knowledgeAssetsGetMock.mockResolvedValue({
      docs: [
        { data: () => asset({ knowledge_id: 'kn_a', scope_type: 'project', scope_ref: 'proj_x' }) },
        { data: () => asset({ knowledge_id: 'kn_b', scope_type: 'project', scope_ref: 'proj_y' }) },
      ],
    });

    const res = await GET(makeGetRequest());
    const json = await res.json();
    expect(json.assets).toHaveLength(2);
    expect(getAccessibleProjectIds).not.toHaveBeenCalled();
  });
});

describe('POST /api/knowledge project + case scoping', () => {
  it('404s a nonexistent project scope without creating an asset', async () => {
    existingProjectIds.delete('proj_x');

    const res = await POST(makePostRequest(basePayload({ scope_type: 'project', scope_ref: 'proj_x' })));

    expect(res.status).toBe(404);
    expect(requireProjectAccess).not.toHaveBeenCalled();
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it('denies creating a project-scoped asset when the caller lacks access to that project', async () => {
    requireProjectAccess.mockResolvedValue(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const res = await POST(makePostRequest(basePayload({ scope_type: 'project', scope_ref: 'proj_x' })));

    expect(res.status).toBe(404);
    expect(requireProjectAccess).toHaveBeenCalledWith('proj_x', 'user_1');
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it('allows creating a project-scoped asset for a project member', async () => {
    const res = await POST(makePostRequest(basePayload({ scope_type: 'project', scope_ref: 'proj_x' })));

    expect(res.status).toBe(201);
    expect(createAssetMock).toHaveBeenCalledOnce();
  });

  it('resolves repo scope to its owning project before checking access', async () => {
    repoProjectMap.set('repo_1', 'proj_x');
    requireProjectAccess.mockResolvedValue(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const res = await POST(makePostRequest(basePayload({ scope_type: 'repo', scope_ref: 'repo_1' })));

    expect(res.status).toBe(404);
    expect(requireProjectAccess).toHaveBeenCalledWith('proj_x', 'user_1');
  });

  it('404s a repo scope whose owning project does not exist', async () => {
    repoProjectMap.set('repo_1', 'proj_missing');

    const res = await POST(makePostRequest(basePayload({ scope_type: 'repo', scope_ref: 'repo_1' })));

    expect(res.status).toBe(404);
    expect(requireProjectAccess).not.toHaveBeenCalled();
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it('denies a repo scope that does not resolve to any repository', async () => {
    const res = await POST(makePostRequest(basePayload({ scope_type: 'repo', scope_ref: 'no_such_repo' })));

    expect(res.status).toBe(404);
    expect(requireProjectAccess).not.toHaveBeenCalled();
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it('denies creation citing a case the caller cannot access', async () => {
    requireCaseAccess.mockResolvedValue(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const res = await POST(makePostRequest(basePayload({ source_case_refs: ['case_x'] })));

    expect(res.status).toBe(404);
    expect(requireCaseAccess).toHaveBeenCalledWith('case_x', 'user_1');
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it('404s creation citing a case that does not exist without writing', async () => {
    const res = await POST(makePostRequest(basePayload({ source_case_refs: ['case_missing'] })));

    expect(res.status).toBe(404);
    expect(requireCaseAccess).not.toHaveBeenCalled();
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it('allows creation citing a case the caller can access', async () => {
    const res = await POST(makePostRequest(basePayload({ source_case_refs: ['case_ok'] })));

    expect(res.status).toBe(201);
    expect(requireCaseAccess).toHaveBeenCalledWith('case_ok', 'user_1');
  });

  it('denies creation citing a decision belonging to a case the caller cannot access', async () => {
    decisionDocs.set('decision_1', { case_id: 'case_x' });
    requireCaseAccess.mockResolvedValue(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const res = await POST(makePostRequest(basePayload({ source_decision_refs: ['decision_1'] })));

    expect(res.status).toBe(404);
    expect(requireCaseAccess).toHaveBeenCalledWith('case_x', 'user_1');
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it('404s when a cited decision does not exist', async () => {
    const res = await POST(makePostRequest(basePayload({ source_decision_refs: ['missing_decision'] })));

    expect(res.status).toBe(404);
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it('404s when a cited decision belongs to a missing case', async () => {
    decisionDocs.set('decision_orphaned', { case_id: 'case_missing' });

    const res = await POST(makePostRequest(basePayload({
      source_decision_refs: ['decision_orphaned'],
    })));

    expect(res.status).toBe(404);
    expect(requireCaseAccess).not.toHaveBeenCalled();
    expect(createAssetMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/knowledge body validation (Zod)', () => {
  it('rejects a non-object body', async () => {
    const req = new NextRequest('http://localhost/api/knowledge', {
      method: 'POST',
      body: JSON.stringify('not an object'),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it('rejects a body under the summary/body length thresholds', async () => {
    const res = await POST(makePostRequest(basePayload({ body: 'x'.repeat(49) })));
    expect(res.status).toBe(400);
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it('accepts a body at exactly the length thresholds', async () => {
    const res = await POST(makePostRequest(basePayload({ body: 'x'.repeat(50), summary: 'y'.repeat(10) })));
    expect(res.status).toBe(201);
    expect(createAssetMock).toHaveBeenCalledOnce();
  });

  it('rejects an invalid scope_type', async () => {
    const res = await POST(makePostRequest(basePayload({ scope_type: 'not_a_scope' })));
    expect(res.status).toBe(400);
  });

  it('rejects a non-array source_case_refs instead of silently dropping it', async () => {
    // Deliberate tightening (knowledge-validators.ts): the hand-rolled
    // route silently coerced a non-array value to `undefined`; the Zod
    // schema now rejects it with 400.
    const res = await POST(makePostRequest(basePayload({ source_case_refs: 'not-an-array' })));
    expect(res.status).toBe(400);
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it('rejects a non-array source_decision_refs instead of silently dropping it', async () => {
    const res = await POST(makePostRequest(basePayload({ source_decision_refs: 'not-an-array' })));
    expect(res.status).toBe(400);
    expect(createAssetMock).not.toHaveBeenCalled();
  });
});
