import { NextRequest, NextResponse } from 'next/server';
import { BlueprintTickService } from '@arbitra/backend';
import { handleError } from '@/lib/api-helpers';
import { verifySchedulerOidc } from '@/lib/scheduler-auth';
import { scheduleAssistantRunDispatch } from '@/lib/assistant-run-dispatch';

export const dynamic = 'force-dynamic';

const tickService = new BlueprintTickService();

/**
 * Scheduled entrypoint for the Task Blueprint cron tick
 * (`docs/specs/clerk-config-scheduling-chat.md` Slice B, #793 v2).
 *
 * Auth — OIDC only, same contract as `/api/runs/sweep`:
 *
 *   `Authorization: Bearer <oidc-token>` — Cloud Scheduler attaches a Google
 *   OIDC token signed for the Cloud Run service account. `verifySchedulerOidc`
 *   verifies signature, audience, SA email, and `email_verified`. Any
 *   failure → 401, before `BlueprintTickService` (and therefore Firestore) is
 *   ever touched. Missing env config → 500 (server misconfiguration, not a
 *   client error — mirrors `/api/runs/sweep`).
 *
 * A normally-empty tick (no due occurrences) is 200, not a 4xx/5xx — an
 * empty tick is the overwhelmingly common case (most 5-minute windows have
 * nothing due) and must never cause Cloud Scheduler to treat it as failed
 * and retry. Per-blueprint errors are likewise reported inside the 200 body
 * (`errors[]`) rather than surfaced as an HTTP error status:
 * `BlueprintTickService.tick` already isolates them per blueprint, so one
 * bad blueprint must not make Scheduler retry the whole tick and re-evaluate
 * every OTHER (successfully-ticked) blueprint's window a second time. Only a
 * failure of the tick call itself (e.g. the candidate-blueprint query
 * throwing) reaches `handleError` and becomes a 5xx.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const result = await verifySchedulerOidc(request);
    if (!result.ok) {
      if (result.reason === 'oidc_not_configured') {
        console.error(
          '[blueprints/tick] OIDC not configured — SCHEDULER_SA_EMAIL and/or SCHEDULER_OIDC_AUDIENCE missing. The endpoint cannot authenticate any caller in this state.',
        );
        return NextResponse.json(
          { error: { code: 'SERVER_MISCONFIGURED', message: 'Scheduler authentication not configured (ARBITRA_CRON_SECRET or OIDC)' } },
          { status: 500 },
        );
      }
      console.warn('[blueprints/tick] OIDC verification failed:', result.reason);
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } },
        { status: 401 },
      );
    }

    const summary = await tickService.tick(new Date());

    // Fire-and-forget dispatch, one per newly created occurrence — same
    // hand-off `POST /api/assistant/blueprints/[id]/run` uses. Kept out of
    // `BlueprintTickService` itself: `scheduleAssistantRunDispatch` lives in
    // this frontend package (it lazy-imports the in-process executor), so
    // the backend service returns the case/run pairs and this route is the
    // one place that performs the dispatch.
    for (const dispatch of summary.dispatches) {
      scheduleAssistantRunDispatch(dispatch.case, dispatch.run);
    }

    return NextResponse.json({
      status: 'ok',
      due: summary.due,
      created: summary.created,
      skipped_overlap: summary.skipped_overlap,
      replayed: summary.replayed,
      errors: summary.errors,
    });
  } catch (error) {
    return handleError(error);
  }
}
