import type { Case, Repository } from '@arbitra/shared';
import { THRESHOLDS } from '../config.js';
import { buildSignature } from '../detector-types.js';
import type { Detector, DetectionResult, DetectorContext } from '../detector-types.js';

const ID = 'orphan-branch';

/**
 * Detector 3 — remote branches that:
 *   - have no commit newer than the threshold, AND
 *   - are not referenced by any non-terminal case.
 *
 * Scope guard: when the `ctx.listRemoteBranches` integration is not available
 * for a repo (returns `undefined`), the detector skips that repo silently. The
 * detector MUST NOT fail the whole scheduled run because a single integration
 * is missing — per the scope spec.
 */
export const orphanBranchDetector: Detector = {
  id: ID,
  name: 'Orphan branch',
  description: 'Flags remote branches untouched past the orphan threshold with no linked case.',
  async run(ctx: DetectorContext): Promise<DetectionResult[]> {
    const results: DetectionResult[] = [];

    if (!ctx.listRemoteBranches) {
      // No git integration wired — nothing this detector can do.
      return results;
    }

    const cutoffMs = ctx.now.getTime() - THRESHOLDS.orphan_branch_days * 86_400_000;

    // Build "branch → referenced by any non-terminal case" index once.
    const referencedBranches = new Map<string, Set<string>>(); // repo_id -> Set<branch>
    for await (const c of ctx.listNonTerminalCases()) {
      if (!c.current_branch) continue;
      const key = c.repository_id;
      if (!key) continue;
      if (!referencedBranches.has(key)) referencedBranches.set(key, new Set());
      referencedBranches.get(key)!.add(c.current_branch);
    }

    const repos = await ctx.listRepositories();
    for (const repo of repos) {
      let branches: { name: string; last_commit_at: string }[] | undefined;
      try {
        branches = await ctx.listRemoteBranches(repo);
      } catch (err) {
        // Per-repo failure is logged but doesn't fail the detector, much less the run.
        console.warn(`[intelligence.orphan-branch] listRemoteBranches failed for ${repo.repository_id}:`, err);
        continue;
      }
      if (!branches) continue; // integration not available for this repo — skip silently

      const referenced = referencedBranches.get(repo.repository_id) ?? new Set<string>();

      for (const b of branches) {
        if (referenced.has(b.name)) continue;
        if (isProtectedBranch(b.name)) continue;

        const lastMs = Date.parse(b.last_commit_at);
        if (!Number.isFinite(lastMs)) continue;
        if (lastMs > cutoffMs) continue;

        const days = Math.floor((ctx.now.getTime() - lastMs) / 86_400_000);

        results.push({
          detector_id: ID,
          signature: buildSignature(ID, 'branch', `${repo.repository_id}:${b.name}`),
          target_kind: 'branch',
          target_id: `${repo.repository_id}:${b.name}`,
          title: `Unlinked branch (${days}d stale): ${b.name}`,
          summary:
            `Branch \`${b.name}\` in ${repo.name} has no commit newer than ${days}d ` +
            `(threshold: ${THRESHOLDS.orphan_branch_days}d) and no active case references it. ` +
            `Archive the branch or open a case to cover the work.`,
          evidence: {
            repository_id: repo.repository_id,
            repository_name: repo.name,
            branch: b.name,
            last_commit_at: b.last_commit_at,
            days_stale: days,
            threshold_days: THRESHOLDS.orphan_branch_days,
          },
          severity: 'low',
          project_id: repo.project_id,
          repository_id: repo.repository_id,
        });
      }
    }

    return results;
  },
};

function isProtectedBranch(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === 'main' || n === 'master' || n === 'develop' || n === 'release';
}

/** Re-exported for unit tests. */
export type _RepoForTest = Repository;
export type _CaseForTest = Case;
