import type { Case, Decision, Finding, Project, UserRole } from '@arbitra/shared';
import { ForbiddenError } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';
import { isHighRisk } from '@arbitra/shared';

/**
 * Self-approval prohibition: owner_user_id cannot be the sole approver
 * for high/critical risk cases (four-eyes principle).
 * Low/medium risk cases allow self-approval.
 *
 * Opt-out: when `allowSelfApproval` is true (resolved from the effective
 * evidence-policy cell for the case's risk × track), the check is skipped
 * entirely. This permits projects to unlock self-approval per specific cell
 * without weakening the global rule. Default (undefined/false) preserves the
 * historical strict behavior.
 *
 * Note: this flag is orthogonal to `checkFourEyes()`. Four-eyes still requires
 * two distinct approvers on high/critical; the owner may now count as one of
 * the two, but a second distinct human is still required.
 */
export function checkSelfApprovalProhibition(
  case_: Case,
  actorId: string,
  decisionType: Decision['type'],
  allowSelfApproval = false,
): void {
  if (decisionType === 'auto_approve') return; // System-generated, OK
  if (decisionType !== 'approve') return; // Only relevant for approve
  if (!isHighRisk(case_.risk_level)) return; // Low/medium risk: self-approval allowed
  if (allowSelfApproval) return; // Policy opt-out for this risk/track cell

  if (case_.owner_user_id === actorId) {
    throw new ForbiddenError(
      'Self-approval is not permitted for high/critical risk cases (four-eyes principle).',
      { case_id: case_.case_id, owner: case_.owner_user_id, actor: actorId, risk_level: case_.risk_level },
    );
  }
}

/**
 * Waive permission check by severity:
 * - high/critical: only reviewer/approver or tech_lead
 * - medium: reviewer/approver, tech_lead, or owner with rationale
 * - low/info: owner can waive
 */
export async function checkWaivePermission(
  finding: Finding,
  actorId: string,
  case_: Case,
  rationale: string,
): Promise<void> {
  const userDoc = await collections.users().doc(actorId).get();
  const userRoles: UserRole[] = userDoc.exists ? userDoc.data()!.roles : [];

  const isReviewerOrLead = userRoles.some(
    (r) => r === 'reviewer' || r === 'tech_lead' || r === 'admin',
  );
  const isOwner = case_.owner_user_id === actorId;

  if (finding.severity === 'high' || finding.severity === 'critical') {
    if (!isReviewerOrLead) {
      throw new ForbiddenError(
        'Only reviewer, tech lead, or admin can waive high/critical findings',
        { severity: finding.severity },
      );
    }
  } else if (finding.severity === 'medium') {
    if (!isReviewerOrLead && !isOwner) {
      throw new ForbiddenError(
        'Only reviewer, tech lead, or case owner can waive medium findings',
      );
    }
    if (isOwner && !isReviewerOrLead && !rationale) {
      throw new ForbiddenError(
        'Case owner must provide rationale to waive medium findings',
      );
    }
  }
  // low/info: anyone can waive (owner at minimum)
}

/**
 * Permission check for a `review_not_applicable` decision (human escape
 * hatch for a case stuck in `in_review` after a permanently-failed review
 * run — see issue tracking the `Case.review_not_applicable` bypass). Actor
 * must be a reviewer, tech lead, or admin. Severity-independent (unlike
 * `checkWaivePermission`) — this bypasses the review-run precondition, not
 * a specific finding's severity.
 *
 * Role resolution combines both mechanics already used elsewhere for
 * confirmer-style gates:
 *   - global `admin` role, read from the user doc (mirrors
 *     `checkWaivePermission`'s `collections.users()` lookup);
 *   - project-scoped `reviewer_pool` / `tech_leads` membership (mirrors
 *     `DecisionService.checkConfirmerRole`'s gate-confirm role check).
 *
 * The case owner MAY file this decision if they also hold one of these
 * roles — this is an operational unblock, not an approval. The normal
 * approval anti-gaming (`checkSelfApprovalProhibition`, four-eyes) still
 * applies downstream when the case actually advances to `approved`.
 */
export async function checkReviewNotApplicablePermission(
  case_: Case,
  actorId: string,
  project: Project | null,
): Promise<void> {
  const userDoc = await collections.users().doc(actorId).get();
  const userRoles: UserRole[] = userDoc.exists ? userDoc.data()!.roles : [];
  const isAdmin = userRoles.includes('admin');
  const isProjectReviewer = project?.reviewer_pool?.includes(actorId) ?? false;
  const isProjectTechLead = project?.tech_leads?.includes(actorId) ?? false;

  if (!isAdmin && !isProjectReviewer && !isProjectTechLead) {
    throw new ForbiddenError(
      'Only reviewer, tech lead, or admin can mark a case review_not_applicable.',
      { case_id: case_.case_id, actor: actorId },
    );
  }
}

/**
 * Risk downgrade audit: generates a finding when risk is downgraded from high/critical.
 */
export function shouldCreateRiskDowngradeAudit(
  oldLevel: Case['risk_level'],
  newLevel: Case['risk_level'],
): boolean {
  return isHighRisk(oldLevel) && !isHighRisk(newLevel);
}
