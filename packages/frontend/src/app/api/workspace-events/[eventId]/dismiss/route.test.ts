import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { authenticateFromHeader, WorkspaceEventService, dismissMock } = vi.hoisted(() => {
  const dismissMock = vi.fn();
  class MockService {
    dismissForUser = dismissMock;
  }
  return {
    authenticateFromHeader: vi.fn(),
    WorkspaceEventService: MockService,
    dismissMock,
  };
});

vi.mock('@arbitra/backend', () => ({
  WorkspaceEventService,
  authenticateFromHeader,
  formatError: (error: unknown) => ({
    status: error instanceof Error && error.message === 'unauthorized' ? 401 : 500,
    body: { error: { code: 'E', message: error instanceof Error ? error.message : 'e' } },
  }),
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown) => schema.parse(body),
}));

import { POST } from './route';

function makeReq(eventId: string, auth: string | null = 'Bearer t'): NextRequest {
  return new NextRequest(`http://localhost/api/workspace-events/${eventId}/dismiss`, {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateFromHeader.mockResolvedValue({ userId: 'usr_7' });
});

describe('POST /api/workspace-events/:eventId/dismiss', () => {
  it('rejects unauthenticated callers (401)', async () => {
    authenticateFromHeader.mockRejectedValueOnce(new Error('unauthorized'));
    const res = await POST(makeReq('we_1'), { params: Promise.resolve({ eventId: 'we_1' }) });
    expect(res.status).toBe(401);
    expect(dismissMock).not.toHaveBeenCalled();
  });

  it('succeeds for any authenticated user (200) — no role gate', async () => {
    authenticateFromHeader.mockResolvedValueOnce({ userId: 'usr_dev' });
    dismissMock.mockResolvedValueOnce({
      user_id: 'usr_dev',
      event_id: 'we_1',
      dismissed_at: '2026-04-23T00:00:00.000Z',
    });
    const res = await POST(makeReq('we_1'), { params: Promise.resolve({ eventId: 'we_1' }) });
    expect(res.status).toBe(200);
    expect(dismissMock).toHaveBeenCalledWith('we_1', 'usr_dev');
    const body = await res.json();
    expect(body.user_id).toBe('usr_dev');
    expect(body.event_id).toBe('we_1');
  });

  it('is idempotent — a repeat dismiss also returns 200', async () => {
    authenticateFromHeader.mockResolvedValue({ userId: 'usr_7' });
    dismissMock.mockResolvedValue({
      user_id: 'usr_7',
      event_id: 'we_1',
      dismissed_at: '2026-04-23T00:00:00.000Z',
    });
    const r1 = await POST(makeReq('we_1'), { params: Promise.resolve({ eventId: 'we_1' }) });
    const r2 = await POST(makeReq('we_1'), { params: Promise.resolve({ eventId: 'we_1' }) });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(dismissMock).toHaveBeenCalledTimes(2);
  });
});
