import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET /api/mission-control: auth boundary + shape. The join/scoping logic
// itself is tested at the service layer (mission-control-service.test.ts);
// this route test only pins that the route authenticates, resolves the
// caller's admin status, and passes the right `accessibleProjectIds` shape
// through to the aggregate builder.
// ---------------------------------------------------------------------------

const {
  buildMissionControlAggregate,
  buildActiveSessionsPanel,
  applyMissionControlRowCap,
  checkIsAdmin,
  getAccessibleProjectIds,
} = vi.hoisted(() => ({
  buildMissionControlAggregate: vi.fn(),
  buildActiveSessionsPanel: vi.fn(),
  applyMissionControlRowCap: vi.fn(),
  checkIsAdmin: vi.fn(),
  getAccessibleProjectIds: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  buildMissionControlAggregate,
  buildActiveSessionsPanel,
  applyMissionControlRowCap,
  checkIsAdmin,
  getAccessibleProjectIds,
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
  return new NextRequest('http://localhost/api/mission-control');
}

const ROW = {
  session_id: 'sess_a',
  agent_name: 'claude-code',
  repository_id: 'repo_1',
  repository_name: 'arbitra-app',
  project_id: 'proj_1',
  project_name: 'Project A',
  branch: 'feat/a',
  case: null,
  last_seen_at: '2026-08-27T00:00:00.000Z',
};

const PANEL = {
  window_24h: { sessions: 1, distinct_users: 1 },
  window_7d: { sessions: 1, distinct_users: 1 },
  window_30d: { sessions: 1, distinct_users: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_1', email: 'a@b.c', authType: 'token' });
  buildMissionControlAggregate.mockResolvedValue([ROW]);
  buildActiveSessionsPanel.mockResolvedValue(PANEL);
  // Real `applyMissionControlRowCap` behavior for the row-cap tests (issue
  // #1003) is pinned at the service layer (mission-control-service.test.ts);
  // this route test only pins that the route calls it and threads its
  // output into the response — pass-through by default, one test below
  // overrides it to pin the truncation wiring specifically.
  applyMissionControlRowCap.mockImplementation((rows: unknown[]) => ({
    sessions: rows,
    truncated_session_count: 0,
  }));
});

describe('GET /api/mission-control', () => {
  it('requires authentication before returning data', async () => {
    // Reverting the `await authenticate(request)` call (or swallowing its
    // rejection) would let this request through even though `authenticate`
    // rejects, failing the `rejects.toThrow` assertion below.
    authenticate.mockRejectedValue(new Error('unauthenticated'));

    await expect(GET(makeReq())).resolves.toBeDefined();
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
  });

  it("passes accessibleProjectIds: 'all' for an admin caller", async () => {
    // Reverting the `isAdmin ? 'all' : ...` branch would call
    // getAccessibleProjectIds even for an admin, changing what's passed to
    // buildMissionControlAggregate and failing this assertion.
    checkIsAdmin.mockResolvedValue(true);

    await GET(makeReq());

    expect(buildMissionControlAggregate).toHaveBeenCalledWith({ accessibleProjectIds: 'all' });
    expect(buildActiveSessionsPanel).toHaveBeenCalledWith({ accessibleProjectIds: 'all' });
    expect(getAccessibleProjectIds).not.toHaveBeenCalled();
  });

  it('passes a Set of accessible project ids for a non-admin caller', async () => {
    // Reverting the `new Set(...)` wrap (passing the raw array through)
    // would fail this assertion since the mock's argument would be an array,
    // not a Set.
    checkIsAdmin.mockResolvedValue(false);
    getAccessibleProjectIds.mockResolvedValue(['proj_1', 'proj_2']);

    await GET(makeReq());

    expect(buildMissionControlAggregate).toHaveBeenCalledWith({
      accessibleProjectIds: new Set(['proj_1', 'proj_2']),
    });
    expect(buildActiveSessionsPanel).toHaveBeenCalledWith({
      accessibleProjectIds: new Set(['proj_1', 'proj_2']),
    });
  });

  it('returns the aggregate rows under `sessions` and the panel under `active_sessions_panel`', async () => {
    // Reverting the response shape (e.g. returning the array directly, or
    // dropping the panel field) would fail this assertion.
    checkIsAdmin.mockResolvedValue(true);

    const res = await GET(makeReq());
    const body = await res.json();

    expect(body).toEqual({ sessions: [ROW], active_sessions_panel: PANEL, truncated_session_count: 0 });
  });

  it('applies the row cap to the scoped aggregate and threads truncated_session_count through (issue #1003)', async () => {
    // Reverting the `applyMissionControlRowCap(scopedRows)` call in
    // route.ts (e.g. returning `scopedRows` directly under `sessions`, or
    // dropping `truncated_session_count` from the JSON body) would fail
    // this assertion — the mock here reports a non-zero truncation, so the
    // response must carry it through unchanged.
    checkIsAdmin.mockResolvedValue(true);
    applyMissionControlRowCap.mockReturnValue({ sessions: [ROW], truncated_session_count: 42 });

    const res = await GET(makeReq());
    const body = await res.json();

    expect(applyMissionControlRowCap).toHaveBeenCalledWith([ROW]);
    expect(body).toEqual({ sessions: [ROW], active_sessions_panel: PANEL, truncated_session_count: 42 });
  });
});
