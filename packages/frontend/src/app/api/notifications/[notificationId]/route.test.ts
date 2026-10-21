/**
 * DELETE never checked notification ownership. Pins the ownership check now enforced by `NotificationService.delete`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { deleteNotification } = vi.hoisted(() => ({
  deleteNotification: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  NotificationService: class {
    delete = deleteNotification;
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

import { DELETE } from './route';

function deleteReq(): NextRequest {
  return new NextRequest('http://localhost/api/notifications/notif_1', { method: 'DELETE' });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_1' });
});

describe('DELETE /api/notifications/:notificationId', () => {
  it('forwards the caller id to the service for the ownership check', async () => {
    deleteNotification.mockResolvedValueOnce(undefined);
    const res = await DELETE(deleteReq(), { params: Promise.resolve({ notificationId: 'notif_1' }) });
    expect(res.status).toBe(200);
    expect(deleteNotification).toHaveBeenCalledWith('notif_1', 'usr_1');
  });

  it('propagates 404 when the service rejects (not found / not owned)', async () => {
    deleteNotification.mockRejectedValueOnce(
      Object.assign(new Error('Notification not found: notif_1'), { statusCode: 404 }),
    );
    const res = await DELETE(deleteReq(), { params: Promise.resolve({ notificationId: 'notif_1' }) });
    expect(res.status).toBe(404);
  });
});
