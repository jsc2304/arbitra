/**
 * POST .../read never checked notification ownership. Pins the ownership
 * check now enforced by `NotificationService.markAsRead`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { markAsRead } = vi.hoisted(() => ({
  markAsRead: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  NotificationService: class {
    markAsRead = markAsRead;
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
  return new NextRequest('http://localhost/api/notifications/notif_1/read', { method: 'POST' });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_1' });
});

describe('POST /api/notifications/:notificationId/read', () => {
  it('forwards the caller id to the service for the ownership check', async () => {
    markAsRead.mockResolvedValueOnce(undefined);
    const res = await POST(postReq(), { params: Promise.resolve({ notificationId: 'notif_1' }) });
    expect(res.status).toBe(200);
    expect(markAsRead).toHaveBeenCalledWith('notif_1', 'usr_1');
  });

  it('propagates 404 when the service rejects (not found / not owned)', async () => {
    markAsRead.mockRejectedValueOnce(
      Object.assign(new Error('Notification not found: notif_1'), { statusCode: 404 }),
    );
    const res = await POST(postReq(), { params: Promise.resolve({ notificationId: 'notif_1' }) });
    expect(res.status).toBe(404);
  });
});
