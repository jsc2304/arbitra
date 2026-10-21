import crypto from 'node:crypto';
import type { GitWebhookPayload } from './webhook-service.js';

/**
 * GitHub's own page-size ceiling for `GET /pulls/{number}/files`.
 */
const GITHUB_FILES_PER_PAGE = 100;

/**
 * Hard cap on how many changed-file paths `fetchPullRequestChangedFiles`
 * will collect for one PR, expressed as a page count (300 files / 100 per
 * page = 3 pages). Bounds both the number of GitHub API calls per webhook
 * and the size of what gets handed to `detectCaseFields` — a PR touching
 * hundreds of files gains nothing from seeing file #301 onward, and the
 * risk-file-pattern scan (`case-detection-service.ts`) only needs to find
 * ONE matching path to peg the highest risk level.
 */
const MAX_CHANGED_FILES_PAGES = 3;

/**
 * Fetches the real changed-file paths for a pull request via
 * `GET /repos/{owner}/{repo}/pulls/{number}/files` (paginated) using plain
 * `fetch` — like the neighboring `PrMergeChecker` in this same directory —
 * rather than pulling in a GitHub client library for a single lightweight
 * webhook-adapter call.
 *
 * Auth: `token`, resolved by the caller. `WebhookService.handleGitWebhook`
 * (issue #1028) passes the resolved Arbitra `Repository` row's per-repo
 * `github_token` when set, falling back to `GITHUB_TOKEN` — the same
 * precedence `resolveArbitraRepoResult` uses to find that row in the first
 * place, inherited for free by calling this AFTER that resolution instead of
 * duplicating its id/full_name/conflict-handling logic here. Defaults to
 * `process.env['GITHUB_TOKEN']` directly for callers (e.g. tests) that don't
 * go through repo resolution. Unauthenticated calls work for public repos
 * but are far more likely to hit GitHub's low anonymous rate limit, and fail
 * outright for private repos.
 *
 * Returns `null` when NO files were collected before a failure (non-2xx
 * response, network error on the first page) — the caller treats `null` as
 * "fetch failed" and sets `changed_files_fetch_failed: true` on the payload
 * instead of guessing at "no real file list available", so a persistent
 * auth/rate-limit failure stays distinguishable from a PR that genuinely
 * changed no files (issue #1028). If a LATER page fails after earlier pages
 * already returned files, the partial list collected so far is returned
 * instead of `null` (a partial signal beats no signal for the risk-pattern
 * scan) — that case is logged here (`console.error` below) but does NOT set
 * `changed_files_fetch_failed`, since the caller only sees a truthy,
 * non-empty array indistinguishable from a fully successful fetch. Either
 * way `changed_files` stays unset only on the `null` path; `detectCaseFields`
 * falls back to its text heuristic exactly then. This function never throws:
 * a GitHub API hiccup must never fail webhook processing.
 */
export async function fetchPullRequestChangedFiles(
  owner: string,
  repo: string,
  prNumber: number,
  token: string | undefined = process.env['GITHUB_TOKEN'],
): Promise<string[] | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Arbitra/1.0',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const files: string[] = [];
  try {
    for (let page = 1; page <= MAX_CHANGED_FILES_PAGES; page++) {
      const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${GITHUB_FILES_PER_PAGE}&page=${page}`;
      const response = await fetch(url, { headers });
      if (!response.ok) {
        console.error(
          `[github-adapter] GitHub API returned ${response.status} fetching changed files for ${owner}/${repo}#${prNumber}`,
        );
        // A partial page fetched before the failure is still real signal —
        // better than falling all the way back to the text heuristic.
        return files.length > 0 ? files : null;
      }
      const page_data = (await response.json()) as Array<{ filename?: unknown }>;
      for (const entry of page_data) {
        if (typeof entry.filename === 'string') files.push(entry.filename);
      }
      if (page_data.length < GITHUB_FILES_PER_PAGE) break; // last page
    }
    return files;
  } catch (err) {
    console.error(
      `[github-adapter] Failed to fetch changed files for ${owner}/${repo}#${prNumber}:`,
      err,
    );
    return files.length > 0 ? files : null;
  }
}

/**
 * Fetches a PR's head SHA, source branch name, title, and body via
 * `GET /repos/{owner}/{repo}/pulls/{number}` — everything the admin
 * commit-status recovery endpoint (issue #1032) needs to run the SAME
 * case-resolution ladder `handleGitWebhook` runs on a live `pull_request`
 * event, since that endpoint has no webhook payload of its own to read
 * `branch`/`title`/`body` from.
 *
 * Same auth/style as `fetchPullRequestChangedFiles` above. Returns `null`
 * on any failure (non-2xx response, network error, or a response missing
 * `head.sha`/`head.ref`) — callers must treat that as "cannot resolve this
 * PR right now" and fail the operation rather than guess.
 */
export interface PullRequestDetails {
  headSha: string;
  branch: string;
  title: string;
  body: string;
}

export async function fetchPullRequestDetails(
  owner: string,
  repo: string,
  prNumber: number,
  token: string | undefined = process.env['GITHUB_TOKEN'],
): Promise<PullRequestDetails | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Arbitra/1.0',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      console.error(
        `[github-adapter] GitHub API returned ${response.status} fetching PR details for ${owner}/${repo}#${prNumber}`,
      );
      return null;
    }
    const data = (await response.json()) as {
      head?: { sha?: unknown; ref?: unknown };
      title?: unknown;
      body?: unknown;
    };
    const headSha = data.head?.sha;
    const branch = data.head?.ref;
    if (typeof headSha !== 'string' || typeof branch !== 'string') {
      return null;
    }
    return {
      headSha,
      branch,
      title: typeof data.title === 'string' ? data.title : '',
      body: typeof data.body === 'string' ? data.body : '',
    };
  } catch (err) {
    console.error(
      `[github-adapter] Failed to fetch PR details for ${owner}/${repo}#${prNumber}:`,
      err,
    );
    return null;
  }
}

export function verifyGitHubSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const hmac = crypto.createHmac('sha256', secret);
  const digest = `sha256=${hmac.update(payload).digest('hex')}`;
  // timingSafeEqual throws on length mismatch; short-circuit so a malformed
  // signature header returns `false` instead of crashing the handler and
  // surfacing a 500 that leaks stack traces to GitHub.
  const sigBuf = Buffer.from(signature);
  const digBuf = Buffer.from(digest);
  if (sigBuf.length !== digBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, digBuf);
}

/**
 * Parses a GitHub webhook body into the Arbitra-internal `GitWebhookPayload`.
 *
 * Supported events:
 * - `pull_request` — primary driver for case creation & PR lifecycle.
 * - `push`         — branch updates landing outside of PRs.
 * - `repository`   — repo meta events. We only care about `action: 'renamed'`
 *                    so that stored `github_full_name` can be refreshed, but
 *                    the payload always carries `repository.id` which the
 *                    handler uses to look up the arbitra repo row.
 *
 * The numeric `repository.id` is extracted for every event; matching by it
 * (rather than `full_name`) keeps webhook routing alive across GitHub org /
 * repo renames.
 *
 * `pull_request` `opened`/`synchronize` events need the PR's real
 * changed-file paths (`WebhookService.updateCaseWithPR` routes those two
 * actions through Observed Case escalation, whose risk classification
 * (`detectCaseFields`) needs real paths, not just the `changed_files` COUNT
 * GitHub's webhook payload carries inline) — but that fetch does NOT happen
 * in this function. `parseGitHubWebhook` runs before the Arbitra `Repository`
 * row is resolved, so it has no per-repo `github_token` to authenticate
 * with; `WebhookService.handleGitWebhook` calls `fetchPullRequestChangedFiles`
 * itself, right after `resolveArbitraRepoResult` resolves that row (issue
 * #1028 — a private repo configured with only a per-repo token used to fail
 * this fetch every time it ran here, before that row was ever in hand), and
 * sets `changed_files` / `changed_files_fetch_failed` directly on the
 * payload this function returns.
 *
 * `push` events do NOT get a file list fetched for them at all: a push isn't
 * necessarily associated with any open PR (direct pushes, or a force-push to
 * a branch with no PR yet), and resolving "the" associated PR would need its
 * own extra GitHub API round trip (list PRs for a branch/head SHA) that this
 * change does not add. Escalation re-evaluation triggered by a `push`
 * webhook therefore runs on the TEXT heuristic only until a
 * `pull_request.synchronize` event arrives with real file paths — this is
 * a deliberate, documented limitation, not an oversight.
 */
export async function parseGitHubWebhook(
  event: string,
  body: Record<string, unknown>,
): Promise<GitWebhookPayload | null> {
  const repo = body['repository'] as Record<string, unknown> | undefined;
  const repoFullName = (repo?.['full_name'] as string) ?? '';
  const repoIdRaw = repo?.['id'];
  const repoId = typeof repoIdRaw === 'number' ? repoIdRaw : undefined;
  // GitHub's Repository object (embedded in `pull_request`, `push`, and
  // `repository` webhook payloads) carries `default_branch` — captured here
  // so `WebhookService` can opportunistically backfill it onto the matched
  // `Repository` row (issue #1009), the same way `repository_id`/
  // `repository` already are.
  const repoDefaultBranchRaw = repo?.['default_branch'];
  const repoDefaultBranch = typeof repoDefaultBranchRaw === 'string' ? repoDefaultBranchRaw : undefined;

  if (event === 'pull_request') {
    const pr = body['pull_request'] as Record<string, unknown> | undefined;

    const merged = pr?.['merged'] as boolean | undefined;
    const headSha = (pr?.['head'] as Record<string, unknown> | undefined)?.['sha'] as string | undefined;
    const mergeCommitSha = pr?.['merge_commit_sha'] as string | undefined;
    // For merged PRs the audit record must reference the actual merge commit,
    // not the PR head — squash/rebase/merge flows produce a distinct merge SHA
    // and downstream evidence labels this value as the "merge SHA". GitHub may
    // omit `merge_commit_sha` (e.g. not-yet-merged or unresolved mergeability),
    // so fall back to head.sha. Non-merged events keep using head.sha.
    const commitSha = merged === true ? (mergeCommitSha ?? headSha) : headSha;

    const action = body['action'] as string;
    const prNumber = pr?.['number'] as number | undefined;

    const payload: GitWebhookPayload = {
      action,
      event,
      pr_number: prNumber,
      pr_url: pr?.['html_url'] as string | undefined,
      branch: (pr?.['head'] as Record<string, unknown> | undefined)?.['ref'] as string | undefined,
      commit_sha: commitSha,
      repository: repoFullName,
      repository_id: repoId,
      repository_default_branch: repoDefaultBranch,
      title: pr?.['title'] as string | undefined,
      body: pr?.['body'] as string | undefined,
      merged: pr?.['merged'] as boolean | undefined,
      // GitHub's webhook payload only carries a COUNT here; real paths (used
      // by Observed Case escalation's risk classification) are fetched by
      // `WebhookService.handleGitWebhook` for the actions that need them —
      // see this function's doc-comment above for why that fetch doesn't
      // happen here (issue #1028).
      changed_file_count: pr?.['changed_files'] as number | undefined,
    };

    return payload;
  }

  if (event === 'push') {
    // No changed-file listing is fetched for `push` — see this function's
    // doc-comment above for why. `changed_files` is intentionally left
    // unset here.
    const ref = body['ref'] as string | undefined;
    return {
      action: 'push',
      event,
      branch: ref?.replace('refs/heads/', ''),
      commit_sha: body['after'] as string | undefined,
      repository: repoFullName,
      repository_id: repoId,
      repository_default_branch: repoDefaultBranch,
    };
  }

  if (event === 'repository') {
    // `repository.renamed` fires with `changes.repository.name.from` (old
    // short name) and the new `repository.full_name`. Other `repository`
    // actions (edited, privatized, transferred, archived, ...) are ignored
    // here — they don't affect matching today. If they become relevant,
    // branch on `body.action` instead of the outer event string.
    const action = body['action'] as string;
    const changes = body['changes'] as Record<string, unknown> | undefined;
    const repoChanges = changes?.['repository'] as Record<string, unknown> | undefined;
    const nameChange = repoChanges?.['name'] as Record<string, unknown> | undefined;
    const oldShortName = nameChange?.['from'] as string | undefined;
    // GitHub sends only the short name change; reconstruct old full_name
    // using the current owner (owner is immutable within a `renamed` event).
    const owner = (repo?.['owner'] as Record<string, unknown> | undefined)?.['login'] as string | undefined;
    const oldFullName = owner && oldShortName ? `${owner}/${oldShortName}` : undefined;
    return {
      action,
      event,
      repository: repoFullName,
      repository_id: repoId,
      repository_old_full_name: oldFullName,
      repository_default_branch: repoDefaultBranch,
    };
  }

  return null;
}
