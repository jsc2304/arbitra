import { describe, it, expect } from 'vitest';
import { orphanBranchDetector } from '../detectors/orphan-branch.js';
import { makeCase, makeRepository, makeStubContext } from './test-helpers.js';

const NOW = new Date('2026-04-19T00:00:00.000Z');

describe('orphanBranchDetector', () => {
  it('returns empty when no git integration is wired (listRemoteBranches undefined)', async () => {
    const ctx = makeStubContext({
      now: NOW,
      repositories: [makeRepository()],
      // remoteBranches intentionally omitted
    });
    expect(await orphanBranchDetector.run(ctx)).toHaveLength(0);
  });

  it('flags a stale branch not referenced by any case', async () => {
    const fortyDaysAgo = new Date(NOW.getTime() - 40 * 86_400_000).toISOString();
    const ctx = makeStubContext({
      now: NOW,
      repositories: [makeRepository()],
      remoteBranches: () => [{ name: 'feat/old-work', last_commit_at: fortyDaysAgo }],
    });
    const results = await orphanBranchDetector.run(ctx);
    expect(results).toHaveLength(1);
    expect(results[0].target_id).toBe('repo_1:feat/old-work');
    expect(results[0].evidence.days_stale).toBe(40);
  });

  it('does not flag a branch referenced by a non-terminal case', async () => {
    const c = makeCase({ case_id: 'case_live', current_branch: 'feat/live' });
    const fortyDaysAgo = new Date(NOW.getTime() - 40 * 86_400_000).toISOString();
    const ctx = makeStubContext({
      now: NOW,
      cases: [c],
      repositories: [makeRepository()],
      remoteBranches: () => [{ name: 'feat/live', last_commit_at: fortyDaysAgo }],
    });
    expect(await orphanBranchDetector.run(ctx)).toHaveLength(0);
  });

  it('does not flag protected branches (main/master/develop/release)', async () => {
    const ninetyDaysAgo = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    const ctx = makeStubContext({
      now: NOW,
      repositories: [makeRepository()],
      remoteBranches: () => [
        { name: 'main', last_commit_at: ninetyDaysAgo },
        { name: 'master', last_commit_at: ninetyDaysAgo },
        { name: 'develop', last_commit_at: ninetyDaysAgo },
        { name: 'release', last_commit_at: ninetyDaysAgo },
      ],
    });
    expect(await orphanBranchDetector.run(ctx)).toHaveLength(0);
  });

  it('skips a repo whose integration returns undefined and keeps running for others', async () => {
    const fortyDaysAgo = new Date(NOW.getTime() - 40 * 86_400_000).toISOString();
    const repoA = makeRepository({ repository_id: 'repo_a', name: 'a' });
    const repoB = makeRepository({ repository_id: 'repo_b', name: 'b' });
    const ctx = makeStubContext({
      now: NOW,
      repositories: [repoA, repoB],
      remoteBranches: (r) => (r.repository_id === 'repo_a' ? undefined : [{ name: 'feat/x', last_commit_at: fortyDaysAgo }]),
    });
    const results = await orphanBranchDetector.run(ctx);
    expect(results.map((r) => r.target_id)).toEqual(['repo_b:feat/x']);
  });
});
