import { NextRequest, NextResponse } from 'next/server';
import { DecisionService, validateBody } from '@arbitra/backend';
import { createDecisionSchema, normalizeActorMetadata } from '@arbitra/shared';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const decisionService = new DecisionService();

export async function POST(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;
    const body = await request.json();
    const input = validateBody(createDecisionSchema, { ...body, case_id: params.caseId });
    // Normalize at the boundary so the persisted shape is consistent regardless
    // of casing or whitespace in the caller payload (mirrors the comments route).
    const actorMetadata = normalizeActorMetadata(input.actor_metadata);
    const result = await decisionService.createDecision(
      { ...input, actor_metadata: actorMetadata },
      auth.userId,
    );
    // Body shape: the Decision (legacy/back-compat top-level fields) plus an
    // optional `transition_error` field when the post-decision state-machine
    // transition failed (e.g. preconditions not met). The decision itself is
    // still persisted in that case — the UI shows a non-fatal warning instead
    // of treating the request as a failure.
    return NextResponse.json(
      result.transition_error
        ? { ...result.decision, transition_error: result.transition_error }
        : result.decision,
      { status: 201 },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function GET(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;
    const decisions = await decisionService.getDecisionsForCase(params.caseId);
    return NextResponse.json({ decisions });
  } catch (error) {
    return handleError(error);
  }
}
