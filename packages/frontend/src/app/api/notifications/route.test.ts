/**
 * Issue #794 P0 — GET /api/notifications now takes optional cursor/limit
 * query params and returns a page (`notifications`, `next_cursor`,
 * `unread_count`) instead of a bare array-wrapping object.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { listNotifications } = vi.hoisted(() => ({
  listNotifications: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  NotificationService: class {
    listNotifications = listNotifications;
  },
}));

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    handleError: (err: unknown) => {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status });
    },
  };
});

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_1' });
});

describe('GET /api/notifications', () => {
  it('an old client with no query params still gets a valid page', async () => {
    listNotifications.mockResolvedValueOnce({ notifications: [], next_cursor: null, unread_count: 0 });

    const res = await GET(new NextRequest('http://localhost/api/notifications'));

    expect(res.status).toBe(200);
    expect(listNotifications).toHaveBeenCalledWith('usr_1', { cursor: undefined, limit: undefined });
    await expect(res.json()).resolves.toEqual({ notifications: [], next_cursor: null, unread_count: 0 });
  });

  it('forwards cursor and limit query params to the service', async () => {
    listNotifications.mockResolvedValueOnce({ notifications: [], next_cursor: null, unread_count: 0 });

    await GET(new NextRequest('http://localhost/api/notifications?cursor=abc&limit=10'));

    expect(listNotifications).toHaveBeenCalledWith('usr_1', { cursor: 'abc', limit: 10 });
  });
});
