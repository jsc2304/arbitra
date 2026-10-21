import { NextRequest, NextResponse } from 'next/server';
import { CaseService, EvidenceService, CompletenessEvaluator } from '@arbitra/backend';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;

    const caseService = new CaseService();
    const case_ = await caseService.getCase(params.caseId);

    const evidenceService = new EvidenceService();
    const evidence = await evidenceService.getEvidenceForCase(params.caseId);

    const evaluator = new CompletenessEvaluator();
    const result = await evaluator.evaluate(case_, evidence);

    // The evaluator returns required/present/missing but not the full optional
    // list, so resolve it separately from the same effective policy rule the
    // required list came from — for every case type, not just assistant_task.
    // Before this, `optional` came from `getDefaultPolicyRule(...)`, the
    // built-in default, so a project's custom `optional_evidence_types` was
    // silently ignored for any non-assistant case (issue #780); the required
    // and optional halves of this response must describe one resolved policy,
    // not two different sources.
    const policyRule = await evaluator.getEffectivePolicyRule(case_);
    const optional = policyRule.optional_evidence_types;

    return NextResponse.json({
      required: result.required,
      optional,
      present: result.present,
      missing: result.missing,
      satisfied: result.satisfied,
      four_eyes_required: result.four_eyes_required,
      allow_self_approval: result.allow_self_approval,
    });
  } catch (error) {
    return handleError(error);
  }
}
