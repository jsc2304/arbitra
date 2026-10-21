/**
 * Observed Cases (issue #986 / ADR-0001): auto-created when a Session Signal
 * or PR webhook references a (repository, branch) pair with no non-terminal
 * case bound to it yet.
 */

import type { Repository } from './project.js';

/**
 * Atomic claim on one (repository, branch) pair, staked the moment the
 * first signal for an unknown branch is processed. Doc id is a deterministic
 * hash of `repository_id` + `branch` (`observedCaseClaimDocId`) — never
 * queried, only claimed via a transactional `create`, exactly like
 * `SessionSignalEventReceipt`'s `event_id` claim. This is what makes
 * concurrent/duplicate signal delivery for the same unknown branch produce
 * exactly one Observed Case instead of a check-then-insert race: the loser
 * of the `tx.create` throw never gets to write a case document at all.
 */
export interface ObservedCaseClaim {
  repository_id: string;
  branch: string;
  /** The Observed Case this claim created — written in the same transaction. */
  case_id: string;
  created_at: string;
}

/**
 * Branch names treated as a repository's default branch for Observed Case
 * purposes (issue #1009) when no real stored value is available yet. PRs
 * merge INTO the default branch, never FROM it, so the auto-close-on-merge
 * path that closes every other Observed Case can never fire for one bound
 * to it — it would sit in `in_build` forever and every later session on
 * that branch would keep attaching to the same eternal case. Ambient
 * presence on the default branch is session data (still visible via
 * Mission Control), not a unit of work, so it gets no Observed Case at all.
 *
 * This is a pragmatic name-based FALLBACK for a repo `Repository.default_branch`
 * hasn't been backfilled for yet (e.g. it has never received a webhook) —
 * `isDefaultBranch` below always prefers the real stored value when present.
 * A repo whose default branch is named something else (e.g. `develop`,
 * `trunk`) AND has no stored `default_branch` yet keeps today's behavior (an
 * Observed Case gets created) — safe, just not what this heuristic catches.
 */
export const DEFAULT_BRANCH_NAMES: ReadonlySet<string> = new Set(['main', 'master']);

export function isDefaultBranchName(branch: string): boolean {
  return DEFAULT_BRANCH_NAMES.has(branch);
}

/**
 * Repository-aware default-branch check (issue #1009): prefers the real
 * GitHub default branch (`Repository.default_branch`, backfilled from
 * webhook payloads by `WebhookService`) when it has been captured, and only
 * falls back to the name heuristic (`isDefaultBranchName`) for a repo that
 * hasn't received a webhook yet. This is the check every Observed Case
 * default-branch decision should use — `isDefaultBranchName` alone is only
 * ever correct by coincidence once a repo's real default branch is known,
 * and gets it backwards for a `main`-default repo with a feature branch
 * literally named `master` (or vice versa).
 */
export function isDefaultBranch(repo: Pick<Repository, 'default_branch'>, branch: string): boolean {
  if (repo.default_branch !== undefined) {
    return repo.default_branch === branch;
  }
  return isDefaultBranchName(branch);
}
