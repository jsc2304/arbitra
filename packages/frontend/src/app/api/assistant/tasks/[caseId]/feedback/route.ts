import { NextRequest, NextResponse } from 'next/server';
import { AssistantFeedbackService, validateBody } from '@arbitra/backend';
import { assistantFeedbackRequestSchema } from '@arbitra/shared';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const feedback = new AssistantFeedbackService();

export async function GET(request: NextRequest, props: { params: Promise<{ caseId: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    return NextResponse.json({ feedback: await feedback.get(params.caseId, auth.userId) });
  } catch (error) {
    return handleError(error);
  }
}

export async function PUT(request: NextRequest, props: { params: Promise<{ caseId: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const input = validateBody(assistantFeedbackRequestSchema, await request.json());
    return NextResponse.json(await feedback.record(params.caseId, auth.userId, input));
  } catch (error) {
    return handleError(error);
  }
}
