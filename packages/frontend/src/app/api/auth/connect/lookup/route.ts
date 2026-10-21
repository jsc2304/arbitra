/**
 * GET /api/auth/connect/lookup?user_code=WDJB-MJHT — fetch device-code metadata
 * for the `/connect` page.
 *
 * Auth: Firebase ID token required. The `/connect` page calls this once it has
 * a signed-in user + a code from the URL, so it can render the Tool / Device /
 * Project rows the spec describes (`§F.1`).
 *
 * Returns a non-secret subset of the device-code doc — no `device_code`, no
 * keys, no rate-limit details. 404 if the doc is missing, expired, denied, or
 * already consumed (any non-pending status hides the row to avoid leaking the
 * existence of stale codes to the wrong tab).
 *
 * This endpoint was added in PR 2 — PR 1 only exposed init/token/approve/cancel
 * which don't return metadata to the browser. Flagged in the PR description.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import { applyAuthUserLookupRateLimit } from '../_helpers';

export const dynamic = 'force-dynamic';

export interface ConnectLookupResponse {
  client_name: string;
  client_version?: string;
  device_label: string;
  repo_url?: string;
  repo_name?: string;
  expires_at: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // Auth gate — we do NOT bind the lookup to the eventual approver; any
    // signed-in user can call lookup with the code their tool produced. The
    // approve endpoint enforces the actual project-membership check.
    const auth = await authenticate(request);

    // Per-user rate limit (not per-IP): with auth required, every caller has
    // a stable identity, so user-bucketing prevents a single account from
    // brute-forcing the user_code keyspace regardless of what IP they hop to.
    // See spec §F.1 and PR #586.
    const allowed = await applyAuthUserLookupRateLimit(auth.userId);
    if (!allowed) {
      return NextResponse.json(
        { error: { message: 'Rate limit exceeded — try again in a minute' } },
        { status: 429 },
      );
    }

    const { searchParams } = new URL(request.url);
    const userCode = searchParams.get('user_code')?.trim();
    if (!userCode) {
      return NextResponse.json(
        { error: { message: 'user_code query parameter is required' } },
        { status: 400 },
      );
    }

    const { collections } = await import('@arbitra/backend');
    const snap = await collections.deviceCodes()
      .where('user_code', '==', userCode)
      .limit(1)
      .get();
    if (snap.empty) {
      return NextResponse.json(
        { error: { message: 'Unknown or expired code' } },
        { status: 404 },
      );
    }
    const doc = snap.docs[0]!.data();

    // Anything that isn't `pending` hides the metadata — denied/consumed/expired
    // all return 404 so the wrong tab can't reverse-engineer "did this code
    // exist?". Expiry check first because TTL deletion can lag.
    if (Date.parse(doc.expires_at) < Date.now()) {
      return NextResponse.json(
        { error: { message: 'Unknown or expired code' } },
        { status: 404 },
      );
    }
    if (doc.status !== 'pending') {
      return NextResponse.json(
        { error: { message: 'Code is no longer available' } },
        { status: 404 },
      );
    }

    const response: ConnectLookupResponse = {
      client_name: doc.client_name,
      client_version: doc.client_version,
      device_label: doc.device_label,
      repo_url: doc.repo_url,
      repo_name: doc.repo_name,
      expires_at: doc.expires_at,
    };
    return NextResponse.json(response);
  } catch (error) {
    return handleError(error);
  }
}
