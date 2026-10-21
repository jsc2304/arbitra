import { NextRequest, NextResponse } from 'next/server';
import { WorkspaceEventService } from '@arbitra/backend';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const workspaceEventService = new WorkspaceEventService();

/**
 * POST /api/workspace-events/:eventId/dismiss — per-user dismissal.
 *
 * Auth: any authenticated user. Upserts a `workspace_event_dismissals`
 * doc keyed by `${userId}_${eventId}` so the event vanishes from this
 * viewer's activity feed only. Idempotent. Returns the dismissal record.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const dismissal = await workspaceEventService.dismissForUser(params.eventId, auth.userId);
    return NextResponse.json(dismissal);
  } catch (error) {
    return handleError(error);
  }
}
