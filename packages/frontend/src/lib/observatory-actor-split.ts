/**
 * Observatory leaderboard cohort split.
 *
 * PR #519 (refined in PR #527): the Observatory contributor and
 * reviewer leaderboards used to mix human users and the system actor (auto-
 * approves, automated decisions, webhook-authored writes) in one ranking,
 * which distorted human standings. We split the rows into two cohorts and
 * render the system rows in a dedicated "System activity" section directly
 * below the human leaderboard.
 *
 * Identification rule mirrors `resolveSyntheticClientName` in
 * `packages/backend/src/services/activity/activity-service.ts`: a row is a
 * system actor iff its `user_id` is exactly `'system'` or starts with
 * `'system:'` (e.g. `system:webhook`, `system:auto-approve`). All other
 * actors are treated as human.
 *
 * If a future PR introduces additional non-human sentinels, extend
 * `isSystemActorId` here AND keep it in sync with the backend resolver.
 */

export function isSystemActorId(userId: string): boolean {
  return userId === 'system' || userId.startsWith('system:');
}

export interface ActorRowLike {
  user_id: string;
}

export interface ActorCohortSplit<T extends ActorRowLike> {
  human: T[];
  system: T[];
}

/**
 * Split a mixed leaderboard list into human and system cohorts. Order is
 * preserved within each cohort (callers are expected to have already sorted
 * the input by their primary metric).
 */
export function splitActorRows<T extends ActorRowLike>(rows: T[]): ActorCohortSplit<T> {
  const human: T[] = [];
  const system: T[] = [];
  for (const row of rows) {
    if (isSystemActorId(row.user_id)) {
      system.push(row);
    } else {
      human.push(row);
    }
  }
  return { human, system };
}
