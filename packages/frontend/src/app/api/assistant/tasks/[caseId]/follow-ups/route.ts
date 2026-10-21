import { NextRequest, NextResponse } from 'next/server';
import { AssistantIntakeService, validateBody } from '@arbitra/backend';
import { webAssistantFollowUpSchema } from '@arbitra/shared';
import { authenticate, handleError } from '@/lib/api-helpers';
import { resolveCaseShareUrl } from '@/lib/public-base-url';
import { scheduleAssistantRunDispatch } from '@/lib/assistant-run-dispatch';

export const dynamic = 'force-dynamic';

const intakeService = new AssistantIntakeService();

/** Create a new immutable Clerk Case after one completed parent result. */
export async function POST(request: NextRequest, props: { params: Promise<{ caseId: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const input = validateBody(webAssistantFollowUpSchema, await request.json());
    const result = await intakeService.intakeFollowUp(input, auth.userId, params.caseId);
    if (result.run) scheduleAssistantRunDispatch(result.case, result.run);
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
