import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/runs — admin-only list of persisted intelligence
 * runs, newest first. Paginated via a `started_at`-based cursor (the cursor
 * value is the `started_at` of the last row from the previous page).
 *
 * This is backend groundwork for the Observatory UI (PR 5). The Firestore
 * index required for the `started_at DESC` ordering will land with PR 5 so
 * the production query doesn't need manual index creation before the UI is
 * actually rendering it.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const { requireRole, RunHistoryRepository } = await import('@arbitra/backend');
    await requireRole(auth.userId, ['admin']);

    const { searchParams } = new URL(request.url);
    const limitRaw = searchParams.get('limit');
    const cursor = searchParams.get('cursor') ?? undefined;
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;

    const repo = new RunHistoryRepository();
    const result = await repo.list({
      limit: Number.isFinite(limit) ? limit : 50,
      ...(cursor ? { cursor } : {}),
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleError(error);
  }
}
