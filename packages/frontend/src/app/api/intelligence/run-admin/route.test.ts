import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  requireRole,
  IntelligenceServiceMock,
  runForAdminMock,
  LockHeldErrorMock,
  ALL_DETECTORS,
} = vi.hoisted(() => {
  const runForAdminMock = vi.fn();
  class IntelligenceServiceMock {
    runForAdmin = runForAdminMock;
  }
  class LockHeldErrorMock extends Error {
    readonly code = 'LOCK_HELD';
    constructor(message = 'intelligence_run_in_progress') {
      super(message);
      this.name = 'IntelligenceLockHeldError';
    }
  }
  return {
    requireRole: vi.fn(),
    IntelligenceServiceMock,
    runForAdminMock,
    LockHeldErrorMock,
    ALL_DETECTORS: [],
  };
});

vi.mock('@arbitra/backend', () => ({
  requireRole,
  IntelligenceService: IntelligenceServiceMock,
  IntelligenceLockHeldError: LockHeldErrorMock,
  ALL_DETECTORS,
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

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/intelligence/run-admin', { method: 'POST' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/intelligence/run-admin', () => {
  it('401 when unauthenticated', async () => {
    authenticate.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 401 }));
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(runForAdminMock).not.toHaveBeenCalled();
  });

  it('403 when not admin', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_1' });
    requireRole.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { statusCode: 403 }),
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
    expect(runForAdminMock).not.toHaveBeenCalled();
  });

  it('409 when the lock is held', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    runForAdminMock.mockRejectedValueOnce(new LockHeldErrorMock());

    const res = await POST(makeReq());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: 'intelligence_run_in_progress' });
  });

  it('200 + IntelligenceRun when admin', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    runForAdminMock.mockResolvedValueOnce({
      run_id: 'irun_1',
      started_at: '2026-04-23T00:00:00.000Z',
      finished_at: '2026-04-23T00:00:01.000Z',
      duration_ms: 1000,
      trigger: 'manual',
      triggered_by: 'usr_admin',
      detector_count: 0,
      findings_total: 0,
      summaries: [],
    });

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run_id).toBe('irun_1');
    expect(body.trigger).toBe('manual');
    expect(body.triggered_by).toBe('usr_admin');
    expect(runForAdminMock).toHaveBeenCalledWith({
      trigger: 'manual',
      triggered_by: 'usr_admin',
    });
  });
});
