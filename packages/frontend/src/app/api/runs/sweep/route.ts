import { NextRequest, NextResponse } from 'next/server';
import { RunSweepService } from '@arbitra/backend';
import { handleError } from '@/lib/api-helpers';
import { verifySchedulerOidc } from '@/lib/scheduler-auth';

export const dynamic = 'force-dynamic';

/**
 * Scheduled entrypoint for the Arbitra stale-run sweeper.
 *
 * Auth — OIDC only, same contract as `/api/intelligence/run`:
 *
 *   `Authorization: Bearer <oidc-token>` — Cloud Scheduler attaches a Google
 *   OIDC token signed for the Cloud Run service account. We verify the
 *   signature, audience (full URL), expected SA email, and `email_verified`
 *   via `verifySchedulerOidc`. Any failure → 401 (no fallthrough).
 *
 * If `SCHEDULER_SA_EMAIL(S)` / `SCHEDULER_OIDC_AUDIENCE(S)` are unset the
 * endpoint cannot authenticate anyone and returns 500 — that is a
 * server-side misconfiguration, not a client error.
 *
 * Single-flight: `RunSweepService.sweep()` wraps the actual sweep in a
 * Firestore lock (`run-sweep-lock.ts`) and swallows a lock conflict into
 * `skipped_locked: true` on the (200) response — a concurrent Scheduler
 * retry racing an in-flight sweep is expected/benign, not an error worth a
 * non-2xx status that would trigger Scheduler's own retry/backoff.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const result = await verifySchedulerOidc(request);
    if (!result.ok) {
      if (result.reason === 'oidc_not_configured') {
        console.error(
          '[runs/sweep] OIDC not configured — SCHEDULER_SA_EMAIL and/or SCHEDULER_OIDC_AUDIENCE missing. The endpoint cannot authenticate any caller in this state.',
        );
        return NextResponse.json(
          { error: { code: 'SERVER_MISCONFIGURED', message: 'Scheduler authentication not configured (ARBITRA_CRON_SECRET or OIDC)' } },
          { status: 500 },
        );
      }
      console.warn('[runs/sweep] OIDC verification failed:', result.reason);
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } },
        { status: 401 },
      );
    }

    const service = new RunSweepService();
    const sweepResult = await service.sweep();

    // Assistant sub-sweep counters, reported under their own key: that pass
    // holds a different lock, so its `skipped_locked` is independent of the
    // stale-run one above. Read defensively — a missing block must degrade to
    // "not reported", never to a 500 that makes Scheduler retry a sweep that
    // actually ran.
    const assistant = sweepResult.assistant;

    return NextResponse.json({
      status: 'ok',
      swept_count: sweepResult.swept.length,
      swept: sweepResult.swept,
      // Runs the query flagged stale but that had already legitimately
      // completed/failed by fail-time (CRITICAL finding 1 — race guard).
      skipped_completed: sweepResult.skipped_completed,
      // Durable-retry backstop (HIGH finding 3): overdue persisted retries
      // this sweep dispatched because the in-process timer never fired.
      retries_dispatched_count: sweepResult.retries_dispatched.length,
      retries_dispatched: sweepResult.retries_dispatched,
      skipped_locked: sweepResult.skipped_locked,
      assistant: assistant
        ? {
            claimed_count: assistant.claimed.length,
            claimed: assistant.claimed,
            reattempted_count: assistant.reattempted.length,
            reattempted: assistant.reattempted,
            exhausted_count: assistant.exhausted.length,
            exhausted: assistant.exhausted,
            // Terminal-failure repairs this sweep re-drove because the
            // in-process (best-effort) attempt left its marker set: `repaired`
            // reached a terminal case, `outstanding` did not and will be retried
            // next pass. A non-empty `outstanding` across passes is a stuck case,
            // not routine sweep work.
            failures_repaired_count: assistant.failures_repaired.length,
            failures_repaired: assistant.failures_repaired,
            failures_outstanding_count: assistant.failures_outstanding.length,
            failures_outstanding: assistant.failures_outstanding,
            skipped_claimed: assistant.skipped_claimed,
            skipped_completed: assistant.skipped_completed,
            skipped_locked: assistant.skipped_locked,
          }
        : undefined,
    });
  } catch (error) {
    return handleError(error);
  }
}
