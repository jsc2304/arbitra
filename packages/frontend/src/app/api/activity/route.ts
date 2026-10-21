import { NextRequest, NextResponse } from 'next/server';
import { checkIsAdmin, listActivity } from '@arbitra/backend';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/activity — workspace-wide live event stream.
 *
 * Merges events from 5 collections (case_events, comments, evidence, findings,
 * decisions) into a single time-ordered list scoped to the caller's project
 * membership. Auth mirrors /api/dashboard: authenticated + admin bypass + non-
 * admin filtered via `getAccessibleProjectIds`.
 *
 * Query params:
 *   - `limit` (default 50, max 200)
 *   - `since` (ISO timestamp — only entries strictly newer are returned)
 *   - `before` (ISO timestamp — only entries strictly older are returned; used for paginating backward)
 *   - `client_name` (actor_metadata.client_name filter; case-insensitive)
 *   - `project_id`
 *   - `agents_only` ("true" to return only rows with actor_metadata.client_name)
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const admin = await checkIsAdmin(auth.userId);

    const searchParams = request.nextUrl.searchParams;
    const limitRaw = searchParams.get('limit');
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const since = searchParams.get('since') ?? undefined;
    const before = searchParams.get('before') ?? undefined;
    const clientName = searchParams.get('client_name') ?? undefined;
    const projectId = searchParams.get('project_id') ?? undefined;
    const agentsOnly = searchParams.get('agents_only') === 'true';

    const result = await listActivity(auth.userId, admin, {
      ...(limit ? { limit } : {}),
      ...(since ? { since } : {}),
      ...(before ? { before } : {}),
      ...(clientName ? { clientName } : {}),
      ...(projectId ? { projectId } : {}),
      ...(agentsOnly ? { agentsOnly } : {}),
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleError(error);
  }
}
