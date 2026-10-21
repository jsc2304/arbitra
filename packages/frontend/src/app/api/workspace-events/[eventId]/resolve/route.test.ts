import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { WorkspaceEvent } from '@arbitra/shared';

const { authenticateFromHeader, WorkspaceEventService, resolveMock, requireRole } = vi.hoisted(() => {
  const resolveMock = vi.fn();
  class MockService {
    resolve = resolveMock;
  }
  return {
    authenticateFromHeader: vi.fn(),
    WorkspaceEventService: MockService,
    resolveMock,
    requireRole: vi.fn(),
  };
});

vi.mock('@arbitra/backend', () => ({
  WorkspaceEventService,
  authenticateFromHeader,
  requireRole,
  formatError: (error: unknown) => {
    const msg = error instanceof Error ? error.message : 'error';
    const status =
      msg === 'unauthorized' ? 401 : msg === 'forbidden' ? 403 : 500;
    return { status, body: { error: { code: 'E', message: msg } } };
  },
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown) => schema.parse(body),
}));

import { POST } from './route';

function makeReq(eventId: string, auth: string | null = 'Bearer t'): NextRequest {
  return new NextRequest(`http://localhost/api/workspace-events/${eventId}/resolve`, {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
  });
}

const resolved: WorkspaceEvent = {
  event_id: 'we_1',
  type: 'intelligence_run',
  actor_user_id: 'system:arbitra-intelligence',
  timestamp: '2026-04-20T10:00:00.000Z',
  summary: 's',
  resolved_at: '2026-04-21T00:00:00.000Z',
  resolved_by: 'usr_admin',
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticateFromHeader.mockResolvedValue({ userId: 'usr_admin' });
  resolveMock.mockReset();
  requireRole.mockReset();
});

describe('POST /api/workspace-events/:eventId/resolve', () => {
  it('rejects unauthenticated callers (401)', async () => {
    authenticateFromHeader.mockRejectedValueOnce(new Error('unauthorized'));
    const res = await POST(makeReq('we_1'), { params: Promise.resolve({ eventId: 'we_1' }) });
    expect(res.status).toBe(401);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('rejects non-privileged roles (403)', async () => {
    authenticateFromHeader.mockResolvedValueOnce({ userId: 'usr_dev' });
    requireRole.mockRejectedValueOnce(new Error('forbidden'));
    const res = await POST(makeReq('we_1'), { params: Promise.resolve({ eventId: 'we_1' }) });
    expect(res.status).toBe(403);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('succeeds as admin (200) and calls service with userId', async () => {
    authenticateFromHeader.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    resolveMock.mockResolvedValueOnce(resolved);
    const res = await POST(makeReq('we_1'), { params: Promise.resolve({ eventId: 'we_1' }) });
    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith('usr_admin', ['admin', 'tech_lead']);
    expect(resolveMock).toHaveBeenCalledWith('we_1', 'usr_admin');
    const body = (await res.json()) as WorkspaceEvent;
    expect(body.resolved_by).toBe('usr_admin');
  });

  it('succeeds as tech_lead (200)', async () => {
    authenticateFromHeader.mockResolvedValueOnce({ userId: 'usr_lead' });
    requireRole.mockResolvedValueOnce(['tech_lead']);
    resolveMock.mockResolvedValueOnce({ ...resolved, resolved_by: 'usr_lead' });
    const res = await POST(makeReq('we_1'), { params: Promise.resolve({ eventId: 'we_1' }) });
    expect(res.status).toBe(200);
    expect(resolveMock).toHaveBeenCalledWith('we_1', 'usr_lead');
  });

  it('returns 404 when the event does not exist', async () => {
    authenticateFromHeader.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    resolveMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq('we_missing'), { params: Promise.resolve({ eventId: 'we_missing' }) });
    expect(res.status).toBe(404);
  });

  it('is idempotent — a second resolve call also returns 200', async () => {
    authenticateFromHeader.mockResolvedValue({ userId: 'usr_admin' });
    requireRole.mockResolvedValue(['admin']);
    resolveMock.mockResolvedValue(resolved);
    const r1 = await POST(makeReq('we_1'), { params: Promise.resolve({ eventId: 'we_1' }) });
    const r2 = await POST(makeReq('we_1'), { params: Promise.resolve({ eventId: 'we_1' }) });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(resolveMock).toHaveBeenCalledTimes(2);
  });
});
