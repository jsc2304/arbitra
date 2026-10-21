import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { buildLeaderboard, checkIsAdmin, authenticateFromHeader } = vi.hoisted(() => ({
  buildLeaderboard: vi.fn(),
  checkIsAdmin: vi.fn(),
  authenticateFromHeader: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  buildLeaderboard,
  checkIsAdmin,
  authenticateFromHeader,
  formatError: (error: unknown) => ({
    status: 500,
    body: {
      error: { code: 'INTERNAL', message: error instanceof Error ? error.message : 'error' },
    },
  }),
}));

import { GET } from './route';

function makeReq(url: string): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateFromHeader.mockResolvedValue({ userId: 'user_1' });
  checkIsAdmin.mockResolvedValue(true);
  buildLeaderboard.mockResolvedValue({
    rows: [
      {
        source_kind: 'client',
        client_name: 'claude-code',
        model: 'claude-opus-4-7',
        counts: {
          cases_created: 1,
          comments: 3,
          evidence: 2,
          findings: 0,
          decisions: 1,
          workspace_events: 0,
          total: 7,
        },
      },
    ],
    project_rows: [
      {
        project_id: 'proj_1',
        project_name: 'Alpha',
        active_cases: 2,
        counts: {
          cases_created: 1,
          comments: 3,
          evidence: 2,
          findings: 0,
          decisions: 1,
          workspace_events: 0,
          total: 7,
        },
      },
    ],
  });
});

describe('GET /api/activity/leaderboard', () => {
  it('defaults to a 24h window', async () => {
    const res = await GET(makeReq('http://localhost/api/activity/leaderboard'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window).toBe('24h');
    expect(buildLeaderboard).toHaveBeenCalledWith('user_1', true, '24h');
    expect(body.rows).toHaveLength(1);
    expect(body.project_rows).toHaveLength(1);
  });

  it('honors an explicit 7d window', async () => {
    const res = await GET(makeReq('http://localhost/api/activity/leaderboard?window=7d'));
    expect(res.status).toBe(200);
    expect(buildLeaderboard).toHaveBeenCalledWith('user_1', true, '7d');
  });

  it('falls back to 24h when an unknown window value is passed', async () => {
    await GET(makeReq('http://localhost/api/activity/leaderboard?window=42y'));
    expect(buildLeaderboard).toHaveBeenCalledWith('user_1', true, '24h');
  });

  it('propagates admin=false to the service for non-admin callers', async () => {
    checkIsAdmin.mockResolvedValue(false);
    await GET(makeReq('http://localhost/api/activity/leaderboard?window=30d'));
    expect(buildLeaderboard).toHaveBeenCalledWith('user_1', false, '30d');
  });

  it('requires authentication', async () => {
    authenticateFromHeader.mockRejectedValueOnce(new Error('unauthorized'));
    const res = await GET(makeReq('http://localhost/api/activity/leaderboard'));
    expect(res.status).toBe(500);
    expect(buildLeaderboard).not.toHaveBeenCalled();
  });
});
