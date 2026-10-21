import { NextRequest, NextResponse } from 'next/server';
import {
  AssistantCancellationService,
  validateBody,
} from '@arbitra/backend';
import { assistantCancelRequestSchema } from '@arbitra/shared';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const cancellationService = new AssistantCancellationService();

/**
 * Stop one exact Clerk attempt. The service verifies that the named Run is
 * still active, then atomically fences every overlapping task attempt on the
 * Case under one revision. A stale tab therefore receives 409 instead of
 * silently cancelling a newer retry it never displayed.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ caseId: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;

    const input = validateBody(assistantCancelRequestSchema, await request.json());
    const result = await cancellationService.cancel(
      params.caseId,
      auth.userId,
      input.run_id,
    );
    const intent = result.case.assistant_cancel_intent!;
    return NextResponse.json({
      case_id: result.case.case_id,
      target_run_id: result.target_run_id,
      cancelled_run_ids: result.run_ids,
      pending_reconciliation_run_ids: result.pending_reconciliation_run_ids,
      status: result.case.status,
      cancel_revision: result.revision,
      requested_at: intent.requested_at,
      requested_by: intent.requested_by,
      replayed: result.replayed,
    });
  } catch (error) {
    return handleError(error);
  }
}
