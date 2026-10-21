/**
 * POST /api/auth/connect/approve — user confirms a device-flow grant.
 *
 * Requires Firebase ID token auth. The browser-side `/connect` page calls
 * this after the signed-in user picks a project and clicks Confirm. We
 * validate project membership via `isEffectiveMember` then flip the device
 * code doc from `pending` → `approved`. The poll endpoint mints the actual
 * PAT — we don't mint here so the raw token is only ever handed to the
 * device that started the flow.
 *
 * Idempotent on second approve of the same `(user_code, project_id, user_id)`.
 *
 * See `docs/specs/device-flow-and-per-tool-tokens.md` §B.4.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

interface ApproveBody {
  user_code?: string;
  project_id?: string;
  device_label?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const body = (await request.json().catch(() => ({}))) as ApproveBody;

    const userCode = body.user_code?.trim();
    const projectId = body.project_id?.trim();
    if (!userCode || !projectId) {
      return NextResponse.json(
        { error: { message: 'user_code and project_id are required' } },
        { status: 400 },
      );
    }

    const { collections, isEffectiveMember, getDb } = await import('@arbitra/backend');

    // Look up the device-code doc by user_code. The composite
    // `(user_code, status)` index lets us skip already-consumed/denied rows.
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

    if (Date.parse(doc.expires_at) < Date.now()) {
      return NextResponse.json(
        { error: { message: 'Code has expired' } },
        { status: 400 },
      );
    }

    if (doc.status === 'denied') {
      return NextResponse.json(
        { error: { message: 'Code was cancelled' } },
        { status: 409 },
      );
    }
    if (doc.status === 'consumed') {
      return NextResponse.json(
        { error: { message: 'Code has already been used' } },
        { status: 409 },
      );
    }

    // Already approved by this user for the same project → idempotent OK.
    // Different project / different user trying to re-approve → 409 (the flow
    // is one-shot; let the user start over rather than reassigning).
    if (doc.status === 'approved') {
      if (doc.user_id === auth.userId && doc.project_id === projectId) {
        const projDoc = await collections.projects().doc(projectId).get();
        const projectName = projDoc.exists ? projDoc.data()!.name : projectId;
        return NextResponse.json({ approved: true, project_name: projectName });
      }
      return NextResponse.json(
        { error: { message: 'Code is already approved for a different session' } },
        { status: 409 },
      );
    }

    // status === 'pending' — verify project access first (the read can happen
    // outside the transaction; project membership doesn't race here).
    const projDoc = await collections.projects().doc(projectId).get();
    if (!projDoc.exists) {
      return NextResponse.json(
        { error: { message: 'Project not found' } },
        { status: 404 },
      );
    }
    const project = projDoc.data()!;
    if (!isEffectiveMember(project, auth.userId)) {
      return NextResponse.json(
        { error: { message: 'You do not have access to this project' } },
        { status: 403 },
      );
    }

    const deviceLabel = body.device_label?.trim() || doc.device_label || 'Unknown device';

    // Wrap the read-check-write in a transaction so two concurrent browsers
    // can't both pass the `pending` check and last-write-wins the binding.
    // Mirrors the mint-and-flip pattern in `token/route.ts`. The second
    // transaction to commit will see `status !== 'pending'` and we return 409.
    const db = getDb();
    try {
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(ref);
        if (!fresh.exists) throw new Error('TX_NOT_FOUND');
        const data = fresh.data()!;
        if (data.status !== 'pending') {
          // A parallel approve (or cancel) won the race.
          throw new Error('TX_ALREADY_CONSUMED');
        }
        tx.update(ref, {
          status: 'approved',
          user_id: auth.userId,
          project_id: projectId,
          device_label: deviceLabel,
          approved_at: new Date().toISOString(),
        });
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'TX_NOT_FOUND') {
        return NextResponse.json(
          { error: { message: 'Unknown or expired code' } },
          { status: 404 },
        );
      }
      if (err instanceof Error && err.message === 'TX_ALREADY_CONSUMED') {
        return NextResponse.json(
          { error: { message: 'Code is already approved for a different session' } },
          { status: 409 },
        );
      }
      throw err;
    }

    return NextResponse.json({ approved: true, project_name: project.name });
  } catch (error) {
    return handleError(error);
  }
}
