/**
 * Finding selectors (UI/UX 3-bets plan 1.4).
 *
 * Pure helpers shared by any surface that reasons about "is this finding
 * blocking a gate?" — currently the Findings panel row highlight
 * (components/case/findings-panel.tsx), the Case blocker strip
 * (components/case/blocker-strip.tsx), and the courtroom Approve gate
 * (components/courtroom/decision-cluster/).
 *
 * Blocker definition:
 *   origin is author-blocking (`authored`, or a missing origin for
 *   back-compat — NOT `submodule`/`vendored`) AND severity is `high` or
 *   `critical` AND status is NOT resolved
 *   (see `isAuthorBlockingOrigin` / `isBlockingFindingStatus` in
 *   `@arbitra/shared`).
 *
 * The origin and status halves of the predicate are sourced from
 * `@arbitra/shared` so the client matches the server-side precondition
 * (`all_high_critical_resolved` in preconditions.ts) and the
 * `DecisionService` guardrail. Previously this file hardcoded a
 * `{'open'}` set, which caused Approve to appear enabled for findings in
 * `accepted` or `contested` state and then 409 with
 * `OPEN_FINDINGS_BLOCK_DECISION` — the exact papercut reviewers flagged.
 * The origin half (issue #633) keeps submodule/vendored findings from
 * counting as blockers so the UI matches the relaxed gate.
 *
 * PR 1.6 follow-up: dedupe the `case-cockpit-hero` inline
 * `countBySeverity` helper against `countBlockers` here.
 */

import {
  isBlockingFindingStatus,
  isAuthorBlockingOrigin,
  type Finding,
  type FindingSeverity,
} from '@arbitra/shared';

type MinimalFinding = Pick<Finding, 'severity' | 'status'> & Partial<Pick<Finding, 'origin'>>;

const BLOCKING_SEVERITIES: ReadonlySet<FindingSeverity> = new Set(['high', 'critical']);

/**
 * Returns `true` when a finding currently blocks a gate:
 * author-blocking origin (authored, or missing for back-compat) AND
 * high/critical severity AND a non-resolved status (open/accepted/contested).
 *
 * Accepts a minimal shape so non-{@link Finding} callers (e.g. server-side
 * summaries) can pass plain objects without casting.
 */
export function isBlocking(finding: MinimalFinding): boolean {
  return (
    isAuthorBlockingOrigin(finding.origin) &&
    BLOCKING_SEVERITIES.has(finding.severity as FindingSeverity) &&
    isBlockingFindingStatus(finding.status)
  );
}

export interface BlockerCounts {
  high: number;
  critical: number;
  total: number;
}

/**
 * Counts blocking findings by severity. `total === high + critical`.
 *
 * Mirrors (and — per plan 1.6 — should eventually replace) the inline
 * `countBySeverity` helper in `components/case/case-cockpit-hero.tsx`.
 */
export function countBlockers(findings: readonly MinimalFinding[]): BlockerCounts {
  let high = 0;
  let critical = 0;
  for (const f of findings) {
    if (!isBlocking(f)) continue;
    if (f.severity === 'critical') critical += 1;
    else if (f.severity === 'high') high += 1;
  }
  return { high, critical, total: high + critical };
}
