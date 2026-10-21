/**
 * Single source of truth for human-readable case-status labels.
 *
 * Two canonical forms, both exported:
 *
 * - {@link CASE_STATUS_LABELS}       — long form for banners & context panels
 *                                      (e.g. `'Ready for Build'`)
 * - {@link CASE_STATUS_LABELS_SHORT} — short form for dense list/card UI
 *                                      (e.g. `'Ready'`)
 *
 * Previous code duplicated the long form inline in `case-header-gate-banner`
 * and `decision-context-panel`, and the short form inline in `status-badge`.
 * Having both as a typed `Record<CaseStatus, string>` makes drift on new
 * statuses structurally impossible.
 */

import type { CaseStatus, CaseType } from '@arbitra/shared';

/** Long-form label for banners, context panels, and prose. */
export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  open: 'Open',
  exploration: 'Exploration',
  ready_for_build: 'Ready for Build',
  in_build: 'Building',
  in_validation: 'Validating',
  in_review: 'In Review',
  needs_human_decision: 'Needs Decision',
  verification_pending: 'Verification Pending',
  approved: 'Approved',
  pending_merge: 'Pending Merge',
  done: 'Done',
  rejected: 'Rejected',
};

/** Short-form label for dense UI (status badges in list/card views). */
export const CASE_STATUS_LABELS_SHORT: Record<CaseStatus, string> = {
  open: 'Open',
  exploration: 'Exploring',
  ready_for_build: 'Ready',
  in_build: 'Building',
  in_validation: 'Validating',
  in_review: 'AI Review',
  needs_human_decision: 'Decide',
  verification_pending: 'Verify',
  approved: 'Approved',
  pending_merge: 'Merge PR',
  done: 'Done',
  rejected: 'Rejected',
};

/**
 * Observed Case label overrides (issue #1018 / ADR-0001): `in_build` reads
 * as "Building" everywhere else, but an Observed Case never builds anything
 * itself — it is a passive record of activity Arbitra noticed. "Observing"
 * is the honest label for that status while `case_type: 'observed'`. Every
 * other status keeps its normal label — an Observed Case's `open` and
 * `done` mean the same thing they mean for any other case.
 */
const OBSERVED_STATUS_LABEL_OVERRIDES: Partial<Record<CaseStatus, string>> = {
  in_build: 'Observing',
};

/**
 * Resolve the short-form status label for a case, honoring the Observed
 * Case override above when `caseType` is `'observed'`. Single seam so
 * `StatusBadge` and the lifecycle rail can never drift on what an Observed
 * Case's status reads as (issue #1018 AC 3 — Mission Control included,
 * since it renders the same `StatusBadge`).
 */
export function caseStatusLabelShort(status: CaseStatus, caseType?: CaseType): string {
  if (caseType === 'observed') {
    return OBSERVED_STATUS_LABEL_OVERRIDES[status] ?? CASE_STATUS_LABELS_SHORT[status];
  }
  return CASE_STATUS_LABELS_SHORT[status];
}
