import { NextRequest, NextResponse } from 'next/server';
import { RuleRepository } from '@arbitra/backend';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const ruleRepository = new RuleRepository();

export interface HumanConfirmationGate {
  rule_result_id: string;
  rule_id: string;
  rule_name: string;
  message: string;
}

/**
 * Blocked `human_confirmation` RuleResults for the case, enriched with the
 * rule's name so the Courtroom can surface them as an actionable case-level
 * gate (confirm/reject). Only `blocked` results whose rule
 * evaluates in `human_confirmation` mode are returned; other rule modes
 * (metadata_check, llm_evaluation, ...) never appear here.
 */
export async function GET(request: NextRequest, props: { params: Promise<{ caseId: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;

    const results = await ruleRepository.getRuleResultsByCaseId(params.caseId);
    const blocked = results.filter((r) => r.result_status === 'blocked');
    if (blocked.length === 0) {
      const empty: HumanConfirmationGate[] = [];
      return NextResponse.json({ gates: empty });
    }

    const rules = await ruleRepository.getRulesByIds(blocked.map((r) => r.rule_id));
    const ruleById = new Map(rules.map((rule) => [rule.rule_id, rule]));

    const gates: HumanConfirmationGate[] = blocked
      .filter((r) => ruleById.get(r.rule_id)?.evaluation_mode === 'human_confirmation')
      .map((r) => ({
        rule_result_id: r.rule_result_id,
        rule_id: r.rule_id,
        rule_name: ruleById.get(r.rule_id)?.name ?? r.rule_id,
        message: r.message,
      }));

    return NextResponse.json({ gates });
  } catch (error) {
    return handleError(error);
  }
}
