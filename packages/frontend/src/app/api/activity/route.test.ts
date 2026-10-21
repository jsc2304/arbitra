import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ActivityEntry } from '@arbitra/shared';

const { listActivity, checkIsAdmin, authenticateFromHeader } = vi.hoisted(() => ({
  listActivity: vi.fn(),
  checkIsAdmin: vi.fn(),
  authenticateFromHeader: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  listActivity,
  checkIsAdmin,
  authenticateFromHeader,
  formatError: (error: unknown) => ({
    status: 500,
    body: {
      error: { code: 'INTERNAL', message: error instanceof Error ? error.message : 'error' },
    },
  }),
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown) => schema.parse(body),
}));

import { GET } from './route';

function makeReq(url: string): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  });
}

function makeEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 'event:evt_1',
    kind: 'case_event',
    subkind: 'case_created',
    timestamp: '2026-04-19T00:00:00.000Z',
    case_id: 'case_1',
    summary: 'opened',
    href: '/cases/case_1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateFromHeader.mockResolvedValue({ userId: 'user_1' });
  checkIsAdmin.mockResolvedValue(true);
  listActivity.mockResolvedValue({
    entries: [makeEntry()],
    cursor: '2026-04-19T00:00:00.000Z',
  });
});

describe('GET /api/activity', () => {
  it('requires authentication', async () => {
    authenticateFromHeader.mockRejectedValueOnce(new Error('unauthorized'));
    const res = await GET(makeReq('http://localhost/api/activity'));
    expect(res.status).toBe(500);
    expect(listActivity).not.toHaveBeenCalled();
  });

  it('returns entries for an authenticated admin caller', async () => {
    const res = await GET(makeReq('http://localhost/api/activity'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.cursor).toBeTruthy();
    expect(listActivity).toHaveBeenCalledWith('user_1', true, {});
  });

  it('forwards all supported query params to the service', async () => {
    const url =
      'http://localhost/api/activity' +
      '?limit=20&since=2026-04-18T00:00:00.000Z&before=2026-04-19T00:00:00.000Z&client_name=cursor&project_id=proj_1&agents_only=true';
    const res = await GET(makeReq(url));
    expect(res.status).toBe(200);
    expect(listActivity).toHaveBeenCalledWith('user_1', true, {
      limit: 20,
      since: '2026-04-18T00:00:00.000Z',
      before: '2026-04-19T00:00:00.000Z',
      clientName: 'cursor',
      projectId: 'proj_1',
      agentsOnly: true,
    });
  });

  it('forwards `before` as the pagination cursor for loadMore()', async () => {
    const res = await GET(
      makeReq('http://localhost/api/activity?before=2026-04-18T00:00:00.000Z'),
    );
    expect(res.status).toBe(200);
    expect(listActivity).toHaveBeenCalledWith('user_1', true, {
      before: '2026-04-18T00:00:00.000Z',
    });
  });

  it('passes admin=false for non-admin callers so the service can scope by project', async () => {
    checkIsAdmin.mockResolvedValue(false);
    await GET(makeReq('http://localhost/api/activity'));
    expect(listActivity).toHaveBeenCalledWith('user_1', false, {});
  });
});
