import { NextRequest, NextResponse } from 'next/server';
import { TaskBlueprintService } from '@arbitra/backend';
import { authenticate, handleError } from '@/lib/api-helpers';
import { resolveCaseShareUrl } from '@/lib/public-base-url';
import { scheduleAssistantRunDispatch } from '@/lib/assistant-run-dispatch';

export const dynamic = 'force-dynamic';

const blueprintService = new TaskBlueprintService();

/**
 * `POST /api/assistant/blueprints/[blueprintId]/run` — run-now.
 *
 * The only surface where a blueprint occurrence is triggered behind
 * `authenticate()` (the tick service calls the same
 * `TaskBlueprintService.runNow` from a Cloud Scheduler OIDC request, with no
 * user token to authenticate). `TaskBlueprintService.get` — reached via
 * `runNow` — is what turns a foreign blueprint into a 403; an archived one
 * into a 409 (`TASK_BLUEPRINT_ARCHIVED`); and a non-terminal prior occurrence
 * into a 409 (`TASK_BLUEPRINT_OVERLAP`, carrying the existing `case_id` in
 * `error.details`) with no intake attempted.
 *
 * Response shape mirrors `POST /api/assistant/tasks`: the dispatch is the
 * same fire-and-forget hand-off to the in-process executor, skipped on a
 * replay because the original request already dispatched it.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ blueprintId: string }> },
): Promise<NextResponse> {
  const { blueprintId } = await params;
  try {
    const auth = await authenticate(request);
    const result = await blueprintService.runNow(blueprintId, auth.userId);

    if (result.run) {
      scheduleAssistantRunDispatch(result.case, result.run);
    }

    const share_url = resolveCaseShareUrl(request, result.case.case_id, result.case.status);
    return NextResponse.json(
      {
        case_id: result.case.case_id,
        run_id: result.run_id,
        status: result.case.status,
        replayed: result.replayed,
        ...(share_url ? { share_url } : {}),
      },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (error) {
    return handleError(error);
  }
}
