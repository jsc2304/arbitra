import { NextRequest, NextResponse } from 'next/server';
import {
  checkIsAdmin,
  collections,
  getAccessibleProjectIds,
} from '@arbitra/backend';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * Idle threshold for the `idle_over_threshold` chip — a detector-opened case
 * is "stale" when it hasn't been touched in this many days. The chip means
 * "idle past the configured threshold"; 7d matches the default
 * stale-detector window today.
 */
const IDLE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * GET /api/activity/needs-me — aggregation behind the "What needs me"
 * pinned strip on the activity feed.
 *
 * Returns four counts:
 *   - `awaiting_decision`   active cases needing the viewer's gate
 *                           (`needs_human_decision` / `verification_pending`),
 *                           filtered to those assigned to the viewer (admins
 *                           see the global queue). Findings have no assignment
 *                           field today — they roll up to their parent case,
 *                           which is what the count tracks.
 *   - `idle_over_threshold` Detector-opened active cases on the viewer's
 *                           projects that haven't been touched in
 *                           `IDLE_THRESHOLD_MS`.
 *   - `failed_builds_24h`   `run_failed` / `build_failed` case events in the
 *                           last 24h, project-scoped to the viewer's cases.
 *   - `webhook_rejections`  unresolved `webhook_rejected` workspace events
 *                           in the last 24h (resolved + viewer-dismissed
 *                           events excluded).
 *
 * Both feed-derived counts (`failed_builds_24h`, `webhook_rejections`) run as
 * dedicated, narrowly-filtered Firestore queries rather than slicing a capped
 * `listActivity` page. The previous `limit: 200` scan silently undercounted
 * once a workspace produced more than 200 activity rows in 24h (issue #567
 * item 14). A pure Firestore `count()` aggregation is not usable here: the
 * failed-build count needs the case→project join for non-admin scoping (case
 * events carry no `project_id`), and the webhook count must subtract resolved
 * + per-viewer-dismissed events (a second inequality + a per-user set a single
 * `count()` can't express). So each count is an *unbounded* targeted scan, with
 * the scoping/resolution/dismissal rules applied in memory:
 *   - failed builds use the existing `case_events (type, created_at)` composite
 *     index (`type in [...] + created_at >= since`);
 *   - webhook rejections use an equality-only `type == 'webhook_rejected'`
 *     query (automatic single-field index — no composite to provision) and
 *     filter the 24h window in memory, since `webhook_rejected` is low-volume.
 *
 * Each count is paired with a `filter` payload the client uses to pin the
 * feed when the chip is clicked. `filter` is intentionally a structural
 * subset of the existing `ActivityFilters` shape so the client can spread it
 * straight into `setFilters()`.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const admin = await checkIsAdmin(auth.userId);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Awaiting decision + idle counts both hang off the active-cases
    // collection. Direct Firestore aggregation would need composite indexes
    // we don't have for this MVP, so we fetch the (small) active set and
    // filter in memory. Same approach as `useActionableCount`. Loaded up-front
    // because the failed-build count below also needs the case→project map for
    // non-admin scoping.
    const allCasesSnap = await collections.activeCases().get();
    const allCases = allCasesSnap.docs.map((d) => d.data());

    // Project scope for non-admins — applied to BOTH idle-count and
    // awaiting-decision so the chip respects "your projects".
    // Admins see everything (`accessible === 'all'`).
    const accessible = await getAccessibleProjectIds(auth.userId, admin);
    const inScope = (projectId: string | undefined): boolean => {
      if (accessible === 'all') return true;
      // Cases with no project are intentionally excluded from non-admin
      // counts — the rest of the app treats them as global/admin-only.
      if (!projectId) return false;
      return accessible.includes(projectId);
    };

    // Set of case ids the viewer may see, used to project-scope the
    // failed-build count (case events carry no project_id, so we scope by
    // joining each event's case_id to the in-scope active cases). Admins keep
    // the global set.
    const inScopeCaseIds = new Set(
      allCases.filter((c) => inScope(c.project_id)).map((c) => c.case_id),
    );

    // failed_builds_24h — dedicated, unbounded query over `case_events` filtered
    // to the failure types in the last 24h, then project-scoped in memory.
    // `'in'` (≤30 values) + a single `created_at >=` inequality is index-able.
    const failedBuildSnap = await collections
      .caseEvents()
      .where('type', 'in', ['run_failed', 'build_failed'])
      .where('created_at', '>=', since)
      .get();
    const failedBuilds24h = failedBuildSnap.docs
      .map((d) => d.data())
      .filter((e) => inScopeCaseIds.has(e.case_id)).length;

    // webhook_rejections — dedicated, unbounded query over `workspace_events`
    // filtered to `webhook_rejected` (equality only, so it rides the automatic
    // single-field index — no composite index to provision). The 24h window,
    // resolved state, and per-viewer dismissals are applied in memory: Firestore
    // can't combine the `timestamp` range, the `resolved_at` inequality, and the
    // per-user dismissal set into one query, and `webhook_rejected` events are
    // low-volume so an all-time equality scan stays cheap.
    const [webhookSnap, dismissalSnap] = await Promise.all([
      collections.workspaceEvents().where('type', '==', 'webhook_rejected').get(),
      collections
        .workspaceEventDismissals()
        .where('user_id', '==', auth.userId)
        .get(),
    ]);
    const dismissedEventIds = new Set(
      dismissalSnap.docs.map((d) => d.data().event_id).filter(Boolean),
    );
    const webhookRejections = webhookSnap.docs
      .map((d) => d.data())
      .filter(
        (we) =>
          we.timestamp >= since && !we.resolved_at && !dismissedEventIds.has(we.event_id),
      ).length;

    const awaitingDecision = allCases.filter((c) => {
      if (c.status !== 'needs_human_decision' && c.status !== 'verification_pending') {
        return false;
      }
      if (!inScope(c.project_id)) return false;
      // Admins see the global queue; everyone else only counts cases assigned
      // to them. Unassigned reviewer-class cases are intentionally excluded
      // from the personal "needs me" chip — they show up via the existing
      // approval queue, not as an inbox count for every reviewer.
      if (admin) return true;
      return c.assigned_reviewer_id === auth.userId;
    }).length;

    // Idle over threshold — detector-opened active cases on the viewer's
    // projects that haven't been touched in IDLE_THRESHOLD_MS. The
    // `system:arbitra-intelligence` owner is the canonical detector identity
    // (see `caseWasDetectorOpened` in activity-service).
    const idleCutoff = Date.now() - IDLE_THRESHOLD_MS;
    const idleOverThreshold = allCases.filter((c) => {
      if (c.owner_user_id !== 'system:arbitra-intelligence') return false;
      if (!inScope(c.project_id)) return false;
      // `updated_at` is an ISO string; compare via Date.parse for clarity.
      const updatedAt = c.updated_at ? Date.parse(c.updated_at) : NaN;
      if (Number.isNaN(updatedAt)) return false;
      return updatedAt < idleCutoff;
    }).length;

    return NextResponse.json({
      awaiting_decision: {
        count: awaitingDecision,
        filter: { needsMe: true },
      },
      idle_over_threshold: {
        count: idleOverThreshold,
        // Detector-opened lifecycle event — best client-side proxy until we
        // have a dedicated openedBy filter on the feed.
        filter: { openedBy: 'detector' as const },
      },
      failed_builds_24h: {
        count: failedBuilds24h,
        filter: { kind: 'case_event' as const, subkind: 'run_failed' },
      },
      webhook_rejections: {
        count: webhookRejections,
        filter: { kind: 'workspace_event' as const, subkind: 'webhook_rejected' },
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
