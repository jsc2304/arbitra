import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';
import { isAssistantRunType, type RunType } from '@arbitra/shared';

/**
 * Run types a caller may never force-complete through this route — either
 * because completion carries governance weight (`review_run` feeds
 * `review_run_completed` / `auto_approve_criteria_met`, which drive the
 * mandatory-review gate straight to `in_review -> approved`), or because a
 * dedicated worker is the run's only legitimate completer
 * (`assistant_task_run` / `assistant_action_run`, executed and completed
 * in-process by `RunExecutor` — see `isAssistantRunType`, mirrored from
 * `POST /api/runs`'s own refusal of the same types).
 *
 * Issue #1047 (door 1): this route used to be gated only by
 * `requireCaseAccess` — no `run_type` filter, no role check, no
 * worker/lease check — so any project member could read a review run's id
 * off `GET /api/cases/:caseId/runs` and force it from `running` straight to
 * `completed` before the LLM call it was created for ever returned,
 * satisfying the review-gate preconditions on a review that never ran.
 *
 * A genuine need to force a stuck review to a stop must go through the
 * role-gated `review_not_applicable` decision (reviewer/tech_lead/admin —
 * `anti-gaming.ts` `checkReviewNotApplicablePermission`), which already
 * exists for exactly this and is audited as a Decision — not through an
 * unconditional status flip here.
 */
function isClientCompletableRunType(runType: RunType): boolean {
  return runType !== 'review_run' && !isAssistantRunType(runType);
}

export async function POST(request: NextRequest, props: { params: Promise<{ runId: string }> }) {
  const params = await props.params;
  try {
    const body = await request.json();
    const { summary } = body as { summary?: string };
    const { runId } = params;

    // Production mode
    const auth = await authenticate(request);
    const { collections, FirestorePipelineAdapter, RunCompletionHandler } = await import('@arbitra/backend');

    // Never trust a client-supplied case_id (body.case_id) for the access
    // check — load the run doc and resolve the case from what's actually
    // stored, matching decisions/route.ts's requireCaseAccess pattern.
    const runSnap = await collections.runs().doc(runId).get();
    if (!runSnap.exists) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Run not found' } },
        { status: 404 },
      );
    }
    const existingRun = runSnap.data()!;
    // Issue #749 item 4: an absent/empty `case_id` on the stored run doc
    // (corrupt data, or a run created before `case_id` was required) would
    // otherwise reach `requireCaseAccess` -> `checkCaseAccess`, which calls
    // Firestore's `.doc('')` and throws synchronously — an unhandled error
    // that `handleError` turns into an ungraceful 500 instead of the 404 a
    // run whose case can't be resolved should return.
    if (!existingRun.case_id) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Run not found' } },
        { status: 404 },
      );
    }
    const denied = await requireCaseAccess(existingRun.case_id, auth.userId);
    if (denied) return denied;

    if (!isClientCompletableRunType(existingRun.run_type)) {
      return NextResponse.json(
        {
          error: {
            code: 'RUN_TYPE_NOT_CLIENT_COMPLETABLE',
            message:
              `run_type '${existingRun.run_type}' cannot be force-completed through this route. `
              + (existingRun.run_type === 'review_run'
                ? 'To skip a stuck review, file a review_not_applicable decision instead (requires reviewer, tech_lead, or admin).'
                : 'It is completed exclusively by its owning worker.'),
          },
        },
        { status: 403 },
      );
    }

    const adapter = new FirestorePipelineAdapter();
    const pipeline = new RunCompletionHandler(adapter);

    const run = await adapter.completeRun(runId, existingRun.case_id, summary ?? 'Completed');
    const pipelineResult = await pipeline.onRunCompleted(run.case_id);

    return NextResponse.json({
      run,
      case_transitioned: pipelineResult.transitions.length > 0,
      new_status: pipelineResult.final_status,
      next_actions: pipelineResult.next_actions,
    });
  } catch (error) {
    return handleError(error);
  }
}
