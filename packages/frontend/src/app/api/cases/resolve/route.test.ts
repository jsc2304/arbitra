import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET /api/cases/resolve — branch-keyed case resolution (issue #982).
// Mirrors the mocking style of cases/route.test.ts and
// cases/actionable-count/route.test.ts: the backend seam
// (`resolveCaseByBranch`) and the project-access boundary
// (`requireProjectAccess`) are the things we assert on directly.
// ---------------------------------------------------------------------------

const { resolveCaseByBranch } = vi.hoisted(() => ({
  resolveCaseByBranch: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  resolveCaseByBranch,
  validateBody: <T>(schema: { safeParse: (body: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, body: unknown): T => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const err = new Error('Invalid request payload') as Error & { issues: unknown[] };
      err.issues = parsed.error.issues;
      throw err;
    }
    return parsed.data;
  },
}));

const { authenticate, requireProjectAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => ({
  authenticate,
  requireProjectAccess,
  handleError: (error: unknown) => {
    const isValidation = error instanceof Error && 'issues' in error;
    const status =
      error instanceof Error && 'status' in error
        ? (error as Error & { status: number }).status
        : isValidation
          ? 400
          : 500;
    return NextResponse.json(
      {
        error: {
          code: isValidation ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status },
    );
  },
}));

import { GET } from './route';

function makeReq(query: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/cases/resolve');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

function makeCase(overrides: Record<string, unknown> = {}) {
  return {
    case_id: 'case_A',
    project_id: 'proj_1',
    repository_id: 'repo_X',
    current_branch: 'feat/foo',
    status: 'in_build',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireProjectAccess.mockResolvedValue(null);
});

describe('GET /api/cases/resolve', () => {
  it('returns the bound case for a known (repository_id, branch) pair', async () => {
    // Reverting the `resolveCaseByBranch({ repositoryId, branch })` call in
    // route.ts (or passing the wrong field names) would make this see
    // `resolveCaseByBranch` invoked with undefined args instead.
    resolveCaseByBranch.mockResolvedValue({ case: makeCase(), ambiguous: false });

    const res = await GET(makeReq({ repository_id: 'repo_X', branch: 'feat/foo' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.case.case_id).toBe('case_A');
    expect(body.ambiguous).toBe(false);
    expect(resolveCaseByBranch).toHaveBeenCalledWith({ repositoryId: 'repo_X', branch: 'feat/foo' });
  });

  it('returns "no case" as a normal 200 answer for an unknown branch, not an error', async () => {
    // Reverting the direct pass-through of `result` in route.ts (e.g.
    // throwing NotFoundError when `case` is null) would turn this into a
    // 404/500 instead of a plain 200 with `case: null`.
    resolveCaseByBranch.mockResolvedValue({ case: null, ambiguous: false });

    const res = await GET(makeReq({ repository_id: 'repo_X', branch: 'feat/unknown' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ case: null, ambiguous: false });
  });

  it('surfaces the ambiguous flag when multiple non-terminal cases share a branch', async () => {
    // Reverting the pass-through of `result.ambiguous` in route.ts would
    // make this always report `false` regardless of what the service
    // returned.
    resolveCaseByBranch.mockResolvedValue({ case: makeCase({ case_id: 'case_newest' }), ambiguous: true });

    const res = await GET(makeReq({ repository_id: 'repo_X', branch: 'feat/foo' }));

    const body = await res.json();
    expect(body.ambiguous).toBe(true);
    expect(body.case.case_id).toBe('case_newest');
  });

  it('rejects a request missing branch with a 400 validation error', async () => {
    // Reverting the `validateBody(resolveCaseByBranchSchema, ...)` call in
    // route.ts would let an incomplete query straight through to
    // `resolveCaseByBranch` instead of failing validation up front.
    const res = await GET(makeReq({ repository_id: 'repo_X' }));

    expect(res.status).toBe(400);
    expect(resolveCaseByBranch).not.toHaveBeenCalled();
  });

  it('does not leak a case the caller has no project access to', async () => {
    // Reverting the `requireProjectAccess(result.case.project_id, ...)`
    // check in route.ts would let a caller resolve a branch into a case
    // belonging to a project they cannot see.
    resolveCaseByBranch.mockResolvedValue({ case: makeCase({ project_id: 'proj_hidden' }), ambiguous: false });
    requireProjectAccess.mockResolvedValue(NextResponse.json({ error: { message: 'not found' } }, { status: 404 }));

    const res = await GET(makeReq({ repository_id: 'repo_X', branch: 'feat/foo' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ case: null, ambiguous: false });
  });

  it('propagates authentication failures without calling resolveCaseByBranch', async () => {
    const authError = Object.assign(new Error('unauthorized'), { status: 401 });
    authenticate.mockRejectedValue(authError);

    const res = await GET(makeReq({ repository_id: 'repo_X', branch: 'feat/foo' }));

    expect(res.status).toBe(401);
    expect(resolveCaseByBranch).not.toHaveBeenCalled();
  });
});
