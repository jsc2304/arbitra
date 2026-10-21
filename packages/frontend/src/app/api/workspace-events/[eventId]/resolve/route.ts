import { NextRequest, NextResponse } from 'next/server';
import { WorkspaceEventService } from '@arbitra/backend';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const workspaceEventService = new WorkspaceEventService();

/**
 * POST /api/workspace-events/:eventId/resolve — global resolve.
 *
 * Auth: `admin` or `tech_lead`. Writes `resolved_at` + `resolved_by` onto
 * the canonical event so every viewer's activity feed drops it on the next
 * fetch. Idempotent — a second call just refreshes `resolved_at`. Returns
 * the updated event body, or 404 when the id does not exist.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const { requireRole } = await import('@arbitra/backend');
    await requireRole(auth.userId, ['admin', 'tech_lead']);

    const updated = await workspaceEventService.resolve(params.eventId, auth.userId);
    if (!updated) {
      return NextResponse.json(
        { error: { message: 'Workspace event not found' } },
        { status: 404 },
      );
    }
    return NextResponse.json(updated);
  } catch (error) {
    return handleError(error);
  }
}
