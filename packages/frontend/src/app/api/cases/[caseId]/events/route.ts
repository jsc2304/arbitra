import { NextRequest, NextResponse } from 'next/server';
import { EventService } from '@arbitra/backend';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const eventService = new EventService();

/**
 * `type` was free-form, so any case member could
 * forge lifecycle-significant events (e.g. `case_approved`) straight into
 * the audit trail and trigger the same notifications a real approval does.
 *
 * `EventType` (packages/shared/src/types/event.ts) is deliberately a loose
 * union (`| (string & {})`) for TS ergonomics elsewhere, but this route is
 * the one place a raw client body reaches `EventService.emit` directly —
 * so it enforces its own explicit allowlist rather than trusting the type
 * declaration. Default is deny: only types below may be POSTed here.
 *
 * SERVER-ONLY (rejected — every one of these either drives a
 * `TRANSITION_MATRIX` transition in
 * packages/shared/src/constants/status-transitions.ts, or is emitted
 * exclusively by a server-side path — webhook handlers, the autonomous
 * pipeline/run-executor, decision-service, knowledge-service, rule-service,
 * evidence-service, the notification dispatcher):
 *   case_created, case_deleted, track_assigned, exploration_requested,
 *   exploration_completed, case_ready_for_build, build_started,
 *   validation_requested, validation_started, review_requested,
 *   review_started, human_decision_requested, human_decision_recorded,
 *   manual_verification_requested, manual_validation_confirmed,
 *   auto_approve_decision, case_approved, merge_ready,
 *   merge_skipped_not_applicable, case_auto_closed_on_merge,
 *   case_anomaly_merge_on_gated_status, case_completed, case_rejected,
 *   changes_requested, run_created, run_started, run_completed,
 *   run_failed, run_retries_exhausted, evidence_registered,
 *   evidence_missing_detected, finding_created, finding_updated,
 *   rule_results_attached, rule_override_created, decision_created,
 *   risk_level_changed, case_updated (issue #794 — emitted only by
 *   `CaseService.updateCase`, diffed against the persisted doc),
 *   comment_added (has its own `/comments` route),
 *   knowledge_asset_created, knowledge_asset_status_changed,
 *   knowledge_asset_updated, knowledge_asset_deleted, role_changed,
 *   gate_pending, gate_confirmed, gate_rejected, profile_changed, plus any
 *   type not named below (fail closed on unknown/custom strings too).
 *
 * CLIENT-SAFE (allowed):
 *   pr_merged — the existing "mark PR as merged" manual fallback
 *   (case-header.tsx `handleMarkMerged`, used when the GitHub webhook sync
 *   misses a real merge). Satisfies the same `pr_merged` precondition
 *   (preconditions.ts) the webhook path does; self-reporting it is the same
 *   trust level a case member already has by attaching a PR ref in the
 *   first place, so it stays a deliberate exception rather than a gap.
 */
const CLIENT_EMITTABLE_EVENT_TYPES: ReadonlySet<string> = new Set(['pr_merged']);

export async function GET(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;
    const events = await eventService.getHistory(params.caseId);
    return NextResponse.json({ events });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;
    const body = await request.json();
    const { type, payload } = body as { type: string; payload?: Record<string, unknown> };

    if (!type) {
      return NextResponse.json(
        { error: { message: 'type is required' } },
        { status: 400 },
      );
    }

    if (!CLIENT_EMITTABLE_EVENT_TYPES.has(type)) {
      return NextResponse.json(
        {
          error: {
            message: `Event type '${type}' cannot be posted directly — it is server/pipeline-managed.`,
          },
        },
        { status: 403 },
      );
    }

    const event = await eventService.emit(
      params.caseId,
      type,
      payload ?? {},
      auth.userId,
    );

    // Trigger pipeline to evaluate auto-transitions based on new event
    try {
      const { FirestorePipelineAdapter, RunCompletionHandler } = await import('@arbitra/backend');
      const pipeline = new RunCompletionHandler(new FirestorePipelineAdapter());
      await pipeline.onRunCompleted(params.caseId);
    } catch {
      // Non-critical — event was already persisted
    }

    return NextResponse.json(event, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
