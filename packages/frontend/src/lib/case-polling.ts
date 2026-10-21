/**
 * Polling cadence for case-detail SWR queries.
 *
 * The autonomous pipeline advances a case through validation/review/approval
 * in seconds, but SWR's default has no refresh interval — the UI stays
 * stale until the user reloads. This helper returns a per-status interval
 * so the case page stays live during every transition (including early ones
 * like open → exploration → ready_for_build → in_build) and idles out
 * only when the case is terminal.
 *
 * SWR accepts a function `(data) => number` for `refreshInterval`, so the
 * interval re-evaluates as the case advances — e.g. a case in `in_review`
 * polls at 1.5 s, then drops to 0 the moment it lands on `done`.
 */
import type { CaseStatus } from '@arbitra/shared';

/** Milliseconds between refreshes. 0 = no polling. */
export function getCasePollingInterval(status: CaseStatus | string | undefined): number {
  if (!status) return 0;

  // Terminal — no further transitions will happen.
  if (status === 'done' || status === 'rejected') return 0;

  // Every other status might transition at any moment (autonomous pipeline,
  // IDE agent, or human action). Poll fast across the board so demos and
  // live-watch flows see each step without a manual reload.
  return 1500;
}
