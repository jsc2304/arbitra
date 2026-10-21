import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/runs/:runId — admin-only fetch of a single persisted
 * intelligence run by id. 404 when the doc is absent (treat deleted / old-retention
 * runs as not found rather than 500).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const { requireRole, RunHistoryRepository } = await import('@arbitra/backend');
    await requireRole(auth.userId, ['admin']);

    const { runId } = await params;
    const repo = new RunHistoryRepository();
    const run = await repo.get(runId);
    if (!run) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Run not found' } },
        { status: 404 },
      );
    }
    return NextResponse.json(run);
  } catch (error) {
    return handleError(error);
  }
}
