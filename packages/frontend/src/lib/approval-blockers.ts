/**
 * Pure blocker-selection logic behind `/api/cases/[caseId]/approval-blockers`.
 *
 * Lives here (not in `route.ts`) because Next.js App Router route modules may
 * only export a fixed set of route fields (`GET`, `dynamic`, …) — exporting a
 * helper like `selectApprovalBlockers` from `route.ts` fails the `next build`
 * route-type check. Keeping it in `lib` also lets the unit test import it
 * without pulling the route's Firestore-backed services.
 */
import type { PreconditionId } from '@arbitra/shared';

/**
 * Preconditions surfaced to the human reviewer as "approval blockers".
 *
 * Deliberately EXCLUDES `human_approve_documented`: that is the action the
 * reviewer is about to take (clicking Approve), not a precondition standing
 * in their way. Surfacing it pre-approval would read as "No human approve
 * decision documented", which is confusing — the reviewer hasn't approved
 * *yet*, that's the whole point of the panel.
 *
 * The remaining ids are the genuine gate blockers for the two approve-target
 * transitions (`needs_human_decision → approved`,
 * `verification_pending → approved`).
 */
export const APPROVAL_BLOCKER_IDS: ReadonlySet<PreconditionId> = new Set<PreconditionId>([
  'all_high_critical_resolved',
  'required_evidence_satisfied',
  'four_eyes_if_required',
  'manual_validation_confirmed',
]);

/** Humanize a precondition id for the rare case the evaluator omits a reason. */
export function humanizePreconditionId(id: PreconditionId): string {
  return id.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export interface ApprovalBlocker {
  id: PreconditionId;
  reason: string;
}

/**
 * Pure mapping from evaluated preconditions → reviewer-facing blockers.
 *
 * Filters to the unsatisfied preconditions that belong in the panel
 * (drops `human_approve_documented` and any non-blocker id), and resolves a
 * human-readable reason for each. Extracted so the filtering contract can be
 * unit-tested without Firestore.
 */
export function selectApprovalBlockers(
  preconditionIds: readonly PreconditionId[],
  results: ReadonlyMap<PreconditionId, { satisfied: boolean; reason?: string }>,
): ApprovalBlocker[] {
  const blockers: ApprovalBlocker[] = [];
  for (const id of preconditionIds) {
    if (!APPROVAL_BLOCKER_IDS.has(id)) continue;
    const result = results.get(id);
    // Missing result → treat as unsatisfied (fail visible, not silent).
    if (result?.satisfied) continue;
    blockers.push({
      id,
      reason: result?.reason ?? humanizePreconditionId(id),
    });
  }
  return blockers;
}
