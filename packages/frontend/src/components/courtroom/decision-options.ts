/**
 * Pure helpers for the courtroom decision option lists. Selects which decision
 * types are valid given the case status and whether a finding is selected.
 */

import type { CaseStatus, DecisionType } from '@arbitra/shared';

export interface DecisionOption {
  value: DecisionType;
  label: string;
  description: string;
  tooltip?: string;
}

/**
 * Decision options shown when NO finding is selected — the Courtroom
 * treats these as case-level actions that may trigger a status
 * transition (e.g. `request_changes` sends the case back to `in_build`).
 *
 * Scope captions (`description`) are surfaced under each Tier-1 button so
 * the user sees what the action does to the case before clicking. Waive
 * is no longer in this list — it operates on a finding and is initiated
 * from the Decision panel's per-finding waive list
 * (`decision-cluster/finding-waive-list.tsx`).
 *
 * Escalate temporarily hidden — needs backend semantics defined.
 * Type-level support remains in `DecisionType`
 * + `DECISION_TYPE_LABELS` so historical Escalated decisions keep
 * rendering in the timeline / activity feed.
 */
export const baseCaseLevelOptions: DecisionOption[] = [
  {
    value: 'approve',
    label: 'Approve',
    description: 'Closes the case as approved',
    tooltip:
      'Approve the case and move it forward. All blocking (high/critical open) findings must be waived or resolved first.',
  },
  {
    value: 'request_changes',
    label: 'Request Changes',
    description: 'Returns the case for rework',
    tooltip:
      'Send the case back to in_build so the author can address feedback. This is the case-level action — it transitions the case status.',
  },
  {
    value: 'reject',
    label: 'Reject',
    description: 'Closes the case as rejected',
    tooltip: 'Reject the case entirely. Terminal — the case will not progress.',
  },
];

/**
 * Decision options shown when a finding IS selected — all decisions are
 * scoped to that finding and do NOT transition the case. `request_changes`
 * is renamed to "Flag as blocking" to disambiguate from the case-level
 * "Request Changes" action shown when no finding is selected.
 *
 * Waive is initiated from the Decision panel's per-finding waive list
 * (`decision-cluster/finding-waive-list.tsx`); once the Courtroom enters
 * waive flow it routes through the same RationaleSheet, so the Waive
 * option stays in this list to keep rationale-form wiring intact.
 * Escalate temporarily hidden until its backend semantics are defined.
 */
export const baseFindingLevelOptions: DecisionOption[] = [
  {
    value: 'approve',
    label: 'Mark as resolved',
    description: 'Mark this finding as resolved',
    tooltip: 'Marks only the selected finding as resolved. Does not move the case.',
  },
  {
    value: 'request_changes',
    label: 'Flag as blocking',
    description: 'Keep this finding open; does not transition the case',
    tooltip:
      'Marks this finding as blocking. Does not move the case — use case-level Request Changes (deselect the finding) to send it back for rework.',
  },
  {
    value: 'waive',
    label: 'Waive finding',
    description: 'Accept the risk of this one finding',
    tooltip:
      'Waives a single finding with an audited rationale. The case itself still needs a separate Approve decision.',
  },
  { value: 'reject', label: 'Reject', description: 'Reject the case entirely' },
];

export const verificationPendingOptions: DecisionOption[] = [
  {
    value: 'approve',
    label: 'Approve',
    description: 'Confirm manual verification and approve the case',
    tooltip:
      'For manual-track cases, approving also records the manual validation confirmation. Both decisions are kept in the audit trail.',
  },
  {
    value: 'request_changes',
    label: 'Request Changes',
    description: 'Send back for revisions',
    tooltip:
      'Send the case back to in_build so the author can address feedback.',
  },
  { value: 'reject', label: 'Reject', description: 'Reject the case entirely' },
];

/**
 * Returns the option list for a given (caseStatus × hasFinding) state.
 * Pure: same input → same output, no side effects.
 */
export function getDecisionOptions(
  caseStatus: CaseStatus | undefined,
  hasFinding: boolean,
): DecisionOption[] {
  if (caseStatus === 'verification_pending') return verificationPendingOptions;
  return hasFinding ? baseFindingLevelOptions : baseCaseLevelOptions;
}

/**
 * Color tokens for the decision-type chips. Kept as a Record so the
 * existing `decisionColors[option.value]` access pattern survives the
 * extraction unchanged.
 */
export const decisionColors: Record<string, string> = {
  approve:
    'border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/50',
  manual_validation_confirmed:
    'border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/50',
  request_changes:
    'border-yellow-300 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/50',
  waive:
    'border-gray-300 bg-gray-50 dark:border-border-default dark:bg-surface-raised/50',
  reject: 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/50',
  // Escalate temporarily hidden — needs backend semantics defined.
  // No `escalate` token here: production
  // renderers (decision-history, decision-context-panel, event-timeline,
  // dossier) read chip colors from DECISION_TYPE_LABELS in
  // lib/decision-type-labels.ts, not from this map.
};
