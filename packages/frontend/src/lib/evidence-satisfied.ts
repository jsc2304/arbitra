/**
 * Shared helper for the "evidence requirements satisfied" check.
 *
 * A case is considered to have satisfied evidence requirements if either:
 *   - the case has progressed past validation (lifecycle implies requirements
 *     were met at the time it moved forward), OR
 *   - the evidence endpoint reports `satisfied: true`.
 *
 * Used by both the Proof accordion header and the standalone
 * `<EvidenceSatisfiedPill>` inside `EvidencePanel`-adjacent contexts.
 */

/**
 * Case statuses that sit after the validation step in the lifecycle.
 * If the case has reached any of these, evidence requirements are by
 * definition satisfied (it couldn't have progressed otherwise).
 */
export const POST_VALIDATION_STATUSES: readonly string[] = [
  'in_review',
  'needs_human_decision',
  'verification_pending',
  'approved',
  'pending_merge',
  'rejected',
  'done',
];

interface EvidenceSatisfiedInput {
  /** Response shape from `api.cases.evidence()` — only the `satisfied` flag is read. */
  satisfied?: boolean;
}

export function isEvidenceSatisfied(
  caseStatus: string | undefined,
  evidenceData: EvidenceSatisfiedInput | undefined,
): boolean {
  const isPastValidation = caseStatus ? POST_VALIDATION_STATUSES.includes(caseStatus) : false;
  return isPastValidation || (evidenceData?.satisfied ?? false);
}
