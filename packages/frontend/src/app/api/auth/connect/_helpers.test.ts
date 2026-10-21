/**
 * Unit tests for `resolvePublicOrigin` — the 4-tier resolution chain that
 * builds the user-facing origin returned in `verification_uri` /
 * `verification_uri_complete`.
 *
 * Trust order under test:
 *   1. ARBITRA_PUBLIC_BASE_URL env (with legacy ARBITRA_PUBLIC_ORIGIN fallback)
 *   2. X-Forwarded-Host + X-Forwarded-Proto (Firebase Hosting / GFE)
 *   3. request.headers.host (direct Cloud Run / local dev)
 *   4. Local fallback (http://localhost:3000)
 *
 * See `_helpers.ts` for the rationale comment on why X-Forwarded-Host is
 * trusted here but NOT in `resolveCallerIp`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_ORIGIN_LOCAL_FALLBACK, resolvePublicOrigin } from './_helpers';

function makeRequest(headers: Record<string, string>): Request {
  return new Request('http://internal.invalid/api/auth/connect/init', {
    method: 'POST',
    headers,
  });
}

/**
 * `new Request(...)` always sets a `host` header from the URL we pass in
 * ("internal.invalid" above). For the tier-4 hard-fallback test we need a
 * request with NO host header at all; the only way to get that is to strip
 * the getter on a plain Headers-like object.
 */
function makeRequestWithoutHost(headers: Record<string, string>): Request {
  const req = makeRequest(headers);
  // Override `headers.get` to return null for the `host` lookup while
  // leaving every other header intact.
  const original = req.headers.get.bind(req.headers);
  Object.defineProperty(req, 'headers', {
    value: {
      get: (name: string) => (name.toLowerCase() === 'host' ? null : original(name)),
    },
  });
  return req;
}

const ENV_KEYS = ['ARBITRA_PUBLIC_BASE_URL', 'ARBITRA_PUBLIC_ORIGIN'] as const;
const ENV_SNAPSHOT: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    ENV_SNAPSHOT[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ENV_SNAPSHOT[key] === undefined) delete process.env[key];
    else process.env[key] = ENV_SNAPSHOT[key];
  }
});

describe('resolvePublicOrigin — tier 1: ARBITRA_PUBLIC_BASE_URL env', () => {
  it('returns the env value when set, ignoring all headers', () => {
    process.env['ARBITRA_PUBLIC_BASE_URL'] = 'https://x.example.com';
    const req = makeRequest({
      host: 'cloudrun.example.com',
      'x-forwarded-host': 'evil.example.org',
      'x-forwarded-proto': 'http',
    });
    expect(resolvePublicOrigin(req)).toBe('https://x.example.com');
  });

  it('strips a trailing slash from the env value', () => {
    process.env['ARBITRA_PUBLIC_BASE_URL'] = 'https://arbitra.example.com/';
    expect(resolvePublicOrigin(makeRequest({}))).toBe('https://arbitra.example.com');
  });

  it('honors the legacy ARBITRA_PUBLIC_ORIGIN when the new var is unset', () => {
    process.env['ARBITRA_PUBLIC_ORIGIN'] = 'https://legacy.example.com';
    expect(resolvePublicOrigin(makeRequest({}))).toBe('https://legacy.example.com');
  });

  it('prefers the new var over the legacy one when both are set', () => {
    process.env['ARBITRA_PUBLIC_BASE_URL'] = 'https://new.example.com';
    process.env['ARBITRA_PUBLIC_ORIGIN'] = 'https://legacy.example.com';
    expect(resolvePublicOrigin(makeRequest({}))).toBe('https://new.example.com');
  });

  it('falls through when the env value is empty/whitespace', () => {
    process.env['ARBITRA_PUBLIC_BASE_URL'] = '   ';
    const req = makeRequest({ 'x-forwarded-host': 'arbitra.example.com' });
    expect(resolvePublicOrigin(req)).toBe('https://arbitra.example.com');
  });
});

describe('resolvePublicOrigin — tier 2: X-Forwarded-Host / X-Forwarded-Proto', () => {
  it('uses XFH + XFP when both are set (typical Firebase Hosting → Cloud Run)', () => {
    const req = makeRequest({
      host: 'cloudrun.example.com',
      'x-forwarded-host': 'arbitra.example.com',
      'x-forwarded-proto': 'https',
    });
    expect(resolvePublicOrigin(req)).toBe('https://arbitra.example.com');
  });

  it('defaults to https when XFH is set but XFP is missing', () => {
    const req = makeRequest({
      host: 'cloudrun.example.com',
      'x-forwarded-host': 'arbitra.example.com',
    });
    expect(resolvePublicOrigin(req)).toBe('https://arbitra.example.com');
  });

  it('takes the leftmost entry when XFH is comma-listed (chained proxies)', () => {
    const req = makeRequest({
      'x-forwarded-host': 'arbitra.example.com, internal.gfe.local',
      'x-forwarded-proto': 'https, https',
    });
    expect(resolvePublicOrigin(req)).toBe('https://arbitra.example.com');
  });
});

describe('resolvePublicOrigin — tier 3: request host header', () => {
  it('uses request.headers.host when no env or XFH (direct Cloud Run)', () => {
    const req = makeRequest({ host: 'cloudrun.example.com' });
    expect(resolvePublicOrigin(req)).toBe('https://cloudrun.example.com');
  });

  it('uses http for localhost host', () => {
    const req = makeRequest({ host: 'localhost:3000' });
    expect(resolvePublicOrigin(req)).toBe('http://localhost:3000');
  });

  it('uses http for 127.0.0.1 host', () => {
    const req = makeRequest({ host: '127.0.0.1:8080' });
    expect(resolvePublicOrigin(req)).toBe('http://127.0.0.1:8080');
  });

  it('honors X-Forwarded-Proto when XFH is missing but host is set', () => {
    const req = makeRequest({ host: 'direct.example.com', 'x-forwarded-proto': 'http' });
    expect(resolvePublicOrigin(req)).toBe('http://direct.example.com');
  });
});

describe('resolvePublicOrigin — tier 4: local fallback', () => {
  it('returns the localhost fallback when every tier is empty', () => {
    const req = makeRequestWithoutHost({});
    expect(resolvePublicOrigin(req)).toBe(PUBLIC_ORIGIN_LOCAL_FALLBACK);
    expect(PUBLIC_ORIGIN_LOCAL_FALLBACK).toBe('http://localhost:3000');
  });
});
