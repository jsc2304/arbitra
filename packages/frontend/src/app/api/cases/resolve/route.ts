import { NextRequest, NextResponse } from 'next/server';
import { resolveCaseByBranch, validateBody } from '@arbitra/backend';
import { resolveCaseByBranchSchema } from '@arbitra/shared';
import { authenticate, handleError, requireProjectAccess } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const NO_CASE = { case: null, ambiguous: false } as const;

/**
 * GET /api/cases/resolve?repository_id=...&branch=...
 *
 * Branch-keyed case resolution (issue #982): given (repository_id, branch),
 * returns the case bound to that branch — the inverse of the case →
 * (current_branch) binding. Used by agent/MCP flows instead of any local
 * active-case pointer.
 *
 * - Unknown branch → `{ case: null, ambiguous: false }`, a normal 200
 *   answer, never a 404.
 * - Bound branch → the case, `ambiguous: false`.
 * - Multiple non-terminal cases sharing the branch (should not normally
 *   happen — see `assertBranchUniqueForCase` — but can with pre-existing
 *   data) → the most recently updated one, `ambiguous: true`.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const params = Object.fromEntries(request.nextUrl.searchParams);
    const { repository_id: repositoryId, branch } = validateBody(resolveCaseByBranchSchema, params);

    const result = await resolveCaseByBranch({ repositoryId, branch });

    if (result.case) {
      const denied = await requireProjectAccess(result.case.project_id, auth.userId);
      if (denied) {
        // Caller can't see this case's project — degrade to the same
        // "no case" answer an unknown branch gets, rather than leaking
        // that a case exists.
        return NextResponse.json(NO_CASE);
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    return handleError(error);
  }
}
