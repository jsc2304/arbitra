import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { requireRole, DetectorConfigRepositoryMock, setEnabledMock } = vi.hoisted(() => {
  const setEnabledMock = vi.fn();
  class DetectorConfigRepositoryMock {
    setEnabled = setEnabledMock;
  }
  return { requireRole: vi.fn(), DetectorConfigRepositoryMock, setEnabledMock };
});

vi.mock('@arbitra/backend', () => ({
  requireRole,
  DetectorConfigRepository: DetectorConfigRepositoryMock,
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

import { PATCH } from './route';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/intelligence/detectors/det-a', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function ctx(detectorId: string) {
  return { params: Promise.resolve({ detectorId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PATCH /api/intelligence/detectors/:detectorId', () => {
  it('401 when unauthenticated', async () => {
    authenticate.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 401 }));
    const res = await PATCH(makeReq({ enabled: false }), ctx('det-a'));
    expect(res.status).toBe(401);
    expect(setEnabledMock).not.toHaveBeenCalled();
  });

  it('403 when not admin', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_1' });
    requireRole.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { statusCode: 403 }),
    );
    const res = await PATCH(makeReq({ enabled: false }), ctx('det-a'));
    expect(res.status).toBe(403);
    expect(setEnabledMock).not.toHaveBeenCalled();
  });

  it('400 when body is missing or malformed', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);

    const res = await PATCH(makeReq({}), ctx('det-a'));
    expect(res.status).toBe(400);
    expect(setEnabledMock).not.toHaveBeenCalled();
  });

  it('200 + calls setEnabled with auth.userId', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    setEnabledMock.mockResolvedValueOnce({
      enabled: false,
      updated_at: '2026-04-23T00:00:00.000Z',
      updated_by: 'usr_admin',
    });

    const res = await PATCH(makeReq({ enabled: false }), ctx('det-a'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detector_id).toBe('det-a');
    expect(body.config.enabled).toBe(false);
    expect(body.config.updated_by).toBe('usr_admin');
    expect(setEnabledMock).toHaveBeenCalledWith('det-a', false, 'usr_admin');
  });
});
