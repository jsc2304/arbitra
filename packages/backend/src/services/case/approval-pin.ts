import type { Case, CaseStatus } from '@arbitra/shared';
import { FieldValue } from 'firebase-admin/firestore';

/**
 * The single place that decides what `Case.approved_head_sha` is (issue
 * #1045).
 *
 * ## Why this is a module and not inlined
 *
 * There is NO universal write path for a case's status in this product —
 * a claim that has now been wrong twice, once in a PR body and once in the
 * first cut of this fix, and both times it hid a real hole. Three sites
 * write `status` today:
 *
 *   1. `applyTransitionInTransaction` (`transition-core.ts`) — reached by
 *      `OrchestrationService.transition`, i.e. every human decision.
 *   2. `Pipeline.executeTransition` — the autonomous auto-approve
 *      (`in_review → approved`), straight through `adapter.updateCaseStatus`.
 *   3. `Pipeline.executeGateConfirmation` — the `review_to_approved` gate
 *      confirm, straight through `adapter.updateCase`.
 *
 * Routes 2 and 3 are the NORMAL ones: `lifecycle-presets.ts` sets
 * `review_to_approved` to `'auto'` in the autonomous and standard presets
 * and `'confirm'` in strict, so all three presets approve without ever
 * touching the transactional core. A pin stamped only in `transition-core`
 * left every pipeline-approved case unpinned, and an unpinned case in a
 * pinned status publishes a permanent red `arbitra/case` — with no
 * recovery, since re-review re-runs the same unpinned path and
 * `pending_merge → done` is gated on `pr_merged`.
 *
 * So the pin is applied at all three sites, but DECIDED here. Copying the
 * rule three times is how the PR-ref comparison ended up with two helpers
 * that failed in opposite directions; one rule with three call sites cannot
 * drift the same way.
 */

/**
 * Transitions that (re)stamp the pin: entering `approved`, and only that.
 *
 * Deliberately NOT `pending_merge`/`done`. Those are bookkeeping edges that
 * follow an approval; re-stamping there would advance the pin onto whatever
 * commit had arrived by then — including one pushed AFTER the approval,
 * which is the exact defect this exists to close.
 */
function stampsApprovalPin(targetStatus: CaseStatus): boolean {
  return targetStatus === 'approved';
}

/**
 * The commit an approval covers: the last head SHA the webhook OBSERVED for
 * this case (`Case.current_head_sha`).
 *
 * Read off the case document rather than fetched from GitHub because the
 * canonical write site is inside a Firestore transaction, which cannot make
 * network calls — and because the observed commit is the honest answer
 * anyway: it is what Arbitra saw, not whatever HEAD happens to be at the
 * instant of a read.
 *
 * PARTIALLY-CLOSED GAP (issue #1054): "last observed at approval time" is
 * not the same as "the commit the review ran against" — this pin alone
 * cannot tell the two apart. #1054 closed the cheapest route through that
 * gap: `Run.reviewed_head_sha` now lets `review_run_completed` /
 * `auto_approve_criteria_met` (`preconditions.ts`) require the completed
 * review to match `Case.current_head_sha` before the AUTONOMOUS
 * `in_review → approved` transition can fire, so pushing a trivial commit,
 * getting it cleanly reviewed, then pushing the real change no longer
 * auto-approves the real change.
 *
 * What remains open: `needs_human_decision → approved` (a human's approve
 * click) does NOT re-check `review_run_completed` — its preconditions are
 * `human_approve_documented` / `all_high_critical_resolved` /
 * `required_evidence_satisfied` / `four_eyes_if_required` only. A push that
 * lands after the case already reached `needs_human_decision` (review
 * already ran and matched at that point) and before a human clicks approve
 * is still pinned and certified by THIS pin's logic — this function has no
 * way to know the approval-time commit differs from the reviewed one. That
 * residual sequence is defended only by this pin's downstream consequence
 * (`applyApprovalCommitPin` fails the published `arbitra/case` check once
 * the next webhook updates `current_head_sha` past what was approved), not
 * by an honest review gate. Not fixed here, and not the same gap #1066
 * tracks (#1066 is a post-APPROVAL push reacting with `approved → in_build`;
 * this is a push after entering `needs_human_decision` but before the human
 * approves — nothing currently reacts to it either).
 */
function approvedCommitFor(case_: Pick<Case, 'current_head_sha'>): string | undefined {
  return case_.current_head_sha;
}

/**
 * Firestore write fragment for a transition to `targetStatus`. Merge into
 * the SAME document update that writes the status, so the pin and the status
 * it belongs to can never be committed apart.
 *
 * Returns `{}` for transitions that do not stamp the pin — spreading an
 * empty object leaves the caller's update untouched.
 *
 * When no head SHA has been observed the pin is CLEARED
 * (`FieldValue.delete()`), never left as-is: a pin surviving from an earlier
 * approval would describe a different approval. `FieldValue.delete()` rather
 * than `undefined` because this Firestore instance runs with
 * `ignoreUndefinedProperties: true`, under which `undefined` is silently
 * dropped from the write instead of clearing the field.
 */
export function approvalPinPatch(
  targetStatus: CaseStatus,
  case_: Pick<Case, 'current_head_sha'>,
): Partial<Case> {
  if (!stampsApprovalPin(targetStatus)) return {};
  return {
    approved_head_sha: approvedCommitFor(case_)
      ?? (FieldValue.delete() as unknown as undefined),
  };
}

/**
 * In-memory counterpart of `approvalPinPatch`, for a caller that returns the
 * post-transition `Case` object to its own caller. Same decision, but a
 * cleared pin is plain `undefined` rather than the Firestore delete
 * sentinel, which must never escape into application state.
 */
export function approvalPinMirror(
  targetStatus: CaseStatus,
  case_: Pick<Case, 'current_head_sha'>,
): Partial<Case> {
  if (!stampsApprovalPin(targetStatus)) return {};
  return { approved_head_sha: approvedCommitFor(case_) };
}
