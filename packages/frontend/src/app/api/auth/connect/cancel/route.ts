/**
 * POST /api/auth/connect/cancel — user cancels a pending device-flow grant.
 *
 * Requires Firebase ID token auth. Sets the device-code doc's status to
 * `denied`. Idempotent — re-cancelling a `denied` doc is a no-op success.
 * Re-cancelling a `consumed` doc returns 409 because the device already has
 * a working token and we don't want to imply revocation here.
 *
 * See `docs/specs/device-flow-and-per-tool-tokens.md` §B.5.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

interface CancelBody {
  user_code?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await authenticate(request);
    const body = (await request.json().catch(() => ({}))) as CancelBody;

    const userCode = body.user_code?.trim();
    if (!userCode) {
      return NextResponse.json(
        { error: { message: 'user_code is required' } },
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

    const ref = snap.docs[0]!.ref;
    const doc = snap.docs[0]!.data();

    if (doc.status === 'consumed') {
      // The device has its token — cancel here would mislead. Caller should
      // use the tokens panel to revoke instead.
      return NextResponse.json(
        { error: { message: 'Code has already been used; revoke the token via Settings → Connections' } },
        { status: 409 },
      );
    }

    if (doc.status === 'denied') {
      return NextResponse.json({ cancelled: true });
    }

    await ref.update({ status: 'denied' });
    return NextResponse.json({ cancelled: true });
  } catch (error) {
    return handleError(error);
  }
}
