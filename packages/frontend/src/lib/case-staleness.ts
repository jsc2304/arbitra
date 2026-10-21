import type { Case, CaseStatus } from '@arbitra/shared';

const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours
const ARCHIVE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const TERMINAL_STATUSES: CaseStatus[] = ['done', 'rejected'];

/**
 * A case is "stale" if it has not been updated in >48 hours
 * AND is not in a terminal state (done/rejected).
 */
export function isCaseStale(c: Case): boolean {
  if (TERMINAL_STATUSES.includes(c.status)) return false;
  const elapsed = Date.now() - new Date(c.updated_at || c.created_at).getTime();
  return elapsed > STALE_THRESHOLD_MS;
}

/**
 * Returns a human-readable string for how long a case has been inactive.
 * e.g. "No activity for 3 days"
 */
export function staleDuration(c: Case): string {
  const elapsed = Date.now() - new Date(c.updated_at || c.created_at).getTime();
  const hours = Math.floor(elapsed / (60 * 60 * 1000));
  if (hours < 24) return `No activity for ${hours}h`;
  const days = Math.floor(hours / 24);
  return `No activity for ${days} day${days !== 1 ? 's' : ''}`;
}

/**
 * A case is considered "archived" if it is in a terminal state
 * and was last updated more than 7 days ago.
 */
export function isCaseArchived(c: Case): boolean {
  if (!TERMINAL_STATUSES.includes(c.status)) return false;
  const elapsed = Date.now() - new Date(c.updated_at || c.created_at).getTime();
  return elapsed > ARCHIVE_THRESHOLD_MS;
}

/**
 * Returns true if the case is in a terminal state (done/rejected).
 */
export function isCaseTerminal(c: Case): boolean {
  return TERMINAL_STATUSES.includes(c.status);
}
