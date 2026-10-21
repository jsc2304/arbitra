import { NextRequest, NextResponse } from 'next/server';
import { EvidenceService, validateBody, safeHeartbeat, CaseService } from '@arbitra/backend';
import { createEvidenceSchema } from '@arbitra/shared';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';
import { resolveCaseShareUrl } from '@/lib/public-base-url';

export const dynamic = 'force-dynamic';

const caseService = new CaseService();

export async function POST(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;

    // Heartbeat: token-auth → ide_agent, firebase → web (see agent-presence spec).
    await safeHeartbeat({
      caseId: params.caseId,
      userId: auth.userId,
      source: auth.authType === 'token' ? 'ide_agent' : 'web',
    });

    const body = await request.json();
    const input = validateBody(createEvidenceSchema, { ...body, case_id: params.caseId });

    // Create EvidenceService with pipeline adapter so evidence registration
    // triggers auto-transition re-evaluation (e.g. in_validation → in_review)
    const { FirestorePipelineAdapter } = await import('@arbitra/backend');
    const adapter = new FirestorePipelineAdapter();
    const evidenceService = new EvidenceService(undefined, undefined, undefined, undefined, adapter);

    const evidence = await evidenceService.registerEvidence(input, auth.userId);

    // Surface a status-aware deep link so MCP clients can hand it back to the
    // human user. Best-effort: a status lookup failure must not break the POST.
    let share_url: string | null = null;
    try {
      const caseData = await caseService.getCase(params.caseId);
      share_url = resolveCaseShareUrl(request, caseData.case_id, caseData.status);
    } catch (error) {
      // Degraded Firestore should stay visible; share_url is silently omitted.
      console.warn('[share_url] failed to attach to evidence response', {
        case_id: params.caseId,
        error,
      });
    }

    return NextResponse.json(
      share_url !== null ? { ...evidence, share_url } : evidence,
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
    const evidenceService = new EvidenceService();
    const evidence = await evidenceService.getEvidenceForCase(params.caseId);
    return NextResponse.json({ evidence });
  } catch (error) {
    return handleError(error);
  }
}
