import type { Case } from '@arbitra/shared';
import { parsePrRef } from '@arbitra/shared';

export interface DiffResult {
  /**
   * The diff text handed to consumers. When `truncated` is true this is the
   * first `MAX_DIFF_LINES` lines followed by `buildDiffTruncationMarker` — the
   * marker is part of the text on purpose, so any consumer that only ever
   * looks at `diff` (an LLM prompt above all) still learns it received a
   * prefix rather than the whole change.
   */
  diff: string;
  source: 'pr' | 'branch_compare';
  truncated: boolean;
  /**
   * Line count of the ORIGINAL diff, before truncation. Consumers need the
   * real size, not the size of what survived the cap: a truncated diff's
   * `diff.split('\n').length` is always ~MAX_DIFF_LINES and says nothing
   * about how much was dropped.
   */
  lineCount: number;
  /**
   * The commit SHA this diff was actually fetched for — the PR head SHA for
   * a `pr` source, the branch tip commit for `branch_compare` (issue #1054).
   * Neither GitHub endpoint's `Accept: application/vnd.github.v3.diff`
   * response carries this (it's raw diff text, not JSON), so resolving it
   * costs a second, small GitHub call per resolve. Threaded through to
   * `Run.reviewed_head_sha` so a completed review_run can be checked against
   * `Case.current_head_sha` at approval time, instead of a completed review
   * of ANY prior commit satisfying the gate for a change it never saw.
   */
  headSha: string;
}

/**
 * Why `DiffResolver.resolve` returned no result — distinguishes "this case
 * has nothing to resolve a diff from" (no PR ref, no branch) from "a diff
 * source exists but fetching it from GitHub failed" (auth, rate limit, 404,
 * wrong default branch). Both used to collapse into a bare `null`, which is
 * how `NO_DIFF_SOURCE` (`packages/frontend/src/app/api/runs/route.ts`) ended
 * up telling an operator "case has no PR or branch reference" when the real
 * problem was an expired GitHub token or a non-`main` default branch (issue
 * #1054, "Also from the same review, smaller" bullet 2).
 */
export type DiffResolveFailureReason = 'no_diff_source' | 'diff_fetch_failed';

export type DiffResolveResult =
  | ({ ok: true } & DiffResult)
  | { ok: false; reason: DiffResolveFailureReason };

export const MAX_DIFF_LINES = 10_000;

/**
 * Stable prefix of the marker appended to a truncated diff. Tests and any
 * consumer that needs to detect the marker should match on this rather than
 * on the full wording.
 */
export const DIFF_TRUNCATION_MARKER_PREFIX = '[ARBITRA] DIFF TRUNCATED';

/**
 * The text appended to a truncated diff.
 *
 * Reviewing the prefix of a diff and reporting the result as if it covered
 * the whole change is how a change nobody looked at reaches an approval
 * (issue #877). The reviewer cannot know the text was cut unless the text
 * says so, so the cut is stated inside the diff itself, in the imperative,
 * at the position where the content stops.
 */
export function buildDiffTruncationMarker(shownLines: number, totalLines: number): string {
  const dropped = totalLines - shownLines;
  return [
    '',
    DIFF_TRUNCATION_MARKER_PREFIX,
    `Only the first ${shownLines} of ${totalLines} lines of this diff are shown above.`,
    `The remaining ${dropped} line(s) were not included and have not been read by anyone.`,
    'Your review therefore covers a prefix of the change, not the change.',
    'Do not state or imply that the change as a whole is complete, safe, or ready to approve.',
  ].join('\n');
}

/**
 * Parse a GitHub PR reference into `{owner, repo, number}`.
 *
 * Thin alias for `parsePrRef` in `@arbitra/shared` — there is ONE PR-ref
 * parser in the product (issue #1046). There were three, and they
 * disagreed: this one accepted only `https?://github.com/o/r/pull/N`, the
 * `Case.current_pr_ref` schema validator accepted scheme-less, `www.` and
 * `api.github.com` forms, and `PrMergeChecker` carried an UNANCHORED copy
 * still vulnerable to the crafted-URL confusion that issue #1032 (M1) fixed
 * here. A ref one accepted and another rejected meant a stored ref could be
 * blessed at the boundary and then unpublishable at the status call.
 *
 * The shared parser keeps the anchoring property #1032 added — it strips a
 * leading scheme and `www.` and then matches the host at the START of what
 * remains, so `https://evil.example/?x=github.com/acme/demo/pull/1` still
 * does not parse. It additionally lowercases owner and repo, which is
 * correct for GitHub (case-insensitive) and required for comparing two refs.
 */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  return parsePrRef(url);
}

/** Extract owner/repo from repository_id (format: `owner/repo`) or PR URL */
export function parseOwnerRepo(
  repositoryId: string,
  prRef?: string,
  /** The registered repository's URL; used when `repositoryId` is an internal id. */
  repositoryUrl?: string,
): { owner: string; repo: string } | null {
  // Try repository_id first (format: owner/repo)
  const slashIdx = repositoryId.indexOf('/');
  if (slashIdx > 0 && !repositoryId.startsWith('repo_')) {
    return {
      owner: repositoryId.slice(0, slashIdx),
      repo: repositoryId.slice(slashIdx + 1),
    };
  }

  // Fallback: extract from PR URL
  if (prRef) {
    const parsed = parsePrUrl(prRef);
    if (parsed) return { owner: parsed.owner, repo: parsed.repo };
  }

  return ownerRepoFromUrl(repositoryUrl);
}

/** `owner/repo` from a GitHub repository URL (https or scp-style, optional `.git`). */
export function ownerRepoFromUrl(url: string | undefined): { owner: string; repo: string } | null {
  const match = url?.trim().match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

/**
 * Resolves a git diff for a Case by fetching it from the GitHub API.
 *
 * Strategies (in order):
 * 1. If `current_pr_ref` is set (GitHub PR URL), fetch the PR diff directly.
 * 2. If only `current_branch` is set, fetch a compare diff (main...branch).
 * 3. If neither is available, fail with reason `no_diff_source`.
 * 4. If a source is present but every GitHub call for it failed (auth, rate
 *    limit, 404, wrong default branch), fail with reason `diff_fetch_failed`
 *    — a caller that only sees a bare `null` cannot tell this apart from (3)
 *    and sends the operator to fix the wrong thing (issue #1054).
 */
export class DiffResolver {
  private readonly token: string | undefined;

  constructor(token?: string) {
    this.token = token ?? process.env.GITHUB_TOKEN;
  }

  /**
   * `repositoryUrl` is the registered repository's URL; it supplies
   * `owner/repo` for the branch compare when `repository_id` is an internal id.
   */
  async resolve(case_: Case, repositoryUrl?: string): Promise<DiffResolveResult> {
    let attemptedFetch = false;

    // Strategy 1: PR diff
    if (case_.current_pr_ref) {
      const parsed = parsePrUrl(case_.current_pr_ref);
      if (parsed) {
        attemptedFetch = true;
        const prDiff = await this.fetchPrDiff(parsed.owner, parsed.repo, parsed.number);
        if (prDiff) return { ok: true, ...prDiff };
        // PR diff may fail (e.g. too many files → 406). Fall through to branch compare.
      }
    }

    // Strategy 2: Branch compare (also used as fallback when PR diff fails)
    if (case_.current_branch) {
      const ownerRepo = parseOwnerRepo(case_.repository_id ?? '', case_.current_pr_ref, repositoryUrl);
      if (ownerRepo) {
        attemptedFetch = true;
        const compareDiff = await this.fetchCompareDiff(ownerRepo.owner, ownerRepo.repo, case_.current_branch);
        if (compareDiff) return { ok: true, ...compareDiff };
      }
    }

    return { ok: false, reason: attemptedFetch ? 'diff_fetch_failed' : 'no_diff_source' };
  }

  private async fetchPrDiff(owner: string, repo: string, prNumber: number): Promise<DiffResult | null> {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    // Two calls, not one: the `v3.diff` Accept header returns raw diff TEXT
    // with no JSON body, so the PR's head SHA has to come from a second,
    // ordinary (JSON) request to the same endpoint (issue #1054 — see the
    // `headSha` doc comment on `DiffResult`).
    const [diffResponse, metaResponse] = await Promise.all([
      this.githubFetch(url, { headers: { Accept: 'application/vnd.github.v3.diff' } }),
      this.githubFetch(url, { headers: { Accept: 'application/vnd.github+json' } }),
    ]);

    if (!diffResponse.ok) {
      console.error(`[DiffResolver] PR diff fetch failed: ${diffResponse.status} ${diffResponse.statusText} for ${owner}/${repo}#${prNumber}`);
      return null;
    }
    if (!metaResponse.ok) {
      console.error(`[DiffResolver] PR metadata fetch failed (head SHA unresolved): ${metaResponse.status} ${metaResponse.statusText} for ${owner}/${repo}#${prNumber}`);
      return null;
    }

    const diff = await diffResponse.text();
    const meta = (await metaResponse.json()) as { head?: { sha?: string } };
    const headSha = meta.head?.sha;
    if (!headSha) {
      console.error(`[DiffResolver] PR metadata response carried no head.sha for ${owner}/${repo}#${prNumber}`);
      return null;
    }
    return this.wrapResult(diff, 'pr', headSha);
  }

  private async fetchCompareDiff(owner: string, repo: string, branch: string): Promise<DiffResult | null> {
    const compareUrl = `https://api.github.com/repos/${owner}/${repo}/compare/main...${encodeURIComponent(branch)}`;
    // The compare diff tells us WHAT changed but not the branch tip's SHA in
    // a form the `v3.diff` response carries — fetch the branch's current
    // commit separately (same reasoning as `fetchPrDiff`, issue #1054).
    const commitUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`;
    const [diffResponse, commitResponse] = await Promise.all([
      this.githubFetch(compareUrl, { headers: { Accept: 'application/vnd.github.v3.diff' } }),
      this.githubFetch(commitUrl, { headers: { Accept: 'application/vnd.github+json' } }),
    ]);

    if (!diffResponse.ok) {
      console.error(`[DiffResolver] Compare diff fetch failed: ${diffResponse.status} ${diffResponse.statusText} for ${owner}/${repo} main...${branch}`);
      return null;
    }
    if (!commitResponse.ok) {
      console.error(`[DiffResolver] Branch commit fetch failed (head SHA unresolved): ${commitResponse.status} ${commitResponse.statusText} for ${owner}/${repo}@${branch}`);
      return null;
    }

    const diff = await diffResponse.text();
    const commit = (await commitResponse.json()) as { sha?: string };
    if (!commit.sha) {
      console.error(`[DiffResolver] Branch commit response carried no sha for ${owner}/${repo}@${branch}`);
      return null;
    }
    return this.wrapResult(diff, 'branch_compare', commit.sha);
  }

  private wrapResult(diff: string, source: DiffResult['source'], headSha: string): DiffResult {
    const lines = diff.split('\n');
    const lineCount = lines.length;
    if (lineCount <= MAX_DIFF_LINES) {
      return { diff, source, truncated: false, lineCount, headSha };
    }
    const kept = lines.slice(0, MAX_DIFF_LINES).join('\n');
    return {
      diff: `${kept}\n${buildDiffTruncationMarker(MAX_DIFF_LINES, lineCount)}`,
      source,
      truncated: true,
      lineCount,
      headSha,
    };
  }

  private async githubFetch(url: string, init: { headers: Record<string, string> }): Promise<Response> {
    const headers: Record<string, string> = {
      ...init.headers,
      'User-Agent': 'Arbitra/1.0',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return fetch(url, { headers });
  }
}
