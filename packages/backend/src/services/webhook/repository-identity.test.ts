import { describe, it, expect } from 'vitest';
import type { Repository } from '@arbitra/shared';
import { findDuplicateGithubRepositoryIds, repositoryUrlConflictEventId } from './repository-identity.js';

function repo(overrides: Partial<Repository>): Repository {
  return {
    repository_id: 'repo_1',
    project_id: 'proj_1',
    name: 'web',
    url: 'https://github.com/acme/web',
    provider: 'github',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('findDuplicateGithubRepositoryIds', () => {
  it('returns no duplicates when every github_repository_id is unique', () => {
    const rows = [
      repo({ repository_id: 'repo_a', github_repository_id: 1 }),
      repo({ repository_id: 'repo_b', github_repository_id: 2 }),
    ];
    expect(findDuplicateGithubRepositoryIds(rows)).toEqual([]);
  });

  it('flags rows sharing a github_repository_id with all repository_ids', () => {
    const rows = [
      repo({ repository_id: 'repo_a', github_repository_id: 42 }),
      repo({ repository_id: 'repo_b', github_repository_id: 42 }),
      repo({ repository_id: 'repo_c', github_repository_id: 7 }),
    ];
    const dups = findDuplicateGithubRepositoryIds(rows);
    expect(dups).toEqual([
      { github_repository_id: 42, repository_ids: ['repo_a', 'repo_b'] },
    ]);
  });

  it('ignores rows without a populated github_repository_id', () => {
    const rows = [
      repo({ repository_id: 'repo_a' }),
      repo({ repository_id: 'repo_b' }),
    ];
    expect(findDuplicateGithubRepositoryIds(rows)).toEqual([]);
  });
});

describe('repositoryUrlConflictEventId', () => {
  const day = new Date('2026-08-28T12:00:00.000Z');

  it('is deterministic for the same (name, day)', () => {
    expect(repositoryUrlConflictEventId('acme/api', day)).toBe(repositoryUrlConflictEventId('acme/api', day));
  });

  it('differs across days for the same name', () => {
    const nextDay = new Date('2026-08-29T00:00:01.000Z');
    expect(repositoryUrlConflictEventId('acme/api', day)).not.toBe(repositoryUrlConflictEventId('acme/api', nextDay));
  });

  it('does NOT collide when the lossy sanitization would otherwise make two different names equal', () => {
    // Both '.' and '/' sanitize to '_', so a naive "strip unsafe chars" id
    // would make these two DIFFERENT repository slugs collide onto the same
    // Firestore doc — silently dropping one row's conflict event.
    const idA = repositoryUrlConflictEventId('a/b.c', day);
    const idB = repositoryUrlConflictEventId('a/b_c', day);
    expect(idA).not.toBe(idB);
  });
});
