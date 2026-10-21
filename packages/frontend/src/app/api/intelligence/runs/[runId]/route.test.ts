import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { IntelligenceRun } from '@arbitra/shared';

const { requireRole, RunHistoryRepositoryMock, getMock } = vi.hoisted(() => {
  const getMock = vi.fn();
  class RunHistoryRepositoryMock {
    get = getMock;
  }
  return { requireRole: vi.fn(), RunHistoryRepositoryMock, getMock };
});

vi.mock('@arbitra/backend', () => ({
  requireRole,
  RunHistoryRepository: RunHistoryRepositoryMock,
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

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/intelligence/runs/irun_x', { method: 'GET' });
}

function ctx(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

function makeRun(overrides: Partial<IntelligenceRun> = {}): IntelligenceRun {
  return {
    run_id: 'irun_x',
    started_at: '2026-04-20T00:00:00.000Z',
    finished_at: '2026-04-20T00:00:01.000Z',
    duration_ms: 1000,
    trigger: 'scheduler',
    detector_count: 0,
    findings_total: 0,
    summaries: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/intelligence/runs/:runId', () => {
  it('401 when unauthenticated', async () => {
    authenticate.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 401 }));
    const res = await GET(makeReq(), ctx('irun_x'));
    expect(res.status).toBe(401);
  });

  it('403 when not admin', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_1' });
    requireRole.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { statusCode: 403 }),
    );
    const res = await GET(makeReq(), ctx('irun_x'));
    expect(res.status).toBe(403);
  });

  it('404 when the run does not exist', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    getMock.mockResolvedValueOnce(undefined);

    const res = await GET(makeReq(), ctx('irun_missing'));
    expect(res.status).toBe(404);
    expect(getMock).toHaveBeenCalledWith('irun_missing');
  });

  it('200 + run when admin and run exists', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    getMock.mockResolvedValueOnce(makeRun({ run_id: 'irun_1', findings_total: 3 }));

    const res = await GET(makeReq(), ctx('irun_1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run_id).toBe('irun_1');
    expect(body.findings_total).toBe(3);
  });
});
