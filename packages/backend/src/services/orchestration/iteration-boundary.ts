import type { CaseEvent } from '@arbitra/shared';

/**
 * Event types that mark the start of a fresh "iteration" for the purposes of
 * decision idempotency / precondition scoping.
 *
 * - `changes_requested`: the canonical loop-back signal — sends the case from
 *   in_review/verification_pending back to in_build. Decisions before this
 *   point are stale.
 *
 * - `manual_verification_requested`: emitted by the state machine on entry to
 *   `verification_pending` (see status-transitions.ts: in_review -> verification_pending
 *   and needs_human_decision -> verification_pending both fire this). The
 *   verification_pending phase is the one place where the user is explicitly
 *   asked to attest "I manually validated"; a `manual_validation_confirmed`
 *   filed BEFORE the case entered this phase was made under different intent
 *   and must not satisfy the new attestation.
 *
 * Order matters only for documentation — the helper picks the most recent
 * by `created_at`.
 */
const ITERATION_BOUNDARY_EVENT_TYPES = new Set<string>([
  'changes_requested',
  'manual_verification_requested',
]);

/**
 * Return the `created_at` of the most recent iteration-boundary event, or
 * `null` if none have fired. Decisions filed at or before this timestamp
 * belong to a previous iteration and should not count toward the current
 * one.
 *
 * Callers compare with strict greater-than: `decision.created_at > boundary`.
 *
 * Keeping the surface to a single timestamp (not an event) keeps comparisons
 * trivial and matches the existing `currentIterationRuns` style.
 */
export function mostRecentIterationBoundary(events: CaseEvent[]): string | null {
  let latest: string | null = null;
  for (const e of events) {
    if (!ITERATION_BOUNDARY_EVENT_TYPES.has(e.type)) continue;
    if (latest === null || e.created_at > latest) {
      latest = e.created_at;
    }
  }
  return latest;
}
