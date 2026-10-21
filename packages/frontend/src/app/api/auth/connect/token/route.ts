/**
 * POST /api/auth/connect/token — RFC 8628 §3.4 device access token request.
 *
 * Public endpoint. The device polls this with its `device_code`. Returns:
 *   - 200 + token bundle once the user has approved and we mint a PAT
 *   - 400 + `{ error: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'invalid_grant' }`
 *
 * Slow-down enforcement: if the device polls faster than the doc's
 * `poll_interval_seconds`, bump the interval by 5s and increment a strike
 * counter. After 3 strikes the device is permanently denied (RFC 8628 §3.5
 * permits the AS to "permanently treat the client request as denied").
 *
 * Mint-and-flip atomicity: the PAT row is created and the device-code row
 * flipped to `consumed` inside a single Firestore transaction. A crash
 * mid-transaction leaves the world in the prior state — either a code that
 * still says `approved` (so the device can retry) or a brand-new approved
 * mint where the row is already `consumed`.
 *
 * See `docs/specs/device-flow-and-per-tool-tokens.md` §B.2.
 */
import { NextRequest, NextResponse } from 'next/server';
import { handleError } from '@/lib/api-helpers';
import type { PersonalAccessToken } from '@arbitra/shared';
import {
  SLOW_DOWN_INTERVAL_BUMP_SECONDS,
  SLOW_DOWN_STRIKE_LIMIT,
  hashDeviceCode,
  resolvePublicOrigin,
} from '../_helpers';

export const dynamic = 'force-dynamic';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

interface TokenBody {
  grant_type?: string;
  device_code?: string;
}

/** Helper: send an RFC 8628 §3.5 error envelope at HTTP 400. */
function rfcError(code: string): NextResponse {
  return NextResponse.json({ error: code }, { status: 400 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as TokenBody;

    if (body.grant_type !== GRANT_TYPE) {
      return NextResponse.json(
        { error: 'unsupported_grant_type', error_description: `grant_type must be ${GRANT_TYPE}` },
        { status: 400 },
      );
    }

    const deviceCode = body.device_code;
    if (!deviceCode || typeof deviceCode !== 'string') {
      return rfcError('invalid_grant');
    }

    const docId = hashDeviceCode(deviceCode);
    const { collections, generatePAT } = await import('@arbitra/backend');
    const ref = collections.deviceCodes().doc(docId);
    const snap = await ref.get();
    if (!snap.exists) return rfcError('invalid_grant');

    const doc = snap.data()!;
    const now = Date.now();

    if (Date.parse(doc.expires_at) < now) {
      // Expired — best-effort delete, but TTL will get it eventually.
      ref.delete().catch(() => {});
      return rfcError('expired_token');
    }

    if (doc.status === 'consumed') {
      // Idempotent on consumed: the device has already received its token.
      // Returning invalid_grant prevents replay; we don't re-mint.
      return rfcError('invalid_grant');
    }

    if (doc.status === 'denied') {
      return rfcError('access_denied');
    }

    // Slow-down enforcement applies ONLY to `pending` polls. Once the doc is
    // `approved` the device is racing toward consumption — the slow-down
    // dance is over, and counting strikes on those polls would lock out a
    // legitimate device that fast-polled an already-approved code (e.g. after
    // a network glitch). Spec §B.2.
    if (doc.status === 'pending' && doc.last_polled_at) {
      const sinceLast = (now - Date.parse(doc.last_polled_at)) / 1000;
      // Allow a 1s grace below the configured interval to account for clock
      // skew and HTTP latency at the boundary.
      if (sinceLast < doc.poll_interval_seconds - 1) {
        const { FieldValue } = await import('firebase-admin/firestore');
        // Atomic increment avoids lost-update under concurrent fast polls:
        // read-then-write would let three racing polls each see strikes=0
        // and write strikes=1 instead of cumulatively reaching 3.
        const nextStrikes = (doc.slow_down_strikes ?? 0) + 1;
        if (nextStrikes >= SLOW_DOWN_STRIKE_LIMIT) {
          await ref.update({
            status: 'denied',
            slow_down_strikes: FieldValue.increment(1),
            last_polled_at: new Date(now).toISOString(),
          });
          return rfcError('access_denied');
        }
        await ref.update({
          poll_interval_seconds: FieldValue.increment(SLOW_DOWN_INTERVAL_BUMP_SECONDS),
          slow_down_strikes: FieldValue.increment(1),
          last_polled_at: new Date(now).toISOString(),
        });
        return rfcError('slow_down');
      }
    }

    if (doc.status === 'pending') {
      await ref.update({ last_polled_at: new Date(now).toISOString() });
      return rfcError('authorization_pending');
    }

    if (doc.status !== 'approved') {
      // Defensive — every status is enumerated above.
      return rfcError('invalid_grant');
    }

    if (!doc.user_id || !doc.project_id) {
      // approve handler is the only writer of `approved` and always sets
      // these — defensive guard for malformed data.
      return rfcError('invalid_grant');
    }

    // Mint + flip atomically. The transaction re-reads the doc to avoid a
    // double-mint when two polls race past the same `approved` snapshot.
    const { getDb } = await import('@arbitra/backend');
    const db = getDb();
    const mint = generatePAT();
    const tokenId = `tok_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    let mintedAt: string | null = null;
    try {
      mintedAt = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(ref);
        if (!fresh.exists) throw new Error('TX_INVALID_GRANT');
        const data = fresh.data()!;
        if (data.status !== 'approved') {
          // Already consumed by a racing poll, or transitioned elsewhere.
          throw new Error('TX_INVALID_GRANT');
        }
        const tokenName = data.device_label
          ? `${data.client_name} on ${data.device_label}`
          : data.client_name;
        const nowIso = new Date().toISOString();
        const pat: PersonalAccessToken = {
          token_id: tokenId,
          user_id: data.user_id!,
          name: tokenName,
          token_hash: mint.hash,
          token_prefix: mint.prefix,
          created_at: nowIso,
          client_name: data.client_name,
          client_version: data.client_version,
          device_id: data.device_id,
          device_label: data.device_label,
          created_via: 'unified_connect',
        };
        tx.set(collections.tokens().doc(tokenId), pat);
        tx.update(ref, { status: 'consumed' });
        return nowIso;
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'TX_INVALID_GRANT') {
        return rfcError('invalid_grant');
      }
      throw err;
    }

    // Resolve the project name for the friendly UI message. Best-effort —
    // fall back to the id if lookup fails.
    let projectName: string | undefined;
    try {
      const projDoc = await collections.projects().doc(doc.project_id).get();
      projectName = projDoc.exists ? projDoc.data()!.name : doc.project_id;
    } catch {
      projectName = doc.project_id;
    }

    void mintedAt; // referenced for transaction return shape

    return NextResponse.json({
      access_token: mint.raw,
      token_type: 'Bearer',
      token_prefix: mint.prefix,
      project_id: doc.project_id,
      project_name: projectName,
      server_url: resolvePublicOrigin(request),
    });
  } catch (error) {
    return handleError(error);
  }
}
