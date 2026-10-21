import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { WorkspaceEvent } from '@arbitra/shared';

// The route does `new WorkspaceEventService()` at module scope, so we have
// to intercept the constructor and expose a shared `get` spy the tests can
// program per-case.
const { authenticateFromHeader, WorkspaceEventService, getMock } = vi.hoisted(() => {
  const getMock = vi.fn();
  class MockService {
    get = getMock;
  }
  return {
    authenticateFromHeader: vi.fn(),
    WorkspaceEventService: MockService,
    getMock,
  };
});

vi.mock('@arbitra/backend', () => ({
  WorkspaceEventService,
  authenticateFromHeader,
  formatError: (error: unknown) => ({
    status: error instanceof Error && error.message === 'unauthorized' ? 401 : 500,
    body: {
      error: {
        code: 'INTERNAL',
        message: error instanceof Error ? error.message : 'error',
      },
    },
  }),
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown) => schema.parse(body),
}));

import { GET } from './route';

function makeReq(eventId: string, auth: string | null = 'Bearer test-token'): NextRequest {
  return new NextRequest(`http://localhost/api/workspace-events/${eventId}`, {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  });
}

const sampleEvent: WorkspaceEvent = {
  event_id: 'workspaceEvent_123',
  type: 'intelligence_run',
  actor_user_id: 'system:arbitra-intelligence',
  timestamp: '2026-04-20T10:00:00.000Z',
  summary: 'Ran 2 detectors',
  evidence: { detectors: [], duration_ms: 120 },
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticateFromHeader.mockResolvedValue({ userId: 'user_1' });
  getMock.mockReset();
});

describe('GET /api/workspace-events/:eventId', () => {
  it('rejects unauthenticated callers', async () => {
    authenticateFromHeader.mockRejectedValueOnce(new Error('unauthorized'));
    const res = await GET(makeReq('workspaceEvent_123'), {
      params: Promise.resolve({ eventId: 'workspaceEvent_123' }),
    });
    // `handleError` forwards through our mocked `formatError`; unauthorized
    // errors map to 401 so the frontend can distinguish from 500s.
    expect(res.status).toBe(401);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the event does not exist', async () => {
    getMock.mockResolvedValueOnce(null);
    const res = await GET(makeReq('workspaceEvent_missing'), {
      params: Promise.resolve({ eventId: 'workspaceEvent_missing' }),
    });
    expect(res.status).toBe(404);
    expect(getMock).toHaveBeenCalledWith('workspaceEvent_missing');
  });

  it('returns 200 with the event body on hit', async () => {
    getMock.mockResolvedValueOnce(sampleEvent);
    const res = await GET(makeReq('workspaceEvent_123'), {
      params: Promise.resolve({ eventId: 'workspaceEvent_123' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceEvent;
    expect(body).toEqual(sampleEvent);
    expect(getMock).toHaveBeenCalledWith('workspaceEvent_123');
  });
});
