import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  requireRole,
  DetectorConfigRepositoryMock,
  RunHistoryRepositoryMock,
  getAllMock,
  listMock,
  ALL_DETECTORS,
} = vi.hoisted(() => {
  const getAllMock = vi.fn();
  const listMock = vi.fn();
  class DetectorConfigRepositoryMock {
    getAll = getAllMock;
  }
  class RunHistoryRepositoryMock {
    list = listMock;
  }
  const ALL_DETECTORS = [
    { id: 'det-a', name: 'Detector A', description: 'watches A', run: vi.fn() },
    { id: 'det-b', name: 'Detector B', description: 'watches B', run: vi.fn() },
  ];
  return {
    requireRole: vi.fn(),
    DetectorConfigRepositoryMock,
    RunHistoryRepositoryMock,
    getAllMock,
    listMock,
    ALL_DETECTORS,
  };
});

vi.mock('@arbitra/backend', () => ({
  requireRole,
  DetectorConfigRepository: DetectorConfigRepositoryMock,
  RunHistoryRepository: RunHistoryRepositoryMock,
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

import { GET } from './route';

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/intelligence/detectors', { method: 'GET' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/intelligence/detectors', () => {
  it('401 when unauthenticated', async () => {
    authenticate.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 401 }));
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('403 when not admin', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_1' });
    requireRole.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { statusCode: 403 }),
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
  });

  it('200 + merges config + last_run with ALL_DETECTORS', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    getAllMock.mockResolvedValueOnce({ 'det-a': { enabled: false, updated_by: 'usr_admin' } });
    listMock.mockResolvedValueOnce({
      runs: [
        {
          run_id: 'irun_latest',
          started_at: '2026-04-22T00:00:00.000Z',
          finished_at: '2026-04-22T00:00:01.000Z',
          duration_ms: 1000,
          trigger: 'scheduler',
          detector_count: 2,
          findings_total: 3,
          summaries: [
            { detector_id: 'det-a', enabled: false, finding_count: 0, duration_ms: 0 },
            { detector_id: 'det-b', enabled: true, finding_count: 3, duration_ms: 120 },
          ],
        },
      ],
    });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detectors).toHaveLength(2);

    const a = body.detectors.find((d: { detector_id: string }) => d.detector_id === 'det-a');
    const b = body.detectors.find((d: { detector_id: string }) => d.detector_id === 'det-b');
    expect(a.name).toBe('Detector A');
    expect(a.config.enabled).toBe(false);
    expect(a.last_run).toEqual({
      started_at: '2026-04-22T00:00:00.000Z',
      finding_count: 0,
    });
    // det-b isn't in config — default-enabled.
    expect(b.config.enabled).toBe(true);
    expect(b.last_run.finding_count).toBe(3);
  });

  it('surfaces the full per-detector error message on last_run when the latest run failed', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    getAllMock.mockResolvedValueOnce({});
    const errorMessage =
      '9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/project/demo-arbitra/firestore/indexes?create_composite=TOKEN';
    listMock.mockResolvedValueOnce({
      runs: [
        {
          run_id: 'irun_failed',
          started_at: '2026-04-22T00:00:00.000Z',
          finished_at: '2026-04-22T00:00:01.000Z',
          duration_ms: 1000,
          trigger: 'scheduler',
          detector_count: 2,
          findings_total: 0,
          summaries: [
            { detector_id: 'det-a', enabled: true, finding_count: 0, duration_ms: 5, error: errorMessage },
            { detector_id: 'det-b', enabled: true, finding_count: 0, duration_ms: 5 },
          ],
        },
      ],
    });

    const res = await GET(makeReq());
    const body = await res.json();
    const a = body.detectors.find((d: { detector_id: string }) => d.detector_id === 'det-a');
    const b = body.detectors.find((d: { detector_id: string }) => d.detector_id === 'det-b');
    expect(a.last_run.error).toBe(errorMessage);
    expect(b.last_run.error).toBeUndefined();
  });

  it('omits last_run when no runs have been persisted yet', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    getAllMock.mockResolvedValueOnce({});
    listMock.mockResolvedValueOnce({ runs: [] });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const d of body.detectors) {
      expect(d.last_run).toBeUndefined();
      expect(d.config.enabled).toBe(true);
    }
  });
});
