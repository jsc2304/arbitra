import { NextRequest, NextResponse } from 'next/server';
import { sessionSignalBatchSchema } from '@arbitra/shared';
import { authenticate, handleError, invalidJsonResponse, validationErrorResponse } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// POST /api/signals
//
// Batch ingestion of Session Signal events (issue #983 / ADR-0001): the one
// new write boundary from the "observe by default" spec (#981). No version
// in the URL — each event carries its own `schema_version` and the shape
// evolves additively.
//
// Validation happens per item inside `ingestSessionSignalBatch`, not here:
// the top-level `events` array shape is the only thing this route checks
// before delegating, so one malformed item never sinks the whole batch.
// The endpoint acknowledges immediately with 202 and reports each item's
// outcome. Observed Case resolution (#986) runs AFTER that 202 is decided,
// fire-and-forget — it never delays the response and a failure there can
// never turn an accepted signal into an error: the signal is already
// durably recorded by `ingestSessionSignalBatch` at that point.
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return invalidJsonResponse();
  }

  const parsedEnvelope = sessionSignalBatchSchema.safeParse(rawBody);
  if (!parsedEnvelope.success) {
    return validationErrorResponse('Invalid request payload — expected { events: [...] }', parsedEnvelope.error.issues);
  }

  try {
    // Reuses whatever auth existing API routes use (Bearer PAT or Firebase
    // session) — no new auth mechanism for this boundary. The resolved
    // userId is stamped onto every session this batch touches (issue #990),
    // so the active-sessions panel can count distinct users, not just
    // sessions.
    const auth = await authenticate(request);

    const { ingestSessionSignalBatch, ensureObservedCaseForSignal } = await import('@arbitra/backend');
    const result = await ingestSessionSignalBatch(parsedEnvelope.data.events, { userId: auth.userId });

    // Fire-and-forget, AFTER the ingest result is known — never awaited by
    // the response below. One resolution per distinct (repository, branch)
    // pair among this batch's newly accepted events: a duplicate/rejected
    // item never triggers case resolution, and de-duping in-process avoids
    // redundant claim attempts for a batch that reports on the same branch
    // repeatedly (e.g. session_start + heartbeat in one call).
    const seen = new Set<string>();
    for (const outcome of result.results) {
      if (outcome.status !== 'accepted') continue;
      // `outcome.status === 'accepted'` only ever follows a successful
      // `sessionSignalEventSchema.safeParse` inside `ingestSessionSignalBatch`
      // (the top-level schema above deliberately leaves `events` as
      // `unknown[]` — see the file banner) — so `repository`/`branch` are
      // known to be non-empty strings here.
      const rawEvent = parsedEnvelope.data.events[outcome.index] as
        | { repository: string; branch: string }
        | undefined;
      if (!rawEvent) continue;
      const key = `${rawEvent.repository} ${rawEvent.branch}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ensureObservedCaseForSignal({ repository: rawEvent.repository, branch: rawEvent.branch }).catch(
        (err: unknown) => {
          console.error(
            `[signals] ensureObservedCaseForSignal failed for ${rawEvent.repository}@${rawEvent.branch}:`,
            err,
          );
        },
      );
    }

    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return handleError(error);
  }
}
