import type { Case, Decision } from '@arbitra/shared';

export interface FourEyesResult {
  required: boolean;
  satisfied: boolean;
  approverIds: string[];
  reason?: string;
}

/**
 * Evidence-policy flags resolved for a case (via `CompletenessEvaluator`
 * or equivalent). Consumed here so four-eyes enforcement is driven by the
 * same per-(risk, track) policy cell users configure in
 * Settings → Projects → Evidence Policy, not by hardcoded risk heuristics.
 */
export interface FourEyesPolicy {
  four_eyes_required: boolean;
  allow_self_approval: boolean;
}

/**
 * Checks if four-eyes is satisfied for a case given the resolved evidence
 * policy. Behavior:
 * - `four_eyes_required: false` → always satisfied (owner alone is fine);
 *   returns all unique approver ids seen so callers can still audit.
 * - `four_eyes_required: true` → at least 2 distinct approvers.
 * - `four_eyes_required: true` + `allow_self_approval: false` → additionally
 *   requires at least one approver to differ from the case owner.
 * - `four_eyes_required: true` + `allow_self_approval: true` → owner counts
 *   as a valid approver; only the distinct-count check applies.
 */
export function checkFourEyes(
  case_: Case,
  decisions: Decision[],
  policy: FourEyesPolicy,
): FourEyesResult {
  const approverIds = new Set<string>();
  for (const d of decisions) {
    if (d.type === 'approve' || d.type === 'manual_validation_confirmed') {
      approverIds.add(d.actor_id);
    }
  }
  const uniqueApprovers = Array.from(approverIds);

  if (!policy.four_eyes_required) {
    return { required: false, satisfied: true, approverIds: uniqueApprovers };
  }

  if (uniqueApprovers.length < 2) {
    return {
      required: true,
      satisfied: false,
      approverIds: uniqueApprovers,
      reason: `Four-eyes required per evidence policy: need 2 distinct approvers, found ${uniqueApprovers.length}`,
    };
  }

  if (!policy.allow_self_approval) {
    const nonOwnerApprovers = uniqueApprovers.filter((id) => id !== case_.owner_user_id);
    if (nonOwnerApprovers.length < 1) {
      return {
        required: true,
        satisfied: false,
        approverIds: uniqueApprovers,
        reason: 'Four-eyes required per evidence policy: at least one approver must differ from the case owner (allow_self_approval=false)',
      };
    }
  }

  return {
    required: true,
    satisfied: true,
    approverIds: uniqueApprovers,
  };
}
