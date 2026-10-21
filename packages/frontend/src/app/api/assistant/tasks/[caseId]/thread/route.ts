import { NextRequest, NextResponse } from 'next/server';
import { AssistantFollowUpService } from '@arbitra/backend';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const followUps = new AssistantFollowUpService();

/** Return the requester's dedicated Clerk conversation, never heuristic Related rows. */
export async function GET(request: NextRequest, props: { params: Promise<{ caseId: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    return NextResponse.json(await followUps.getThread(params.caseId, auth.userId));
  } catch (error) {
    return handleError(error);
  }
}
