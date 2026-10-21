/**
 * Approval-rate color ramp.
 *
 * The dashboard + observatory
 * previously rendered "Approval Rate 0%" in green, which falsely reads as
 * "good" for what is actually a stalled pipeline.
 *
 * Ramp:
 *   0%      → red    (danger — nothing is shipping)
 *   <50%    → gray   (neutral — too noisy to call good or bad)
 *   50–79%  → amber  (warning)
 *   ≥80%    → green  (healthy)
 *
 * Empty-workspace carve-out (#664): a 0% rate is only alarming when at least
 * one case has actually been decided. A brand-new / empty workspace (no cases
 * decided yet) has a 0% rate purely because the denominator is 0 — that is
 * "no data yet", not a stalled pipeline, so it should read neutral (gray),
 * NOT alarm-red.
 *
 * Callers pass an optional `decidedCount` — the number of cases that have
 * reached a terminal state (approved + rejected + done), i.e. the denominator
 * behind `approval_rate`. When it is `0` we have no signal yet → gray. The
 * intentional 0% → red is preserved whenever `decidedCount > 0`.
 *
 * `decidedCount` defaults to `undefined`, which preserves the original
 * behavior (0% → red) for any caller that does not pass it.
 */

export interface ApprovalRatePill {
  bg: string;
  fg: string;
}

const NEUTRAL_PILL: ApprovalRatePill = { bg: 'rgba(107,114,128,0.12)', fg: '#6b7280' };
const NEUTRAL_ACCENT = '#6b7280';

/**
 * True when we have NO decision signal yet: caller passed an explicit
 * `decidedCount` and it is 0 (or negative). When `decidedCount` is omitted we
 * keep the legacy behavior (treat 0% as red).
 */
function hasNoData(decidedCount?: number): boolean {
  return decidedCount !== undefined && decidedCount <= 0;
}

export function approvalRatePillColors(
  rate: number,
  decidedCount?: number,
): ApprovalRatePill {
  if (hasNoData(decidedCount)) return NEUTRAL_PILL;
  if (rate <= 0) return { bg: 'rgba(239,68,68,0.12)', fg: '#dc2626' };
  if (rate >= 80) return { bg: 'rgba(34,197,94,0.12)', fg: '#16a34a' };
  if (rate >= 50) return { bg: 'rgba(234,179,8,0.12)', fg: '#ca8a04' };
  return NEUTRAL_PILL;
}

export function approvalRateStatAccent(rate: number, decidedCount?: number): string {
  if (hasNoData(decidedCount)) return NEUTRAL_ACCENT;
  if (rate <= 0) return '#dc2626';
  if (rate >= 50) return '#22c55e';
  return NEUTRAL_ACCENT;
}
