import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET /api/sessions/active must not leak sessions across projects: a
// non-admin caller only sees sessions whose repository resolves to a
// project they're an effective member of. Admins see everything. A session
// whose repository can't be resolved to any project doc is omitted for
// non-admins (fail closed, not fail open).
// ---------------------------------------------------------------------------

const { listActiveSessions, checkIsAdmin, getAccessibleProjectIds, repoGet } = vi.hoisted(() => ({
  listActiveSessions: vi.fn(),
  checkIsAdmin: vi.fn(),
  getAccessibleProjectIds: vi.fn(),
  repoGet: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  listActiveSessions,
  checkIsAdmin,
  getAccessibleProjectIds,
  // Mirrors the backend's shared resolver contract: a map holding only the
  // refs that resolved (id-shaped or via webhook name-matching).
  resolveSessionRepositories: async (refs: readonly string[]) => {
    const map = new Map<string, { project_id: string }>();
    for (const ref of [...new Set(refs)]) {
      const doc = repoGet(ref);
      if (doc?.exists) map.set(ref, doc.data());
    }
    return map;
  },
}));

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock('@/lib/api-helpers', () => ({
  authenticate,
  handleError: (error: unknown) =>
    NextResponse.json(
      { error: { message: error instanceof Error ? error.message : String(error) } },
      { status: 500 },
    ),
}));

import { GET } from './route';

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/sessions/active');
}

const SESSION_A = {
  session_id: 'sess_a',
  agent_name: 'claude-code',
  repository: 'repo_project_1',
  branch: 'feat/a',
  last_seen_at: '2026-08-27T00:00:00.000Z',
};
const SESSION_B = {
  session_id: 'sess_b',
  agent_name: 'codex',
  repository: 'repo_project_2',
  branch: 'feat/b',
  last_seen_at: '2026-08-27T00:00:00.000Z',
};
const SESSION_UNRESOLVABLE = {
  session_id: 'sess_c',
  agent_name: 'cursor',
  repository: 'repo_unknown',
  branch: 'feat/c',
  last_seen_at: '2026-08-27T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_1', email: 'a@b.c', authType: 'token' });
  listActiveSessions.mockResolvedValue([SESSION_A, SESSION_B, SESSION_UNRESOLVABLE]);
  repoGet.mockImplementation((id: string) => {
    if (id === 'repo_project_1') return { exists: true, data: () => ({ project_id: 'proj_1' }) };
    if (id === 'repo_project_2') return { exists: true, data: () => ({ project_id: 'proj_2' }) };
    return { exists: false, data: () => undefined };
  });
});

describe('GET /api/sessions/active', () => {
  it('returns every session unfiltered for an admin', async () => {
    // Reverting the `if (isAdmin) return ...` early return would run the
    // non-admin scoping below for admins too, failing this length assertion
    // once accessibleProjectIds excludes proj_2.
    checkIsAdmin.mockResolvedValue(true);

    const res = await GET(makeReq());
    const body = await res.json();

    expect(body.sessions).toHaveLength(3);
  });

  it('scopes a non-admin caller to sessions in their accessible projects only', async () => {
    // Reverting the `accessible.has(projectId)` filter (returning `sessions`
    // unfiltered for non-admins) would include sess_b (proj_2, not
    // accessible) in the result, failing this assertion.
    checkIsAdmin.mockResolvedValue(false);
    getAccessibleProjectIds.mockResolvedValue(['proj_1']);

    const res = await GET(makeReq());
    const body = await res.json();

    expect(body.sessions.map((s: { session_id: string }) => s.session_id)).toEqual(['sess_a']);
  });

  it('omits a session whose repository cannot be resolved to a project, for a non-admin', async () => {
    // Reverting the `if (!projectId) return false` fail-closed branch (e.g.
    // to `if (!projectId) return true`) would let sess_c — whose repository
    // doc doesn't exist — leak through for a non-admin, failing this
    // assertion.
    checkIsAdmin.mockResolvedValue(false);
    getAccessibleProjectIds.mockResolvedValue(['proj_1', 'proj_2']);

    const res = await GET(makeReq());
    const body = await res.json();

    expect(body.sessions.map((s: { session_id: string }) => s.session_id).sort()).toEqual(['sess_a', 'sess_b']);
  });
});
