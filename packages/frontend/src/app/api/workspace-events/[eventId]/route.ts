import { NextRequest, NextResponse } from 'next/server';
import { WorkspaceEventService } from '@arbitra/backend';
import { authenticate, handleError } from '@/lib/api-helpers';

const workspaceEventService = new WorkspaceEventService();

/**
 * GET /api/workspace-events/:eventId — single-row detail lookup.
 *
 * Auth: any authenticated user. Workspace events are workspace-scoped by
 * definition (no project/case filter applies), so there is no role gate
 * beyond "you are signed in". If a future event type needs scoping, add it
 * here per-type rather than globally.
 *
 * Returns 404 when the document is missing so the detail drawer can render
 * a clean "not found" state instead of swallowing a generic error.
 */
export async function GET(request: NextRequest, props: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    await authenticate(request);
    const event = await workspaceEventService.get(params.eventId);
    if (!event) {
      return NextResponse.json(
        { error: { message: 'Workspace event not found' } },
        { status: 404 },
      );
    }
    return NextResponse.json(event);
  } catch (error) {
    return handleError(error);
  }
}
