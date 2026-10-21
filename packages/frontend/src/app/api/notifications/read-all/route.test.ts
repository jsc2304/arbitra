/**
 * Issue #794 P0 — bulk mark-all-as-read, the server-side companion to
 * pagination (see the route's doc comment for why).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { markAllAsRead } = vi.hoisted(() => ({
  markAllAsRead: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  NotificationService: class {
    markAllAsRead = markAllAsRead;
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

import { POST } from './route';

function postReq(): NextRequest {
  return new NextRequest('http://localhost/api/notifications/read-all', { method: 'POST' });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_1' });
});

describe('POST /api/notifications/read-all', () => {
  it('scopes the bulk mark-as-read to the authenticated caller and returns the count', async () => {
    markAllAsRead.mockResolvedValueOnce(3);
    const res = await POST(postReq());
    expect(res.status).toBe(200);
    expect(markAllAsRead).toHaveBeenCalledWith('usr_1');
    await expect(res.json()).resolves.toEqual({ status: 'ok', count: 3 });
  });

  it('propagates errors from the service via handleError', async () => {
    markAllAsRead.mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }));
    const res = await POST(postReq());
    expect(res.status).toBe(500);
  });
});
