import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/intelligence/detectors/:detectorId — admin-only runtime toggle
 * for a single detector. Writes merge into the single `intelligence_config/
 * detectors` doc so concurrent toggles to different detectors don't race.
 *
 * Body: `{ enabled: boolean }`. The detector id is NOT validated against
 * `ALL_DETECTORS` — an admin may pre-stage config for a detector that is
 * about to ship, and a typoed id simply has no runtime effect.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ detectorId: string }> },
): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const { requireRole, DetectorConfigRepository } = await import('@arbitra/backend');
    await requireRole(auth.userId, ['admin']);

    const { detectorId } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || typeof (body as { enabled?: unknown }).enabled !== 'boolean') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Body must be { enabled: boolean }' } },
        { status: 400 },
      );
    }
    const { enabled } = body as { enabled: boolean };

    const repo = new DetectorConfigRepository();
    const config = await repo.setEnabled(detectorId, enabled, auth.userId);
    return NextResponse.json({ detector_id: detectorId, config });
  } catch (error) {
    return handleError(error);
  }
}
