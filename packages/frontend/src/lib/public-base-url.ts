import type { NextRequest } from 'next/server';
import { caseShareUrl } from '@arbitra/shared';
import type { CaseStatus } from '@arbitra/shared';

/**
 * Resolve the public base URL of this Arbitra deployment.
 *
 * Priority (matches the existing pattern in
 * `packages/frontend/src/app/api/init/[...path]/route.ts`):
 *
 *   1. `ARBITRA_PUBLIC_BASE_URL`, `ARBITRA_URL` or `NEXT_PUBLIC_APP_URL` if set.
 *   2. `x-forwarded-proto` + `x-forwarded-host` headers — the proxy chain
 *      preserves the public hostname even when the app sees an internal
 *      one.
 *   3. `host` header as a last resort, defaulting to `http://` for
 *      localhost and `https://` otherwise.
 *
 * Returns `null` when nothing usable is available (callers should then
 * skip emitting URLs rather than fabricate a guess).
 *
 * The hostname is sanity-checked the same way the init route does it so we
 * don't echo back arbitrary header values.
 */
/** localhost, 127.0.0.1 or [::1], with or without a port. */
export function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

export function getPublicBaseUrl(request: NextRequest): string | null {
  const envUrl =
    process.env['ARBITRA_PUBLIC_BASE_URL'] ?? process.env['ARBITRA_URL'] ?? process.env['NEXT_PUBLIC_APP_URL'];
  if (envUrl) {
    return envUrl.replace(/\/+$/, '');
  }

  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
  if (!host) return null;
  const proto = request.headers.get('x-forwarded-proto') ?? (isLocalHost(host) ? 'http' : 'https');

  const derived = `${proto}://${host}`;
  try {
    const parsed = new URL(derived);
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      /^[a-zA-Z0-9._:-]+$/.test(parsed.host)
    ) {
      return `${parsed.protocol}//${parsed.host}`;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Build a status-aware share URL for the given case using the public base URL
 * derived from the incoming request. Returns `null` when no base URL can be
 * resolved — callers should then omit `share_url` rather than emit a broken
 * link.
 */
export function resolveCaseShareUrl(
  request: NextRequest,
  caseId: string,
  status: CaseStatus,
): string | null {
  const baseUrl = getPublicBaseUrl(request);
  if (!baseUrl) return null;
  return caseShareUrl({ baseUrl, caseId, status });
}
