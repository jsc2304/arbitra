/**
 * Triage-view selectors for the Board.
 *
 * Pure, side-effect-free predicates that classify a {@link Case} into one of
 * six triage views. Consumers (PR 2.3+) route cases through
 * {@link getTriageViewPredicate} to group/filter the board.
 */
import type { Case, UserRole } from '@arbitra/shared';

export type TriageView =
  | 'all'
  | 'needs-me'
  | 'ready-to-approve'
  | 'blocked'
  | 'waiting-on-others'
  | 'recently-updated'
  | 'my-active';

/** All triage view ids, in canonical display order. */
export const TRIAGE_VIEWS: readonly TriageView[] = [
  'needs-me',
  'ready-to-approve',
  'blocked',
  'waiting-on-others',
  'recently-updated',
  'my-active',
  'all',
] as const;

/** Human-readable labels for each triage view. */
export const TRIAGE_VIEW_LABELS: Record<TriageView, string> = {
  all: 'All',
  'needs-me': 'Needs Me',
  'ready-to-approve': 'Ready to Approve',
  blocked: 'Blocked',
  'waiting-on-others': 'Waiting on Others',
  'recently-updated': 'Recently Updated',
  'my-active': 'My Active',
};

const REVIEW_QUEUE_STATUSES = new Set<Case['status']>([
  'needs_human_decision',
  'verification_pending',
]);

const OWNER_WAITING_STATUSES = new Set<Case['status']>([
  'in_build',
  'in_validation',
  'in_review',
]);

const TERMINAL_STATUSES = new Set<Case['status']>(['done', 'rejected']);

const REVIEWER_ROLES: readonly UserRole[] = ['reviewer', 'tech_lead', 'admin'];

const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function hasReviewerRole(roles: readonly UserRole[]): boolean {
  return roles.some((r) => REVIEWER_ROLES.includes(r));
}

function toEpochMs(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * `needsMe` — the user is the target of a pending action. Union of:
 *   1. directly assigned reviewer, or
 *   2. a pending gate exists and the user is NOT the owner (anti-gaming: the
 *      owner cannot confirm their own gate), or
 *   3. queue pickup: status is in `needs_human_decision` / `verification_pending`,
 *      no reviewer assigned, and the user has a reviewer-class role.
 */
export function needsMe(
  case_: Case,
  userId: string,
  roles: readonly UserRole[],
): boolean {
  if (!userId) return false;

  // 1. Explicit assignment
  if (case_.assigned_reviewer_id === userId) return true;

  // 2. Gate-confirmable by a non-owner
  if (case_.pending_gate && case_.owner_user_id !== userId) return true;

  // 3. Queue pickup for reviewer-class users
  if (
    REVIEW_QUEUE_STATUSES.has(case_.status) &&
    (case_.assigned_reviewer_id === undefined || case_.assigned_reviewer_id === null) &&
    hasReviewerRole(roles)
  ) {
    return true;
  }

  return false;
}

/**
 * `readyToApprove` — a human-decision slot is open, irrespective of assignment.
 */
export function readyToApprove(case_: Case): boolean {
  return REVIEW_QUEUE_STATUSES.has(case_.status);
}

/**
 * `blocked` — the case cannot progress: it has open findings needing fixes,
 * or it has been explicitly rejected.
 *
 * @param case_ - The case to evaluate.
 * @param findingCount - Total count of open findings for this case, sourced
 *   from the board-level `Record<case_id, number>` map returned by the
 *   `useCases` hook (`hooks/use-cases.ts`). The canonical API exposes a
 *   scalar total per case, not severity buckets, so the selector treats any
 *   positive count as blocking. Callers without count data should pass `0`
 *   or omit; the selector will then only block on `rejected`.
 */
export function blocked(case_: Case, findingCount?: number): boolean {
  if (case_.status === 'rejected') return true;
  return (findingCount ?? 0) > 0;
}

/**
 * `waitingOnOthers` — I authored the case and it is progressing without me
 * (build / validation / review underway).
 */
export function waitingOnOthers(case_: Case, userId: string): boolean {
  if (!userId) return false;
  return case_.owner_user_id === userId && OWNER_WAITING_STATUSES.has(case_.status);
}

/**
 * `recentlyUpdated` — `updated_at` is within `sinceMs` (default 24h).
 * Tolerates ISO-string or numeric timestamps.
 */
export function recentlyUpdated(
  case_: Case,
  sinceMs: number = DEFAULT_RECENT_WINDOW_MS,
): boolean {
  const updated = toEpochMs(case_.updated_at as unknown as string | number);
  if (updated === null) return false;
  const now = Date.now();
  return now - updated <= sinceMs && now - updated >= 0;
}

/**
 * `myActive` — I own this case and it is still in flight (not `done` /
 * `rejected`).
 */
export function myActive(case_: Case, userId: string): boolean {
  if (!userId) return false;
  return case_.owner_user_id === userId && !TERMINAL_STATUSES.has(case_.status);
}

/**
 * Resolve a {@link TriageView} id to the matching selector, bound to a
 * user-context. Simplifies consumers that iterate over {@link TRIAGE_VIEWS}.
 *
 * The `findingCounts` map on `ctx` threads board-level per-case totals through
 * to the `blocked` selector; omit it when the caller does not have counts
 * loaded — `blocked` will then only surface cases in `rejected` status.
 */
export function getTriageViewPredicate(
  view: TriageView,
  ctx: {
    userId: string;
    roles: readonly UserRole[];
    findingCounts?: Record<string, number>;
  },
): (case_: Case) => boolean {
  switch (view) {
    case 'all':
      return () => true;
    case 'needs-me':
      return (c) => needsMe(c, ctx.userId, ctx.roles);
    case 'ready-to-approve':
      return (c) => readyToApprove(c);
    case 'blocked':
      return (c) => blocked(c, ctx.findingCounts?.[c.case_id]);
    case 'waiting-on-others':
      return (c) => waitingOnOthers(c, ctx.userId);
    case 'recently-updated':
      return (c) => recentlyUpdated(c);
    case 'my-active':
      return (c) => myActive(c, ctx.userId);
  }
}
