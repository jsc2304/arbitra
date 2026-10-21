import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import type { ActiveSessionSummary } from '@arbitra/shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/sessions/active
 *
 * Session-registry read path (issue #983 / ADR-0001): every session
 * currently reading as active — repository, branch, agent, session id,
 * last-seen — derived on read from the liveness window. This is the raw
 * material Mission Control (#-later) will aggregate; it does not itself
 * join against cases.
 *
 * Authorization: `listActiveSessions` itself is system-wide (it has no
 * notion of caller), so this route is the authorization boundary — same
 * split as `/api/runs/active`. A session carries a repository (id, per
 * `SessionSignalEvent`), not a project, so scoping means resolving each
 * distinct repository to its project and keeping only sessions in projects
 * the caller can access. Admins bypass this. A session whose repository
 * can't be resolved to a project doc is dropped for non-admins — fail
 * closed, mirroring `checkCaseAccess`'s "orphaned reference = deny" policy
 * (`lib/project-access.ts`) rather than treating an unresolved repository as
 * unrestricted.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const { listActiveSessions, checkIsAdmin, getAccessibleProjectIds, resolveSessionRepositories } = await import('@arbitra/backend');

    const [sessions, isAdmin] = await Promise.all([listActiveSessions(), checkIsAdmin(auth.userId)]);

    if (isAdmin) {
      return NextResponse.json({ sessions });
    }

    if (sessions.length === 0) {
      return NextResponse.json({ sessions: [] });
    }

    const accessibleProjectIds = await getAccessibleProjectIds(auth.userId, false);
    // `isAdmin` is false here, so `getAccessibleProjectIds` never returns
    // the 'all' sentinel — this narrows the type back to string[] without
    // silently treating a future 'all' as "no access".
    const accessible = new Set(accessibleProjectIds === 'all' ? [] : accessibleProjectIds);

    // Session Signals carry the raw repository ref (usually the git remote
    // URL, not a repo doc id) — resolve through the shared matcher instead
    // of a direct doc lookup, which throws on ids containing '/'.
    const repoByRef = await resolveSessionRepositories(sessions.map((s) => s.repository));

    const scoped: ActiveSessionSummary[] = sessions.filter((session) => {
      const projectId = repoByRef.get(session.repository)?.project_id;
      if (!projectId) return false;
      return accessible.has(projectId);
    });

    return NextResponse.json({ sessions: scoped });
  } catch (error) {
    return handleError(error);
  }
}
