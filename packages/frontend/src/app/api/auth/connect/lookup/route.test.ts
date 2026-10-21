/**
 * Tests for `/api/auth/connect/lookup`.
 *
 * Covers the spec §F.1 contract: signed-in lookup returns metadata for a
 * pending device-code; any non-pending status (denied, consumed, expired) or
 * missing doc returns 404 with no information leak.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  deviceCodesQueryGet,
  rateLimitDocGet,
  rateLimitDocSet,
  authenticate,
} = vi.hoisted(() => ({
  deviceCodesQueryGet: vi.fn(),
  rateLimitDocGet: vi.fn(),
  rateLimitDocSet: vi.fn(),
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
      authRateLimits: () => ({
        doc: () => ({ get: rateLimitDocGet, set: rateLimitDocSet }),
      }),
    },
    // The limiter runs in a transaction; delegate tx reads/writes to the doc mocks.
    getDb: () => ({
      runTransaction: (fn: (tx: unknown) => unknown) =>
        fn({
          get: (ref: { get: () => unknown }) => ref.get(),
          set: (ref: { set: (d: unknown) => unknown }, data: unknown) => ref.set(data),
        }),
    }),
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

import { GET } from './route';

function makeRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/auth/connect/lookup${query}`);
}

function pendingSnap(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    user_code: 'WDJB-MJHT',
    status: 'pending',
    client_name: 'cursor',
    client_version: '0.42.3',
    device_label: 'Alexs-MacBook',
    repo_url: 'git@github.com:acme/arbitra.git',
    repo_name: 'arbitra',
    poll_interval_seconds: 5,
    slow_down_strikes: 0,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
  return {
    empty: false,
    docs: [{ data: () => data }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1', email: 'u@x' });
  rateLimitDocGet.mockResolvedValue({ exists: false, data: () => null });
  rateLimitDocSet.mockResolvedValue(undefined);
});

describe('GET /api/auth/connect/lookup', () => {
  it('returns the non-secret metadata fields for a pending code', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce(pendingSnap());
    const res = await GET(makeRequest('?user_code=WDJB-MJHT'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      client_name: 'cursor',
      client_version: '0.42.3',
      device_label: 'Alexs-MacBook',
      repo_url: 'git@github.com:acme/arbitra.git',
      repo_name: 'arbitra',
    });
    expect(json.expires_at).toEqual(expect.any(String));
    // Belt-and-braces: never leak the device_code material.
    expect(json).not.toHaveProperty('device_code');
    expect(json).not.toHaveProperty('status');
    expect(json).not.toHaveProperty('user_id');
  });

  it('returns 400 when user_code query param is missing', async () => {
    const res = await GET(makeRequest(''));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the user_code does not exist', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce({ empty: true, docs: [] });
    const res = await GET(makeRequest('?user_code=XXXX-XXXX'));
    expect(res.status).toBe(404);
  });

  it('returns 404 when the code has expired', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce(pendingSnap({
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }));
    const res = await GET(makeRequest('?user_code=WDJB-MJHT'));
    expect(res.status).toBe(404);
  });

  it('returns 404 when the code is already consumed (no metadata leak)', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce(pendingSnap({ status: 'consumed' }));
    const res = await GET(makeRequest('?user_code=WDJB-MJHT'));
    expect(res.status).toBe(404);
  });

  it('returns 404 when the code was denied', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce(pendingSnap({ status: 'denied' }));
    const res = await GET(makeRequest('?user_code=WDJB-MJHT'));
    expect(res.status).toBe(404);
  });

  it('returns 404 when the code is approved but not yet polled', async () => {
    // Approved means another tab claimed it — hide from the current request.
    deviceCodesQueryGet.mockResolvedValueOnce(pendingSnap({ status: 'approved' }));
    const res = await GET(makeRequest('?user_code=WDJB-MJHT'));
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    authenticate.mockRejectedValueOnce(Object.assign(new Error('unauth'), { statusCode: 401 }));
    const res = await GET(makeRequest('?user_code=WDJB-MJHT'));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/connect/lookup — per-user rate limit (PR #586)', () => {
  // Auth-required endpoint → bucket by userId, not IP. 30 requests/min/user
  // is generous for legitimate retries but tight enough to deny enumeration
  // of the active user_code keyspace.

  it('returns 429 once 30 requests in the window are observed for the same userId', async () => {
    const now = Date.now();
    const recent: string[] = [];
    for (let i = 0; i < 30; i++) recent.push(new Date(now - i * 500).toISOString());
    rateLimitDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ request_timestamps: recent }),
    });
    deviceCodesQueryGet.mockResolvedValueOnce(pendingSnap());

    const res = await GET(makeRequest('?user_code=WDJB-MJHT'));
    expect(res.status).toBe(429);
    // Lookup must short-circuit before the device-code query when over-quota.
    expect(deviceCodesQueryGet).not.toHaveBeenCalled();
  });

  it('the 31st request from the same userId within a minute hits 429', async () => {
    // In-memory stand-in for Firestore — records the timestamps written by
    // the helper and replays them on the next read, so the sliding window
    // grows as the test loops.
    let stored: { request_timestamps: string[] } | null = null;
    rateLimitDocGet.mockImplementation(async () => ({
      exists: stored !== null,
      data: () => stored,
    }));
    rateLimitDocSet.mockImplementation(async (payload: { request_timestamps: string[] }) => {
      stored = { request_timestamps: payload.request_timestamps };
    });
    deviceCodesQueryGet.mockImplementation(async () => pendingSnap());

    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await GET(makeRequest('?user_code=WDJB-MJHT'));
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('different userIds do not share the bucket', async () => {
    // The helper uses `user_${sha256(userId)}` as the Firestore doc id, so
    // user_alpha and user_beta resolve to distinct buckets. Assert directly
    // via `hashUserId` (the same function the helper uses) — keeps this test
    // independent of the @arbitra/backend mock shape.
    const { hashUserId } = await import('../_helpers');
    const idAlpha = `user_${hashUserId('user_alpha')}`;
    const idBeta = `user_${hashUserId('user_beta')}`;
    expect(idAlpha).not.toBe(idBeta);
    expect(idAlpha).toMatch(/^user_[0-9a-f]{64}$/);
    expect(idBeta).toMatch(/^user_[0-9a-f]{64}$/);

    // Sanity check: user_alpha being over-quota does not affect user_beta.
    // We simulate by saturating one bucket and confirming a second userId
    // still passes. The doc() mock above is keyed per-call, so we instead
    // saturate the shared mock for the first request and reset for the
    // second — verifying the helper re-reads on each call rather than
    // caching across users.
    const now = Date.now();
    const saturated: string[] = [];
    for (let i = 0; i < 30; i++) saturated.push(new Date(now - i * 500).toISOString());

    deviceCodesQueryGet.mockResolvedValue(pendingSnap());
    rateLimitDocGet.mockResolvedValueOnce({ exists: true, data: () => ({ request_timestamps: saturated }) });
    authenticate.mockResolvedValueOnce({ userId: 'user_alpha', email: 'a@x' });
    const overQuota = await GET(makeRequest('?user_code=WDJB-MJHT'));
    expect(overQuota.status).toBe(429);

    rateLimitDocGet.mockResolvedValueOnce({ exists: false, data: () => null });
    authenticate.mockResolvedValueOnce({ userId: 'user_beta', email: 'b@x' });
    const fresh = await GET(makeRequest('?user_code=WDJB-MJHT'));
    expect(fresh.status).toBe(200);
  });

  it('fails open if the rate-limit storage throws (legitimate lookups must not be blocked by a broken limiter)', async () => {
    rateLimitDocGet.mockRejectedValueOnce(new Error('firestore down'));
    deviceCodesQueryGet.mockResolvedValueOnce(pendingSnap());

    const res = await GET(makeRequest('?user_code=WDJB-MJHT'));
    expect(res.status).toBe(200);
  });
});
