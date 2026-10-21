import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/mission-control
 *
 * Mission Control read path (issue #989 / ADR-0001): active sessions joined
 * with repository → project and branch → case — "what is running right
 * now". Computed on read via `buildMissionControlAggregate`; no separate
 * storage layer. Also returns the 24h/7d/30d active-sessions panel (issue
 * #990 / #981 story 10) via `buildActiveSessionsPanel`, derived from the
 * same session registry.
 *
 * Authorization mirrors `/api/sessions/active`: admins see every session
 * (`accessibleProjectIds: 'all'`), everyone else is scoped to their
 * accessible project ids — for both the live list and the panel. Both
 * aggregates still fail closed on a session whose repository can't be
 * resolved, for every caller.
 *
 * Bounded reads (issue #1003): this route is polled every 10s
 * (POLL_INTERVAL_MS, mission-control/page.tsx) by every open tab.
 * `buildMissionControlAggregate`'s expensive join (session → repository →
 * project → case, including `resolveSessionRepositories`'s Firestore
 * lookups) is cached in-process for 8s (MISSION_CONTROL_CACHE_TTL_MS,
 * mission-control-service.ts), shared across every open tab and caller.
 *
 * Before this change: 1 + R + P + S reads PER POLL, PER OPEN TAB (session
 * query + repo resolution + project docs + case lookups; R can include a
 * `repositories().limit(200)` full-scan per distinct unresolved ref — see
 * webhook-service.ts `resolveRepositoryForSignal` — up to ~200 reads for
 * that one ref alone). After this change: the same (1 + R + P + S) still
 * happens on a cache miss, but at most once per 8s system-wide rather than
 * once per request, so the open-tab multiplier collapses from linear (K
 * tabs = K× the cost) to roughly constant (~1-2 computations per 10s poll
 * window regardless of K). `getAll` batches the P project-doc reads into
 * one round trip but does NOT reduce billed reads (Firestore bills per
 * document either way) — the cache is what cuts the bill. The R-side
 * `limit(200)` scan itself is unchanged and NOT covered by this PR (no doc
 * id to batch there); the cache amortizes its cost across pollers but does
 * not reduce a single cache-miss's cost. See the PR body for the full
 * before/after accounting.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const {
      buildMissionControlAggregate,
      buildActiveSessionsPanel,
      applyMissionControlRowCap,
      checkIsAdmin,
      getAccessibleProjectIds,
    } = await import('@arbitra/backend');

    const isAdmin = await checkIsAdmin(auth.userId);
    const accessibleProjectIds: 'all' | Set<string> = isAdmin
      ? 'all'
      : new Set(
          // `isAdmin` is false here, so `getAccessibleProjectIds` never
          // returns the 'all' sentinel — narrows the type back to string[].
          (await getAccessibleProjectIds(auth.userId, false)) as string[],
        );

    const [scopedRows, activeSessionsPanel] = await Promise.all([
      buildMissionControlAggregate({ accessibleProjectIds }),
      buildActiveSessionsPanel({ accessibleProjectIds }),
    ]);
    const { sessions, truncated_session_count } = applyMissionControlRowCap(scopedRows);
    return NextResponse.json({
      sessions,
      active_sessions_panel: activeSessionsPanel,
      truncated_session_count,
    });
  } catch (error) {
    return handleError(error);
  }
}
