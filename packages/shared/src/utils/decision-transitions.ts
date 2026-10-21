import type { DecisionType, CaseStatus } from '../types/index.js';

/**
 * Determine the target case status for a case-level decision (no finding_id).
 * Returns null if the decision type does not imply a direct state transition
 * from the current status (e.g. waive/escalate, or finding-level decisions).
 */
export function resolveTransitionTarget(
  decisionType: DecisionType,
  currentStatus: CaseStatus,
): CaseStatus | null {
  if (decisionType === 'reject') {
    return 'rejected';
  }
  if (decisionType === 'approve' && currentStatus === 'needs_human_decision') {
    return 'approved';
  }
  if (decisionType === 'approve' && currentStatus === 'in_review') {
    return 'approved';
  }
  // Manual-track UX: "Approve" button on verification_pending is the same
  // user intent as confirming manual validation. The decision-service
  // auto-attaches a `manual_validation_confirmed` decision before the
  // approve, satisfying the transition precondition.
  if (decisionType === 'approve' && currentStatus === 'verification_pending') {
    return 'approved';
  }
  if (decisionType === 'request_changes' && currentStatus === 'in_review') {
    return 'in_build';
  }
  if (decisionType === 'request_changes' && currentStatus === 'needs_human_decision') {
    return 'in_build';
  }
  if (decisionType === 'request_changes' && currentStatus === 'in_validation') {
    return 'in_build';
  }
  if (decisionType === 'request_changes' && currentStatus === 'pending_merge') {
    return 'in_build';
  }
  if (decisionType === 'request_changes' && currentStatus === 'verification_pending') {
    return 'in_build';
  }
  if (decisionType === 'manual_validation_confirmed' && currentStatus === 'verification_pending') {
    return 'approved';
  }
  // Merge-not-applicable track (issue #687): recovery path for cases whose
  // implementation lives outside any repository (no PR will ever arrive).
  // Recording the decision completes the case. The transition itself stays
  // gated by the `merge_not_applicable` precondition, which hard-fails for
  // cases with a PR ref — `pr_merged` remains required for real PRs.
  if (decisionType === 'merge_not_applicable' && currentStatus === 'pending_merge') {
    return 'done';
  }
  if (decisionType === 'merge_not_applicable' && currentStatus === 'approved') {
    return 'done';
  }
  return null;
}
