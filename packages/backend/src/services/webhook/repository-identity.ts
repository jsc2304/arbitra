import type { Repository } from '@arbitra/shared';

/**
 * A set of Arbitra repository rows that share the same GitHub numeric
 * `github_repository_id`. More than one row per id is a data-integrity
 * conflict: webhook routing matches by id and would non-deterministically
 * pick one of them, double-processing events (see issue #628).
 */
export interface DuplicateRepositoryIdGroup {
  github_repository_id: number;
  /** repository_id values of every Arbitra row carrying this GitHub id. */
  repository_ids: string[];
}

/**
 * Pure, side-effect-free detector for duplicate `github_repository_id` values.
 * Rows without a populated id are ignored (the field is optional and legacy
 * rows backfill it lazily). Returns one group per id that appears on more than
 * one row, so a dry-run/audit caller can surface the conflict and the operator
 * can decide which row to keep.
 *
 * The write-path 409 in the repository registration handler is the primary
 * guard; this is the secondary detection path for rows that predate it.
 */
export function findDuplicateGithubRepositoryIds(
  repositories: readonly Repository[],
): DuplicateRepositoryIdGroup[] {
  const byId = new Map<number, string[]>();
  for (const repo of repositories) {
    if (repo.github_repository_id === undefined) continue;
    const ids = byId.get(repo.github_repository_id) ?? [];
    ids.push(repo.repository_id);
    byId.set(repo.github_repository_id, ids);
  }

  const duplicates: DuplicateRepositoryIdGroup[] = [];
  for (const [githubRepositoryId, repositoryIds] of byId) {
    if (repositoryIds.length > 1) {
      duplicates.push({
        github_repository_id: githubRepositoryId,
        repository_ids: repositoryIds,
      });
    }
  }
  return duplicates;
}

/**
 * Deterministic workspace-event id for a duplicate-`github_repository_id`
 * conflict, scoped to `(github id, UTC day)`. Repeat conflicts for the same id
 * on the same day collapse onto a single document (the `record` write is a
 * `set` keyed by this id), so a noisy repo firing many events in one day
 * surfaces exactly once. Mirrors the `(repo, day)` dedup the push-only
 * misconfig detector uses. See issue #628.
 *
 * `now` is injectable so tests are clock-stable.
 */
export function repositoryIdConflictEventId(
  githubRepositoryId: number,
  now: Date = new Date(),
): string {
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `wse_repo_id_conflict_${githubRepositoryId}_${day}`;
}

/**
 * FNV-1a 32-bit hash, base36-encoded. Used only to disambiguate event ids
 * whose human-readable portion has been lossily sanitized (see
 * `repositoryUrlConflictEventId`) — not a security primitive, just enough
 * entropy that two DIFFERENT raw strings essentially never collide.
 */
function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Deterministic workspace-event id for an ambiguous step-3 `url` match
 * (issue #1048): more than one Arbitra repository row's `url` resolves to
 * the same target. Scoped to `(repositoryFullName, UTC day)`, mirroring
 * `repositoryIdConflictEventId`'s dedup discipline — repeat ambiguity for
 * the same slug on the same day collapses onto one event instead of
 * spamming the activity feed.
 *
 * `repositoryFullName` is sanitized to safe id characters for readability,
 * the same way `sanitizeEventIdPart` does in `webhook-service.ts` (not
 * imported from there to avoid a circular dependency between the two
 * modules) — but that sanitization is LOSSY (both `.` and `/` collapse to
 * `_`, so `a/b.c` and `a/b_c` would otherwise produce the same id and
 * silently overwrite each other's conflict event). A short hash of the RAW,
 * unsanitized name is appended to keep the id unique per distinct name even
 * when the readable portion collides.
 */
export function repositoryUrlConflictEventId(
  repositoryFullName: string,
  now: Date = new Date(),
): string {
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const safeName = repositoryFullName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  return `wse_repo_url_conflict_${safeName}_${shortHash(repositoryFullName)}_${day}`;
}
