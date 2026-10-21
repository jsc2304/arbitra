/**
 * Tests for `/api/auth/connect/init`.
 *
 * The route writes to two Firestore collections: `device_codes` and
 * `auth_rate_limits`. We mock both via `@arbitra/backend` and verify the
 * happy path + the explicit guard branches called out in
 * `docs/specs/device-flow-and-per-tool-tokens.md` §I.1.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  deviceCodesDocSet,
  deviceCodesQueryGet,
  rateLimitDocGet,
  rateLimitDocSet,
} = vi.hoisted(() => ({
  deviceCodesDocSet: vi.fn(),
  deviceCodesQueryGet: vi.fn(),
  rateLimitDocGet: vi.fn(),
  rateLimitDocSet: vi.fn(),
}));

vi.mock('@arbitra/backend', () => {
  // Build a chainable query builder that always lands on `get()`.
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
      deviceCodes: () => ({
        ...queryChain(),
        doc: () => ({ set: deviceCodesDocSet }),
      }),
      authRateLimits: () => ({
        doc: () => ({ get: rateLimitDocGet, set: rateLimitDocSet }),
      }),
    },
    formatError: (error: unknown) => ({
      status: 500,
      body: { error: { message: error instanceof Error ? error.message : 'error' } },
    }),
  };
});

import { POST } from './route';
import { USER_CODE_REGEX, normalizeClientName, resolveCallerIp } from '../_helpers';

function makeRequest(body: Record<string, unknown>, ip = '203.0.113.10'): NextRequest {
  return new NextRequest('http://localhost/api/auth/connect/init', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  });
}

function makeRequestRaw(headers: Record<string, string>, body: Record<string, unknown> = { client_name: 'cursor' }): NextRequest {
  return new NextRequest('http://localhost/api/auth/connect/init', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deviceCodesQueryGet.mockResolvedValue({ empty: true, docs: [] });
  deviceCodesDocSet.mockResolvedValue(undefined);
  rateLimitDocGet.mockResolvedValue({ exists: false, data: () => null });
  rateLimitDocSet.mockResolvedValue(undefined);
});

describe('POST /api/auth/connect/init — happy path', () => {
  it('returns RFC 8628 §3.2 payload with valid user_code and writes a pending doc', async () => {
    const res = await POST(makeRequest({ client_name: 'cursor', client_version: '0.42.3', device_label: 'Alexs-MacBook' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.device_code).toBe('string');
    expect(json.device_code.length).toBeGreaterThan(20);
    expect(json.user_code).toMatch(USER_CODE_REGEX);
    expect(json.verification_uri).toMatch(/\/connect$/);
    expect(json.verification_uri_complete).toContain(`?code=${json.user_code}`);
    expect(json.expires_in).toBe(600);
    expect(json.interval).toBe(5);
    expect(deviceCodesDocSet).toHaveBeenCalledOnce();
    const written = deviceCodesDocSet.mock.calls[0]![0];
    expect(written.status).toBe('pending');
    expect(written.client_name).toBe('cursor');
    expect(written.device_label).toBe('Alexs-MacBook');
  });

  it('normalizes client_name (Cursor → cursor)', async () => {
    const res = await POST(makeRequest({ client_name: 'Cursor' }));
    expect(res.status).toBe(200);
    const written = deviceCodesDocSet.mock.calls[0]![0];
    expect(written.client_name).toBe('cursor');
  });

  it('normalizes multi-word client_name (Claude Code → claude-code)', () => {
    expect(normalizeClientName('Claude Code')).toBe('claude-code');
    expect(normalizeClientName('  arbitra_mcp.cli  ')).toBe('arbitra-mcp-cli');
  });

  it('defaults device_label to "Unknown device" when missing', async () => {
    const res = await POST(makeRequest({ client_name: 'cursor' }));
    expect(res.status).toBe(200);
    const written = deviceCodesDocSet.mock.calls[0]![0];
    expect(written.device_label).toBe('Unknown device');
  });
});

describe('POST /api/auth/connect/init — validation', () => {
  it('rejects missing client_name with 400 invalid_request', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
    expect(deviceCodesDocSet).not.toHaveBeenCalled();
  });

  it('rejects empty-string client_name', async () => {
    const res = await POST(makeRequest({ client_name: '   ' }));
    expect(res.status).toBe(400);
  });

  it('rejects client_name that normalizes to empty', async () => {
    const res = await POST(makeRequest({ client_name: '!!!' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
  });
});

describe('POST /api/auth/connect/init — rate limit', () => {
  it('returns 429 once 10 requests in the window are observed', async () => {
    const now = Date.now();
    const recent: string[] = [];
    for (let i = 0; i < 10; i++) recent.push(new Date(now - i * 1000).toISOString());
    rateLimitDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ request_timestamps: recent }),
    });

    const res = await POST(makeRequest({ client_name: 'cursor' }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe('too_many_requests');
    expect(deviceCodesDocSet).not.toHaveBeenCalled();
  });

  it('drops timestamps outside the window before applying the limit', async () => {
    const now = Date.now();
    // 10 stale timestamps from 2 minutes ago — should all be dropped.
    const stale: string[] = [];
    for (let i = 0; i < 10; i++) stale.push(new Date(now - 120_000 - i * 1000).toISOString());
    rateLimitDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ request_timestamps: stale }),
    });

    const res = await POST(makeRequest({ client_name: 'cursor' }));
    expect(res.status).toBe(200);
    expect(deviceCodesDocSet).toHaveBeenCalledOnce();
  });
});

describe('POST /api/auth/connect/init — user_code collisions', () => {
  it('returns 503 server_error when the alphabet is exhausted', async () => {
    // Force every collision-check to report a duplicate. The route gives up
    // after USER_CODE_COLLISION_RETRIES attempts.
    deviceCodesQueryGet.mockResolvedValue({
      empty: false,
      docs: [{ data: () => ({ user_code: 'EXAMPLE-CODE' }) }],
    });

    const res = await POST(makeRequest({ client_name: 'cursor' }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('server_error');
    expect(deviceCodesDocSet).not.toHaveBeenCalled();
  });

  it('retries on a collision and succeeds on the next attempt', async () => {
    // First check finds a collision, second is clear.
    deviceCodesQueryGet
      .mockResolvedValueOnce({ empty: false, docs: [{ data: () => ({ user_code: 'X' }) }] })
      .mockResolvedValueOnce({ empty: true, docs: [] });

    const res = await POST(makeRequest({ client_name: 'cursor' }));
    expect(res.status).toBe(200);
    expect(deviceCodesQueryGet).toHaveBeenCalledTimes(2);
    expect(deviceCodesDocSet).toHaveBeenCalledOnce();
  });
});

describe('POST /api/auth/connect/init — user_code format', () => {
  it('produces only characters from the unambiguous alphabet', async () => {
    for (let i = 0; i < 50; i++) {
      const res = await POST(makeRequest({ client_name: 'cursor' }));
      const json = await res.json();
      expect(json.user_code).toMatch(USER_CODE_REGEX);
      // Explicitly no vowels (the alphabet excludes them).
      expect(json.user_code).not.toMatch(/[AEIOU]/);
      // And no confusable digits.
      expect(json.user_code).not.toMatch(/[0-9]/);
    }
  });
});

describe('POST /api/auth/connect/init — XFF rate-limit bucketing (review-finding #1)', () => {
  // Cloud Run / Google Front End appends the verified client IP as the
  // rightmost XFF entry. Earlier entries are client-controlled — taking the
  // leftmost (the previous behavior) lets an attacker spoof a different
  // rate-limit bucket on every request and bypass the per-IP cap entirely.

  it('resolveCallerIp returns the rightmost XFF entry, not the leftmost', () => {
    const req = makeRequestRaw({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' });
    expect(resolveCallerIp(req)).toBe('3.3.3.3');
  });

  it('resolveCallerIp prefers x-real-ip when present', () => {
    const req = makeRequestRaw({ 'x-real-ip': '4.4.4.4', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' });
    expect(resolveCallerIp(req)).toBe('4.4.4.4');
  });

  it('spoofed leftmost XFF cannot bypass the rate limit (all attacker requests bucket together)', async () => {
    // Attacker varies the leftmost XFF on every request, but the same Cloud
    // Run instance appends the same verified client IP as the rightmost
    // entry. All 11 requests must land in the same bucket → 11th hits 429.
    //
    // We simulate the rate-limit doc's growth by capturing each `set` call
    // and replaying it on the next `get` — i.e. a tiny in-memory stand-in
    // for Firestore that records the timestamps written by the route.
    let stored: { request_timestamps: string[] } | null = null;
    rateLimitDocGet.mockImplementation(async () => ({
      exists: stored !== null,
      data: () => stored,
    }));
    rateLimitDocSet.mockImplementation(async (payload: { request_timestamps: string[] }) => {
      stored = { request_timestamps: payload.request_timestamps };
    });

    const xffWithSpoof = (n: number) => `${n}.${n}.${n}.${n}, 9.9.9.9`;

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await POST(makeRequestRaw({ 'x-forwarded-for': xffWithSpoof(i) }));
      statuses.push(res.status);
    }

    // First 10 succeed, 11th hits the limit — proving the bucket key is
    // tied to the rightmost (real) IP `9.9.9.9`, not the spoofed leftmost.
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('POST /api/auth/connect/init — input length caps (review-finding #4)', () => {
  it('rejects an over-long device_label with 400 invalid_request', async () => {
    const res = await POST(makeRequest({
      client_name: 'cursor',
      device_label: 'x'.repeat(129),
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
    expect(json.error_description).toMatch(/device_label/);
    expect(deviceCodesDocSet).not.toHaveBeenCalled();
  });

  it('rejects an over-long repo_url with 400 invalid_request', async () => {
    const res = await POST(makeRequest({
      client_name: 'cursor',
      repo_url: 'https://example.com/' + 'x'.repeat(513),
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error_description).toMatch(/repo_url/);
  });

  it('accepts values at the cap boundary', async () => {
    const res = await POST(makeRequest({
      client_name: 'c'.repeat(64), // client_name cap is 64
      device_label: 'd'.repeat(128),
      device_id: 'e'.repeat(64),
    }));
    expect(res.status).toBe(200);
  });
});
