/**
 * POST /api/auth/connect/init — RFC 8628 §3.1 device authorization request.
 *
 * Public endpoint. Rate-limited per-IP (sliding window of
 * 10 req/min). Returns a `device_code` (32 random bytes, base64url) and a
 * human-friendly `user_code` (`XXXX-XXXX` from the unambiguous alphabet).
 *
 * The raw `device_code` is **never** persisted — we store only its sha256 as
 * the Firestore doc id. The polling endpoint re-hashes the incoming
 * `device_code` to look up the doc.
 *
 * See `docs/specs/device-flow-and-per-tool-tokens.md` §B.1.
 */
import { NextRequest, NextResponse } from 'next/server';
import { handleError } from '@/lib/api-helpers';
import type { DeviceCode } from '@arbitra/shared';
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  RATE_LIMIT_DOC_TTL_MS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  USER_CODE_COLLISION_RETRIES,
  canonicalizeRepoUrl,
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  hashIp,
  normalizeClientName,
  resolveCallerIp,
  resolvePublicOrigin,
} from '../_helpers';

export const dynamic = 'force-dynamic';

interface InitBody {
  client_name?: string;
  client_version?: string;
  device_label?: string;
  device_id?: string;
  repo_url?: string;
  repo_name?: string;
}

/**
 * Defensive length caps on the public init payload. These prevent storage
 * abuse (unbounded strings would otherwise be written to Firestore on every
 * unauthenticated call) and bound any downstream UI rendering. Sized to
 * comfortably fit realistic values without truncation.
 */
const INIT_FIELD_MAX_LENGTHS = {
  client_name: 64,
  client_version: 64,
  device_label: 128,
  device_id: 64,
  repo_url: 512,
  repo_name: 256,
} as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as InitBody;

    const rawClientName = body.client_name;
    if (!rawClientName || typeof rawClientName !== 'string' || !rawClientName.trim()) {
      return NextResponse.json(
        { error: 'invalid_request', error_description: 'client_name is required' },
        { status: 400 },
      );
    }

    // Enforce per-field length caps before any normalization or Firestore I/O.
    for (const [key, max] of Object.entries(INIT_FIELD_MAX_LENGTHS) as Array<[keyof InitBody, number]>) {
      const value = body[key];
      if (typeof value === 'string' && value.length > max) {
        return NextResponse.json(
          { error: 'invalid_request', error_description: `${key} must be ${max} characters or fewer` },
          { status: 400 },
        );
      }
    }

    const clientName = normalizeClientName(rawClientName);
    if (!clientName) {
      return NextResponse.json(
        { error: 'invalid_request', error_description: 'client_name must contain at least one alphanumeric character' },
        { status: 400 },
      );
    }

    const ip = resolveCallerIp(request);

    // Rate limit before doing any Firestore writes for the device code.
    const allowed = await checkRateLimit(ip);
    if (!allowed) {
      return NextResponse.json(
        { error: 'too_many_requests', error_description: 'Rate limit exceeded — try again in a minute' },
        { status: 429 },
      );
    }

    // Generate a device_code + user_code, retrying on user_code collisions.
    // We compute the device_code hash once and use it as the doc id; collisions
    // there are negligible (256-bit random), so we only loop on user_code.
    const { collections } = await import('@arbitra/backend');

    let userCode: string | null = null;
    for (let attempt = 0; attempt < USER_CODE_COLLISION_RETRIES; attempt++) {
      const candidate = generateUserCode();
      const snap = await collections.deviceCodes()
        .where('user_code', '==', candidate)
        .where('status', 'in', ['pending', 'approved'])
        .limit(1)
        .get();
      if (snap.empty) {
        userCode = candidate;
        break;
      }
    }
    if (userCode === null) {
      // Exhausted all retries — the chance of this with a 20^8 ≈ 26B keyspace
      // and short TTL is effectively zero. If we hit it, signal upstream
      // server pressure rather than silently retry forever.
      return NextResponse.json(
        { error: 'server_error', error_description: 'Failed to allocate a unique user_code' },
        { status: 503 },
      );
    }

    const deviceCode = generateDeviceCode();
    const docId = hashDeviceCode(deviceCode);

    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000).toISOString();

    // Build the persisted doc. Optional fields with `undefined` are dropped by
    // Firestore's `ignoreUndefinedProperties` setting (see lib/firestore.ts).
    const doc: DeviceCode = {
      user_code: userCode,
      status: 'pending',
      client_name: clientName,
      client_version: body.client_version?.trim() || undefined,
      device_label: body.device_label?.trim() || 'Unknown device',
      device_id: body.device_id?.trim() || undefined,
      repo_url: body.repo_url?.trim() || undefined,
      repo_name: body.repo_name?.trim() || undefined,
      poll_interval_seconds: DEFAULT_POLL_INTERVAL_SECONDS,
      slow_down_strikes: 0,
      expires_at: expiresAt,
      created_at: createdAt,
    };

    await collections.deviceCodes().doc(docId).set(doc);

    // Canonicalize repo_url at write time as a future optimization hook —
    // we don't store it yet (the match endpoint canonicalizes both sides),
    // but the value is useful when we backfill `canonical_repo_slug`.
    // For now: best-effort log only.
    if (doc.repo_url) {
      canonicalizeRepoUrl(doc.repo_url);
    }

    const origin = resolvePublicOrigin(request);

    return NextResponse.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${origin}/connect`,
      verification_uri_complete: `${origin}/connect?code=${userCode}`,
      expires_in: DEVICE_CODE_TTL_SECONDS,
      interval: DEFAULT_POLL_INTERVAL_SECONDS,
    });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Sliding-window rate limiter backed by Firestore. Stores per-IP-hash docs
 * with an array of request timestamps; trims the array to the current window
 * on every check.
 *
 * Returns `true` if the call is allowed (and records it), `false` if
 * over-quota. A Firestore failure also returns `true` — better to under-limit
 * during an outage than to lock everyone out of authentication.
 */
async function checkRateLimit(ip: string): Promise<boolean> {
  try {
    const { collections } = await import('@arbitra/backend');
    const id = hashIp(ip);
    const ref = collections.authRateLimits().doc(id);
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;

    // Single read+conditional write — the window is short (1m) and contention
    // per IP is bounded by the 10/min cap, so a non-transactional read is
    // acceptable here. Migrate to a transaction if abuse shows up.
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() : null;
    const previous = existing?.request_timestamps ?? [];
    // Drop timestamps outside the window in a single pass.
    const recent: string[] = [];
    for (const ts of previous) {
      const t = Date.parse(ts);
      if (Number.isFinite(t) && t >= windowStart) recent.push(ts);
    }
    if (recent.length >= RATE_LIMIT_MAX_REQUESTS) return false;

    const nowIso = new Date(now).toISOString();
    recent.push(nowIso);
    await ref.set({
      ip_hash: id,
      request_timestamps: recent,
      expires_at: new Date(now + RATE_LIMIT_DOC_TTL_MS).toISOString(),
      created_at: existing?.created_at ?? nowIso,
      updated_at: nowIso,
    });
    return true;
  } catch (err) {
    // Fail open: a broken rate limiter must not block legitimate authentication.
    console.warn('[auth/connect/init] rate-limit storage failed, allowing:', err);
    return true;
  }
}
