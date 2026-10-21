import { getDefaultPolicyRule } from '@arbitra/shared';
import type { Case } from '@arbitra/shared';

/** The one `CompletenessEvaluator` method this needs, so a route passes its own. */
interface EffectivePolicyResolver {
  getEffectivePolicyRule(case_: Case): Promise<{ optional_evidence_types: string[] }>;
}

/**
 * The optional-evidence list for the two routes that publish one:
 * `GET /api/cases/:id/evidence/requirements` (the browser's Proof tab) and
 * `GET /api/agent/context/:caseId` (an IDE agent's case brief).
 *
 * `CompletenessEvaluator.evaluate` returns required/present/missing but no
 * optional list, so both callers filled it from the built-in default rule. For
 * an `assistant_task` that default is wrong rather than approximate: the Clerk
 * policy sets `optional_evidence_types: []` in both of its cells
 * (`clerk-core-documents.ts`), while the default direct-track rule offers
 * test/lint/diff evidence a Clerk task can never produce — so a finished case
 * reads as unfinished. Resolving the case's real policy cell for that type is
 * the fix, and it has to hold for both consumers: an agent reading a Clerk case
 * and a person reading it must not be told different things about it.
 *
 * Every other case type keeps the default-based list byte for byte. That path
 * has its own defect — a project with a stored custom policy is still answered
 * from the built-in default — but correcting it would change what engineering
 * cases display, so it stays as it is here.
 *
 * One function rather than the same expression in both routes, because the same
 * expression in both routes is what let them disagree in the first place.
 */
export async function optionalEvidenceTypes(
  case_: Case,
  resolver: EffectivePolicyResolver,
): Promise<string[]> {
  if (case_.case_type === 'assistant_task') {
    return (await resolver.getEffectivePolicyRule(case_)).optional_evidence_types;
  }
  return getDefaultPolicyRule(case_.validation_track, case_.risk_level).optional_evidence_types;
}
