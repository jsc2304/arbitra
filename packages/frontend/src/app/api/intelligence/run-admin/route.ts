import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * POST /api/intelligence/run-admin — admin-authenticated equivalent of the
 * scheduler's secret-gated `/api/intelligence/run`. Invokes a fresh
 * intelligence run with `trigger: 'manual'` and `triggered_by: auth.userId`
 * so the resulting `IntelligenceRun` is attributable in the audit log.
 *
 * Returns the full `IntelligenceRun` record (already persisted) so the
 * observatory UI (PR 5) can deep-link straight to the run detail without
 * waiting on a second round-trip.
 *
 * Concurrency: shares the same Firestore-backed lock as the scheduler. A
 * second concurrent call (admin or scheduler) gets 409 with
 * `intelligence_run_in_progress`.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const { requireRole, IntelligenceService, ALL_DETECTORS, IntelligenceLockHeldError } =
      await import('@arbitra/backend');
    await requireRole(auth.userId, ['admin']);

    const service = new IntelligenceService(ALL_DETECTORS);
    let run;
    try {
      run = await service.runForAdmin({ trigger: 'manual', triggered_by: auth.userId });
    } catch (err) {
      if (err instanceof IntelligenceLockHeldError) {
        return NextResponse.json(
          { error: 'intelligence_run_in_progress' },
          { status: 409 },
        );
      }
      throw err;
    }
    return NextResponse.json(run);
  } catch (error) {
    return handleError(error);
  }
}
