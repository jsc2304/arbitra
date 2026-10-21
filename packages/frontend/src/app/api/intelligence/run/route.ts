import { NextRequest, NextResponse } from 'next/server';
import { IntelligenceService, ALL_DETECTORS, IntelligenceLockHeldError } from '@arbitra/backend';
import { handleError } from '@/lib/api-helpers';
import { verifySchedulerOidc } from '@/lib/scheduler-auth';

export const dynamic = 'force-dynamic';

/**
 * Scheduled entrypoint for the Arbitra Code Intelligence scheduler.
 *
 * Auth — OIDC only:
 *
 *   `Authorization: Bearer <oidc-token>` — Cloud Scheduler attaches a Google
 *   OIDC token signed for the Cloud Run service account. We verify the
 *   signature, audience (full URL), expected SA email, and `email_verified`
 *   via `verifySchedulerOidc`. Any failure → 401 (no fallthrough).
 *
 * If `SCHEDULER_SA_EMAIL` / `SCHEDULER_OIDC_AUDIENCE` are unset the endpoint
 * cannot authenticate anyone and returns 500 — that is a server-side
 * misconfiguration, not a client error. The previous shared-secret fallback
 * path was removed once OIDC was verified working on deployed dev.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const result = await verifySchedulerOidc(request);
    if (!result.ok) {
      if (result.reason === 'oidc_not_configured') {
        console.error(
          '[intelligence/run] OIDC not configured — SCHEDULER_SA_EMAIL and/or SCHEDULER_OIDC_AUDIENCE missing. The endpoint cannot authenticate any caller in this state.',
        );
        return NextResponse.json(
          { error: { code: 'SERVER_MISCONFIGURED', message: 'Scheduler authentication not configured (ARBITRA_CRON_SECRET or OIDC)' } },
          { status: 500 },
        );
      }
      console.warn('[intelligence/run] OIDC verification failed:', result.reason);
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } },
        { status: 401 },
      );
    }

    const service = new IntelligenceService(ALL_DETECTORS);
    let summaries;
    try {
      summaries = await service.run();
    } catch (err) {
      if (err instanceof IntelligenceLockHeldError) {
        // Cloud Scheduler retries can race a still-running invocation.
        // Respond 409 so the scheduler marks this attempt as handled without
        // triggering further retry escalations.
        return NextResponse.json(
          { error: 'intelligence_run_in_progress' },
          { status: 409 },
        );
      }
      throw err;
    }
    const total = summaries.reduce(
      (acc, s) => {
        acc.cases_created += s.cases_created;
        acc.cases_skipped_existing += s.cases_skipped_existing;
        acc.errors += s.error ? 1 : 0;
        return acc;
      },
      { cases_created: 0, cases_skipped_existing: 0, errors: 0 },
    );

    return NextResponse.json({
      status: 'ok',
      summaries,
      total,
    });
  } catch (error) {
    return handleError(error);
  }
}
