import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import { validateBody } from '@arbitra/backend';
import { createTokenSchema } from '@arbitra/shared';
import type { PersonalAccessToken } from '@arbitra/shared';
import crypto from 'node:crypto';

export const dynamic = 'force-dynamic';

function generateTokenValue(): string {
  return `arb_${crypto.randomBytes(32).toString('hex')}`;
}

function hashTokenValue(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const { collections } = await import('@arbitra/backend');
    const snapshot = await collections.tokens()
      .where('user_id', '==', auth.userId)
      .get();
    const tokens = snapshot.docs.map((doc) => doc.data());
    return NextResponse.json({ tokens });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const body = await request.json();
    // `createTokenSchema` (packages/shared/src/validation/token-validators.ts)
    // mirrors this route's own prior hand-rolled coercion exactly — see its
    // jsdoc for why `client_name`/`client_version`/`device_id`/`device_label`
    // coerce empty/whitespace-only/non-string to `undefined` rather than
    // rejecting, and why `created_via` stays a permissive string.
    const validated = validateBody(createTokenSchema, body);

    const raw = generateTokenValue();
    const hash = hashTokenValue(raw);
    const prefix = `${raw.slice(0, 8)}...${raw.slice(-4)}`;

    // Public POST is allowed to mint `manual` and `ci_service` tokens only.
    // `unified_connect` is reserved for the server-side mint inside
    // /api/auth/connect/token — accepting it here would let any authenticated
    // client produce a token that appears in the Connections panel as if it
    // came from a verified device flow, undermining the panel's legitimacy
    // signal. Silently clamp any non-public value to `manual` (rejection
    // would tell an attacker exactly which value the system reserves).
    const createdVia: 'manual' | 'ci_service' =
      validated.created_via === 'manual' || validated.created_via === 'ci_service'
        ? validated.created_via
        : 'manual';

    const { collections, generateId } = await import('@arbitra/backend');
    const token: PersonalAccessToken = {
      token_id: generateId('token'),
      user_id: auth.userId,
      name: validated.name,
      token_hash: hash,
      token_prefix: prefix,
      created_at: new Date().toISOString(),
      client_name: validated.client_name,
      client_version: validated.client_version,
      device_id: validated.device_id,
      device_label: validated.device_label,
      created_via: createdVia,
    };

    await collections.tokens().doc(token.token_id).set(token);

    return NextResponse.json({ token, raw_token: raw }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const { searchParams } = new URL(request.url);
    const tokenId = searchParams.get('tokenId');
    const deviceId = searchParams.get('device_id');

    if (!tokenId && !deviceId) {
      return NextResponse.json(
        { error: { message: 'tokenId or device_id query parameter is required' } },
        { status: 400 },
      );
    }

    const { collections } = await import('@arbitra/backend');

    // Single-token delete — keep the original contract.
    if (tokenId) {
      const doc = await collections.tokens().doc(tokenId).get();
      if (!doc.exists || doc.data()!.user_id !== auth.userId) {
        return NextResponse.json({ error: { message: 'Token not found' } }, { status: 404 });
      }
      await collections.tokens().doc(tokenId).delete();
      return NextResponse.json({ success: true });
    }

    // Bulk delete — all tokens for this user × device. The query is scoped by
    // `user_id` so we never delete another user's row even if they share a
    // device_id (which would be a hash collision; not currently possible).
    const snapshot = await collections.tokens()
      .where('user_id', '==', auth.userId)
      .where('device_id', '==', deviceId)
      .get();

    if (snapshot.empty) {
      // Idempotent: caller may have already revoked. Returning 200 with a 0
      // count is cleaner than 404 — the desired state ("no tokens on that
      // device for this user") is satisfied either way.
      return NextResponse.json({ success: true, deleted_count: 0 });
    }

    await Promise.all(snapshot.docs.map((d) => d.ref.delete()));
    return NextResponse.json({ success: true, deleted_count: snapshot.docs.length });
  } catch (error) {
    return handleError(error);
  }
}
