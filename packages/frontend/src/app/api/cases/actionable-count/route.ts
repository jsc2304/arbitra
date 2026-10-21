import { NextRequest, NextResponse } from 'next/server';
import { CaseService } from '@arbitra/backend';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * Statuses that represent "needs my attention" for the courtroom launcher
 * badge. Must stay in sync with the client-side filter used to render the
 * actionable badge in `LauncherOverlay`.
 */
const ACTIONABLE_STATUSES = ['needs_human_decision', 'verification_pending'] as const;

const caseService = new CaseService();

/**
 * GET /api/cases/actionable-count
 *
 * Lightweight count endpoint for the launcher badge. Uses Firestore's
 * server-side `.count()` aggregation so the response size is constant
 * regardless of how many cases exist. Applies the same project-access
 * restrictions as the main list endpoint.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);

    const { checkIsAdmin, getAccessibleProjectIds } = await import('@arbitra/backend');
    const admin = await checkIsAdmin(auth.userId);

    let projectScope: string[] | undefined;
    if (!admin) {
      const accessibleIds = await getAccessibleProjectIds(auth.userId, false);
      if (accessibleIds === 'all') {
        projectScope = undefined;
      } else {
        projectScope = accessibleIds;
      }
    }

    const count = await caseService.countByStatus(ACTIONABLE_STATUSES, projectScope);
    return NextResponse.json({ count });
  } catch (error) {
    return handleError(error);
  }
}
