/**
 * Tests for `/api/auth/connect/cancel`. Auth required; idempotent on
 * already-denied; 409 on consumed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  deviceCodesQueryGet,
  deviceCodesUpdate,
  authenticate,
} = vi.hoisted(() => ({
  deviceCodesQueryGet: vi.fn(),
  deviceCodesUpdate: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock('@arbitra/backend', () => {
  const queryChain = () => {
    const obj: Record<string, unknown> = {
      where: () => obj,
      limit: () => obj,
      get: deviceCodesQueryGet,
    };
    return obj;
  };
  return {
    collections: {
      deviceCodes: () => queryChain(),
    },
    formatError: (error: unknown) => ({
      status: 500,
      body: { error: { message: error instanceof Error ? error.message : 'error' } },
    }),
  };
});

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

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/auth/connect/cancel', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function snap(status: string) {
  return {
    empty: false,
    docs: [{
      ref: { update: deviceCodesUpdate },
      data: () => ({
        user_code: 'WDJB-MJHT',
        status,
        client_name: 'cursor',
        device_label: 'Alexs-MacBook',
        poll_interval_seconds: 5,
        slow_down_strikes: 0,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        created_at: new Date().toISOString(),
      }),
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1', email: 'u@x' });
  deviceCodesUpdate.mockResolvedValue(undefined);
});

describe('POST /api/auth/connect/cancel', () => {
  it('flips a pending code to denied', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce(snap('pending'));
    const res = await POST(makeRequest({ user_code: 'WDJB-MJHT' }));
    expect(res.status).toBe(200);
    expect(deviceCodesUpdate).toHaveBeenCalledWith({ status: 'denied' });
  });

  it('is idempotent on an already-denied code', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce(snap('denied'));
    const res = await POST(makeRequest({ user_code: 'WDJB-MJHT' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cancelled).toBe(true);
    expect(deviceCodesUpdate).not.toHaveBeenCalled();
  });

  it('returns 409 when the code was already consumed', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce(snap('consumed'));
    const res = await POST(makeRequest({ user_code: 'WDJB-MJHT' }));
    expect(res.status).toBe(409);
    expect(deviceCodesUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 when the user_code is unknown', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce({ empty: true, docs: [] });
    const res = await POST(makeRequest({ user_code: 'XXXX-YYYY' }));
    expect(res.status).toBe(404);
  });

  it('rejects missing user_code with 400', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });
});
