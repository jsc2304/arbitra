import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { IntelligenceRun } from '@arbitra/shared';

const { requireRole, RunHistoryRepositoryMock, listMock } = vi.hoisted(() => {
  const listMock = vi.fn();
  class RunHistoryRepositoryMock {
    list = listMock;
  }
  return { requireRole: vi.fn(), RunHistoryRepositoryMock, listMock };
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

function makeReq(path = '/api/intelligence/runs'): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method: 'GET' });
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

describe('GET /api/intelligence/runs', () => {
  it('401 when unauthenticated', async () => {
    authenticate.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 401 }));
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('403 when authenticated but not admin', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_1' });
    requireRole.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { statusCode: 403 }),
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('200 + runs when admin', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    listMock.mockResolvedValueOnce({
      runs: [makeRun({ run_id: 'irun_1' }), makeRun({ run_id: 'irun_2' })],
    });

    const res = await GET(makeReq('/api/intelligence/runs?limit=10'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0].run_id).toBe('irun_1');
    expect(listMock).toHaveBeenCalledWith({ limit: 10 });
  });

  it('forwards cursor when provided', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    listMock.mockResolvedValueOnce({ runs: [] });

    await GET(makeReq('/api/intelligence/runs?limit=5&cursor=2026-04-01T00:00:00.000Z'));
    expect(listMock).toHaveBeenCalledWith({ limit: 5, cursor: '2026-04-01T00:00:00.000Z' });
  });
});
