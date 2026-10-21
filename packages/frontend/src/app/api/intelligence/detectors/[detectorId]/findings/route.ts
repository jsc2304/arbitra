import { NextRequest, NextResponse } from 'next/server';
import type { Case } from '@arbitra/shared';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/detectors/:detectorId/findings — admin-only list of
 * cases whose `intelligence_signature` starts with `${detectorId}:` (i.e.
 * cases created by that detector during any intelligence run).
 *
 * Signature format: `${detectorId}:${targetKind}:${targetId}` (see
 * `buildSignature` in the backend). A prefix range scan is safe because
 * Firestore's string ordering is lexicographic — `[detectorId:,
 * detectorId:\u{F8FF})` is exactly the set of docs whose signature begins
 * with `${detectorId}:`. U+F8FF is in the Unicode PUA and sorts above any
 * realistic suffix character, making the range tight.
 *
 * Ordered by `updated_at DESC` — backed by the composite
 * `(intelligence_signature ASC, updated_at DESC)` index in
 * `firestore.indexes.json`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ detectorId: string }> },
): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const { requireRole, CaseRepository } = await import('@arbitra/backend');
    await requireRole(auth.userId, ['admin']);

    const { detectorId } = await params;
    const { searchParams } = new URL(request.url);
    const limitRaw = searchParams.get('limit');
    const parsed = limitRaw ? Number.parseInt(limitRaw, 10) : 25;
    const limit = Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : 25, 100));

    const repo = new CaseRepository();
    const db = repo.getDb();

    const prefix = `${detectorId}:`;
    const upper = `${detectorId}:\u{F8FF}`;
    const snap = await db
      .collection('cases')
      .where('intelligence_signature', '>=', prefix)
      .where('intelligence_signature', '<', upper)
      .orderBy('intelligence_signature', 'asc')
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .get();

    const findings = snap.docs.map((d) => {
      const c = d.data() as Case;
      return {
        case_id: c.case_id,
        title: c.title,
        status: c.status,
        risk_level: c.risk_level,
        intelligence_signature: c.intelligence_signature ?? null,
        created_at: c.created_at,
        updated_at: c.updated_at,
      };
    });

    return NextResponse.json({ findings });
  } catch (error) {
    return handleError(error);
  }
}
