import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';

export async function POST(request: NextRequest, props: { params: Promise<{ runId: string }> }) {
  const params = await props.params;
  try {
    const body = await request.json();
    const { error: errorMessage } = body as { error?: string };
    const { runId } = params;

    // Production
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

    const adapter = new FirestorePipelineAdapter();
    const run = await adapter.failRun(runId, existingRun.case_id, errorMessage ?? 'Unknown error');
    const pipeline = new RunCompletionHandler(adapter);
    await pipeline.onRunCompleted(run.case_id);

    return NextResponse.json({ run });
  } catch (error) {
    return handleError(error);
  }
}
