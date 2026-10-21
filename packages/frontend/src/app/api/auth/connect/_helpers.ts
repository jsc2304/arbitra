/**
 * Shared helpers for the device-flow endpoints under
 * `/api/auth/connect/{init,token,approve,cancel}`.
 *
 * Centralizes: client-name normalization, user-code generation (RFC 8628
 * unambiguous alphabet), device-code hashing, rate-limit storage, and the
 * `verification_uri` builder.
 *
 * Pure functions only — no Firestore I/O lives here. Route handlers compose
 * these with `collections.deviceCodes()` calls directly so unit tests can
 * mock the collection without mocking helpers.
 */
import crypto from 'node:crypto';

/** RFC 8628 §6.1 unambiguous alphabet — excludes vowels (no real words) and confusable digits (0/O, 1/I). */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

/** Device-code grants live for 10 minutes per RFC 8628 §3.2. */
export const DEVICE_CODE_TTL_SECONDS = 600;

/** Default minimum poll interval — clients may poll every 5s without slow-down. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** Slow-down strike count at which we permanently deny the device. */
export const SLOW_DOWN_STRIKE_LIMIT = 3;

/** Bump applied to the poll interval on each slow-down strike. */
export const SLOW_DOWN_INTERVAL_BUMP_SECONDS = 5;

/** Sliding-window size for `/api/auth/connect/init` rate limiting. */
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** Max init requests per IP within the sliding window. */
export const RATE_LIMIT_MAX_REQUESTS = 10;
/** Doc TTL for the rate-limit collection — well beyond the window. */
export const RATE_LIMIT_DOC_TTL_MS = 60 * 60 * 1000;

/**
 * Max `/api/auth/connect/lookup` requests per authenticated user per minute.
 *
 * Generous enough for legitimate retries (a few `/connect` reloads, polling on
 * the page, etc.), restrictive enough to make brute-force enumeration of the
 * 20^8 ≈ 25.6B `user_code` keyspace impractical given the ~10-min TTL and the
 * thousands of codes that may be active at once. See spec §F.1 and PR #586.
 */
export const LOOKUP_RATE_LIMIT_MAX_REQUESTS = 30;

/** Max attempts to generate a unique `user_code` before bailing out with 503. */
export const USER_CODE_COLLISION_RETRIES = 5;

/**
 * Normalize an MCP client name into a Firestore-safe slug.
 *
 * Lowercases, trims, and replaces any non-alphanumeric run with a single `-`.
 * Examples: `Cursor` → `cursor`, `Claude Code` → `claude-code`,
 * `arbitra-mcp` → `arbitra-mcp`.
 */
export function normalizeClientName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Generate a 256-bit device_code as base64url (no padding). */
export function generateDeviceCode(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** SHA-256 hex of the raw device_code — used as the Firestore doc id. Raw code is never persisted. */
export function hashDeviceCode(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Generate an 8-character user code from the unambiguous alphabet, formatted
 * as `XXXX-XXXX`. Uses `crypto.randomInt` per character for unbiased
 * sampling across the 20-letter alphabet.
 */
export function generateUserCode(): string {
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += USER_CODE_ALPHABET[crypto.randomInt(0, USER_CODE_ALPHABET.length)];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Strict format check used by tests and validation. */
export const USER_CODE_REGEX = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

/**
 * Last-resort origin for `resolvePublicOrigin` — used only when env vars are
 * missing AND the request carries no usable host headers. A local dev origin
 * is better than crashing or returning `undefined`; real deployments set
 * `ARBITRA_PUBLIC_BASE_URL`.
 *
 * Exported for test visibility; not intended for direct use elsewhere.
 */
export const PUBLIC_ORIGIN_LOCAL_FALLBACK = 'http://localhost:3000';

/**
 * Resolve the public origin used for `verification_uri` /
 * `verification_uri_complete` (and any other place we hand the user a URL to
 * follow back to the frontend).
 *
 * Trust order — please leave this 4-tier order intact:
 *   1. `ARBITRA_PUBLIC_BASE_URL` env — set by the operator at deploy time.
 *      Static value configured by the operator, so we can trust it. Legacy
 *      `ARBITRA_PUBLIC_ORIGIN` is honored as a fallback for backward
 *      compatibility with older deploys.
 *   2. `X-Forwarded-Host` + `X-Forwarded-Proto` — set by Firebase Hosting /
 *      GFE / Cloud Run's front-end. Trusted because Cloud Run strips
 *      client-supplied `X-Forwarded-*` and replaces with its own canonical
 *      values, so they reflect the real user-facing hostname rather than the
 *      Cloud Run direct URL.
 *   3. `request.headers.host` — for direct Cloud Run access during local
 *      dev. Always assumes `https` unless the request was localhost or an
 *      explicit `X-Forwarded-Proto` told us otherwise.
 *   4. `PUBLIC_ORIGIN_LOCAL_FALLBACK` (`http://localhost:3000`) so we never
 *      return `undefined`.
 *
 * Different threat model from `resolveCallerIp`: the verification URI only
 * needs the canonical visible hostname, so trusting `X-Forwarded-Host` is
 * fine in the GFE/Firebase Hosting setup. Do NOT copy this trust assumption
 * into rate-limit IP resolution — that one must take the rightmost XFF entry.
 *
 * Trailing slashes are stripped for cleanliness.
 */
export function resolvePublicOrigin(request: Request): string {
  // Tier 1: explicit env var. New name wins over the legacy one.
  const fromEnv =
    process.env['ARBITRA_PUBLIC_BASE_URL'] ?? process.env['ARBITRA_PUBLIC_ORIGIN'];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().replace(/\/$/, '');

  // Tier 2: trusted forwarded headers from Firebase Hosting / GFE.
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedHost && forwardedHost.trim()) {
    // XFH may be a comma-list when multiple proxies are chained; the
    // left-most entry is the original (user-facing) hostname.
    const host = forwardedHost.split(',')[0]!.trim();
    const proto = forwardedProto?.split(',')[0]?.trim() || 'https';
    return `${proto}://${host}`.replace(/\/$/, '');
  }

  // Tier 3: bare request host — direct Cloud Run / local dev.
  const host = request.headers.get('host');
  if (host && host.trim()) {
    const trimmedHost = host.trim();
    const proto =
      forwardedProto?.split(',')[0]?.trim() ||
      (trimmedHost.startsWith('localhost') || trimmedHost.startsWith('127.0.0.1')
        ? 'http'
        : 'https');
    return `${proto}://${trimmedHost}`.replace(/\/$/, '');
  }

  // Tier 4: local fallback. Never return undefined.
  return PUBLIC_ORIGIN_LOCAL_FALLBACK;
}

/**
 * Extract the caller IP for rate-limit bucketing.
 *
 * Cloud Run / Google Front End appends the verified client IP as the
 * **rightmost** XFF entry. Earlier entries are forwarded as-is from the
 * client and must NOT be trusted — an attacker can prepend any value
 * (`X-Forwarded-For: 1.2.3.4, …`) to spoof a different rate-limit bucket
 * and bypass the per-IP limit on `/api/auth/connect/init`.
 *
 * See https://cloud.google.com/load-balancing/docs/https#x-forwarded-for_header
 *
 * Resolution order:
 *   1. `x-real-ip` if present (some proxies set it to the verified client IP).
 *   2. Rightmost entry of `x-forwarded-for` (the value GFE appended).
 *   3. `'local-dev'` constant so the rate limit still buckets to a single
 *      key in emulator/dev where no proxy is in front.
 */
export function resolveCallerIp(request: Request): string {
  const real = request.headers.get('x-real-ip');
  if (real) {
    const trimmed = real.trim();
    if (trimmed) return trimmed;
  }
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) {
    // Rightmost entry is the only one the client cannot forge — GFE appends
    // the real client IP after any client-supplied values.
    const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    const last = parts.at(-1);
    if (last) return last;
  }
  return 'local-dev';
}

/** SHA-256 hex of an IP, used as the rate-limit doc id (so we don't store raw IPs). */
export function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(ip).digest('hex');
}

/** SHA-256 hex of a Firebase user id — used as the doc id for per-user rate-limit buckets. */
export function hashUserId(userId: string): string {
  return crypto.createHash('sha256').update(userId).digest('hex');
}

/**
 * Per-authenticated-user sliding-window rate limiter for
 * `/api/auth/connect/lookup`.
 *
 * Trust model: the lookup endpoint is auth-required, so we bucket by
 * `auth.userId` rather than IP. The keyspace of active `user_code`s is small
 * relative to the 20^8 alphabet, and the 10-min TTL bounds an attacker's
 * window, but request throughput is still the dominant brute-force budget.
 * Capping at 30/min/user makes enumeration impractical while leaving plenty
 * of headroom for legitimate retries (page reloads, polling, multiple tabs).
 *
 * Keeps the IP-bucket logic in `init/route.ts` untouched — a sibling helper
 * with a different bucket key avoids re-entangling PR 1's contract. The
 * Firestore-doc sliding window is structurally identical (timestamp array,
 * window-trim on every check, fail-open on storage failure).
 *
 * Returns `true` if the call is allowed (and records it), `false` if
 * over-quota.
 */
export function applyAuthUserLookupRateLimit(userId: string): Promise<boolean> {
  return applyUserRateLimit(userId, {
    bucket: 'user',
    maxRequests: LOOKUP_RATE_LIMIT_MAX_REQUESTS,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
}

/**
 * The same per-user sliding window, keyed by a bucket name so independent
 * endpoints (e.g. `helper` for `/api/helper/ask`) never share a quota. The
 * lookup endpoint uses bucket `user`, which keeps its historical doc ids.
 */
export async function applyUserRateLimit(
  userId: string,
  { bucket, maxRequests, windowMs }: { bucket: string; maxRequests: number; windowMs: number },
): Promise<boolean> {
  try {
    const { collections, getDb } = await import('@arbitra/backend');
    const id = `${bucket}_${hashUserId(userId)}`;
    const ref = collections.authRateLimits().doc(id);
    // Read, trim and write in one transaction so parallel requests cannot all
    // read the same short window and overwrite each other's entries.
    return await getDb().runTransaction(async (tx) => {
      const now = Date.now();
      const windowStart = now - windowMs;
      const snap = await tx.get(ref);
      const existing = snap.exists ? snap.data() : null;
      const recent = (existing?.request_timestamps ?? []).filter((ts) => {
        const t = Date.parse(ts);
        return Number.isFinite(t) && t >= windowStart;
      });
      if (recent.length >= maxRequests) return false;

      const nowIso = new Date(now).toISOString();
      recent.push(nowIso);
      // Same `auth_rate_limits` collection as the per-IP limiter; the bucket
      // prefix keeps the doc ids disjoint from the 64-char hex IP hashes.
      tx.set(ref, {
        ip_hash: id,
        request_timestamps: recent,
        expires_at: new Date(now + Math.max(RATE_LIMIT_DOC_TTL_MS, windowMs)).toISOString(),
        created_at: existing?.created_at ?? nowIso,
        updated_at: nowIso,
      });
      return true;
    });
  } catch (err) {
    // Fail open: a broken rate limiter must not block legitimate lookups.
    console.warn(`[rate-limit:${bucket}] storage failed, allowing:`, err);
    return true;
  }
}

/**
 * Canonicalize a git remote URL into the form `host/owner/repo` for matching
 * against `repositories.github_full_name` (which is stored as `owner/repo` for
 * GitHub repos).
 *
 * Accepts:
 *   - `git@github.com:owner/repo.git`
 *   - `git@github.com:owner/repo`
 *   - `https://github.com/owner/repo`
 *   - `https://github.com/owner/repo.git`
 *   - `https://github.com/owner/repo/`
 *   - `https://www.github.com/owner/repo`
 *   - `https://gitlab.com/group/sub/repo` (subgroups, multi-segment path)
 *
 * Returns `null` if the input cannot be parsed. Lowercases host and path —
 * GitHub paths are case-insensitive but display-case-preserving. See spec §J.5.
 *
 * Tuple result:
 *   - `host` = `'github.com'` etc., lowercased
 *   - `slug` = `'owner/repo'` (or `'group/sub/repo'` for GitLab), lowercased
 */
export function canonicalizeRepoUrl(input: string): { host: string; slug: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // SSH form: git@host:path
  const sshMatch = /^[\w.-]+@([\w.-]+):(.+)$/.exec(trimmed);
  if (sshMatch) {
    const host = stripWww(sshMatch[1]!.toLowerCase());
    const slug = stripGitSuffix(stripLeadingSlash(sshMatch[2]!)).toLowerCase().replace(/\/+$/, '');
    if (!slug) return null;
    return { host, slug };
  }

  // HTTPS / HTTP / git://
  try {
    const url = new URL(trimmed.replace(/^git:\/\//, 'https://'));
    const host = stripWww(url.host.toLowerCase());
    const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    const slug = stripGitSuffix(path).toLowerCase();
    if (!slug) return null;
    return { host, slug };
  } catch {
    return null;
  }
}

function stripWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}

function stripGitSuffix(path: string): string {
  return path.endsWith('.git') ? path.slice(0, -4) : path;
}

function stripLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}
