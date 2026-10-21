/**
 * Shared predicates for reasoning about finding status — specifically
 * "does this finding block a case-level approval?".
 *
 * Single source of truth for both the UI (enable/disable Approve) and the
 * server-side guardrail in `DecisionService` plus the canonical
 * `all_high_critical_resolved` precondition. Keeping one helper prevents
 * client/server drift — the papercut this file exists to eliminate was
 * the client treating only `open` as blocking while the server treated
 * `open | accepted | contested` as blocking, so users saw Approve enabled
 * and then received a 409 `OPEN_FINDINGS_BLOCK_DECISION`.
 *
 * Resolved (non-blocking) statuses:
 *   - `fixed`    — developer addressed the finding
 *   - `waived`   — explicitly excused via a decision with rationale
 *   - `resolved` — marked resolved via an approve decision
 *   - `waived_on_completion` — the case reached `done` with the waiver proposal
 *                    still unconfirmed, so the completion closer shut it
 *                    administratively. Terminal: no surface can act on the
 *                    proposal after completion, so it must not block (#751).
 *
 * Blocking statuses (everything else):
 *   - `open`             — fresh, unacknowledged
 *   - `accepted`         — acknowledged but not yet actioned
 *   - `contested`        — disputed, not yet adjudicated
 *   - `waiver_proposed`  — an agent proposed a waiver (rationale recorded) but
 *                          a human has NOT confirmed it yet. Deliberately
 *                          BLOCKING so the agent cannot self-clear an approval
 *                          gate — a human must file the terminal `waive`/
 *                          `approve` decision to reach a resolved status.
 */

import type { FindingStatus, FindingOrigin, FindingVerificationStatus } from '../types/finding.js';

/** Statuses that mean the finding has been actioned and no longer blocks. */
export const RESOLVED_FINDING_STATUSES: readonly FindingStatus[] = [
  'fixed',
  'waived',
  'resolved',
  'waived_on_completion',
] as const;

/** Statuses that count as "still needs action" for approval gating. */
export const BLOCKING_FINDING_STATUSES: readonly FindingStatus[] = [
  'open',
  'accepted',
  'contested',
  'waiver_proposed',
] as const;

/**
 * Returns `true` when a finding's status means it still blocks a decision.
 * Equivalent to `!RESOLVED_FINDING_STATUSES.includes(status)` but named for
 * intent at call sites.
 */
export function isBlockingFindingStatus(status: FindingStatus): boolean {
  return !(RESOLVED_FINDING_STATUSES as readonly FindingStatus[]).includes(status);
}

/**
 * Resolve a finding's effective origin, applying the back-compat default:
 * a missing `origin` is treated as `authored`. Use this rather than reading
 * `finding.origin` directly so old findings (persisted before the field
 * existed) keep their authored-strict gating behaviour.
 */
export function effectiveFindingOrigin(origin: FindingOrigin | undefined): FindingOrigin {
  return origin ?? 'authored';
}

/**
 * Origins whose high/critical findings do NOT auto-block the case-level gate
 * (auto-approve / escalation / resolution). These are code the author merely
 * pulled in (a git submodule) rather than wrote, so a pre-existing defect
 * inside them must not auto-escalate a `git submodule add` case.
 *
 * Authored findings are deliberately absent — they gate exactly as before.
 * `vendored` is included so the gate stays consistent if/when vendored
 * detection is wired up (currently nothing tags `vendored`, see #633).
 */
export const NON_AUTHOR_BLOCKING_ORIGINS: readonly FindingOrigin[] = [
  'submodule',
  'vendored',
] as const;

/**
 * Returns `true` when a finding should count toward the high/critical
 * AUTHOR gate (auto-approve block, escalation to `needs_human_decision`,
 * resolution requirement). Only `authored`-origin findings block; submodule
 * and vendored findings are visible to humans but do not auto-block.
 *
 * Back-compat: a missing `origin` is treated as `authored` and therefore
 * blocks, exactly as before this field existed.
 */
export function isAuthorBlockingOrigin(origin: FindingOrigin | undefined): boolean {
  return !(NON_AUTHOR_BLOCKING_ORIGINS as readonly FindingOrigin[]).includes(
    effectiveFindingOrigin(origin),
  );
}

/**
 * Returns `true` when a finding was mechanically disproven by the adversarial
 * verification step (`verification_status === 'refuted'`). Such findings stay
 * visible/queryable but MUST NOT count as blocking in the high/critical
 * precondition gates — the verifier proved them false positives against ground
 * truth. Every other verification status (confirmed / uncertain / unverified /
 * missing) keeps blocking exactly as before.
 */
export function isRefutedFinding(
  verification_status: FindingVerificationStatus | undefined,
): boolean {
  return verification_status === 'refuted';
}
