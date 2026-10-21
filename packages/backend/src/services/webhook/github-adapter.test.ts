/**
 * Tests for `parseGitHubWebhook()` — the GitHub-payload → Arbitra-internal
 * `GitWebhookPayload` translation layer — and `fetchPullRequestChangedFiles`,
 * the standalone GitHub-files-API fetcher it used to call directly.
 *
 * Focus for `parseGitHubWebhook` is the `commit_sha` resolution for
 * `pull_request` events: merged PRs must record the actual merge commit
 * (`merge_commit_sha`), not the PR head, because squash/rebase/merge flows
 * produce a distinct merge SHA and the downstream `pr_merged` evidence labels
 * this value as the "merge SHA".
 *
 * `parseGitHubWebhook` does NOT call `fetchPullRequestChangedFiles` itself —
 * see its doc-comment. `WebhookService.handleGitWebhook` does, after
 * resolving the Arbitra `Repository` row so it has a per-repo token to pass
 * (issue #1028); that resolution + fetch + failure-signal wiring is covered
 * in `webhook-service.changed-files-token.test.ts`, not here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseGitHubWebhook, fetchPullRequestChangedFiles } from './github-adapter.js';

// ── Fixture builder ──────────────────────────────────────────────────────

function prBody(overrides: {
  action?: string;
  merged?: boolean;
  headSha?: string;
  mergeCommitSha?: string | null;
} = {}): Record<string, unknown> {
  const { action = 'closed', merged, headSha = 'head_sha_abc', mergeCommitSha } = overrides;
  const pr: Record<string, unknown> = {
    number: 7,
    html_url: 'https://github.com/acme/demo/pull/7',
    title: 'Add widget',
    body: 'desc',
    head: { ref: 'feat/x', sha: headSha },
    changed_files: 3,
  };
  if (merged !== undefined) pr['merged'] = merged;
  // Distinguish "key absent" from "key present but null" — both should fall
  // back to head.sha, and GitHub sends `null` for unmerged PRs.
  if (mergeCommitSha !== undefined) pr['merge_commit_sha'] = mergeCommitSha;
  return {
    action,
    pull_request: pr,
    repository: { id: 4242, full_name: 'acme/demo' },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('parseGitHubWebhook — pull_request commit_sha resolution', () => {
  it('uses merge_commit_sha for a merged PR (the actual merge commit, not head)', async () => {
    const result = await parseGitHubWebhook(
      'pull_request',
      prBody({ action: 'closed', merged: true, headSha: 'head_111', mergeCommitSha: 'merge_999' }),
    );

    expect(result).not.toBeNull();
    expect(result!.merged).toBe(true);
    expect(result!.commit_sha).toBe('merge_999');
  });

  it('falls back to head.sha when a merged PR has a null merge_commit_sha', async () => {
    const result = await parseGitHubWebhook(
      'pull_request',
      prBody({ action: 'closed', merged: true, headSha: 'head_222', mergeCommitSha: null }),
    );

    expect(result).not.toBeNull();
    expect(result!.merged).toBe(true);
    expect(result!.commit_sha).toBe('head_222');
  });

  it('uses head.sha for a non-merged PR (opened) even if merge_commit_sha is present', async () => {
    // GitHub populates merge_commit_sha with a test-merge SHA on open PRs; for
    // non-merged events we must keep recording the head SHA unchanged.
    const result = await parseGitHubWebhook(
      'pull_request',
      prBody({ action: 'opened', merged: false, headSha: 'head_333', mergeCommitSha: 'test_merge_777' }),
    );

    expect(result).not.toBeNull();
    expect(result!.merged).toBe(false);
    expect(result!.commit_sha).toBe('head_333');
  });

  it('uses head.sha when merged is absent (non-merge lifecycle event)', async () => {
    const result = await parseGitHubWebhook(
      'pull_request',
      prBody({ action: 'synchronize', headSha: 'head_444' }),
    );

    expect(result).not.toBeNull();
    expect(result!.commit_sha).toBe('head_444');
  });
});

describe('parseGitHubWebhook — changed_files / changed_files_fetch_failed are never set here (issue #1028)', () => {
  // `parseGitHubWebhook` used to fetch real changed-file paths itself for
  // `opened`/`synchronize` actions; that moved into `WebhookService.
  // handleGitWebhook` so the fetch can use the resolved Repository row's
  // per-repo token. Reintroducing a fetch call inside `parseGitHubWebhook`
  // would make these assertions fail (and would resurrect issue #1028: no
  // repo-identity resolution has happened yet at this point, so it could
  // only ever use the global GITHUB_TOKEN again).
  it('never touches the network and leaves changed_files/changed_files_fetch_failed unset for an opened PR', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await parseGitHubWebhook('pull_request', prBody({ action: 'opened' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result!.changed_files).toBeUndefined();
    expect(result!.changed_files_fetch_failed).toBeUndefined();
    expect(result!.changed_file_count).toBe(3); // the COUNT from the payload is still captured

    vi.unstubAllGlobals();
  });

  it('never touches the network for a synchronize action either', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await parseGitHubWebhook('pull_request', prBody({ action: 'synchronize' }));

    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

// Issue #1009 follow-up (F1): `repository.default_branch` is present on the
// `repository` object of every webhook event that carries one — captured
// here so `WebhookService` can opportunistically backfill it onto the
// matched `Repository` row, the same way `repository_id`/`repository`
// already are.
describe('parseGitHubWebhook — repository_default_branch capture (#1009)', () => {
  it('captures default_branch from a pull_request event', async () => {
    const body = prBody({ action: 'opened' });
    (body['repository'] as Record<string, unknown>)['default_branch'] = 'main';

    const result = await parseGitHubWebhook('pull_request', body);

    expect(result!.repository_default_branch).toBe('main');
  });

  it('captures default_branch from a push event', async () => {
    const result = await parseGitHubWebhook('push', {
      ref: 'refs/heads/feat/x',
      after: 'sha_abc',
      repository: { id: 4242, full_name: 'acme/demo', default_branch: 'develop' },
    });

    expect(result!.repository_default_branch).toBe('develop');
  });

  it('captures default_branch from a repository event', async () => {
    const result = await parseGitHubWebhook('repository', {
      action: 'edited',
      repository: { id: 4242, full_name: 'acme/demo', default_branch: 'trunk', owner: { login: 'acme' } },
      changes: {},
    });

    expect(result!.repository_default_branch).toBe('trunk');
  });

  it('leaves repository_default_branch unset when the payload omits it', async () => {
    const result = await parseGitHubWebhook('pull_request', prBody({ action: 'opened' }));

    expect(result!.repository_default_branch).toBeUndefined();
  });

  it('ignores a non-string default_branch rather than propagating a malformed value', async () => {
    const body = prBody({ action: 'opened' });
    (body['repository'] as Record<string, unknown>)['default_branch'] = 12345;

    const result = await parseGitHubWebhook('pull_request', body);

    expect(result!.repository_default_branch).toBeUndefined();
  });
});

describe('fetchPullRequestChangedFiles', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('paginates and caps at 300 files (3 pages of 100)', async () => {
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => ({ filename: `file_${n}_${i}.ts` }));
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => page(1) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => page(2) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => page(3) });

    const files = await fetchPullRequestChangedFiles('acme', 'demo', 7, 'tok_test');

    expect(files).toHaveLength(300);
    expect(fetchMock).toHaveBeenCalledTimes(3); // never fetches a 4th page
  });

  it('stops paginating once a short page is returned', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ filename: 'only-one.ts' }],
    });

    const files = await fetchPullRequestChangedFiles('acme', 'demo', 7, 'tok_test');

    expect(files).toEqual(['only-one.ts']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends an Authorization header when a token is available', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });

    await fetchPullRequestChangedFiles('acme', 'demo', 7, 'tok_secret');

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as { headers: Record<string, string> }).headers['Authorization']).toBe('Bearer tok_secret');
  });

  it('omits the Authorization header when no token is available', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });

    await fetchPullRequestChangedFiles('acme', 'demo', 7, undefined);

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as { headers: Record<string, string> }).headers['Authorization']).toBeUndefined();
  });

  it('returns null on a non-ok response with nothing collected yet', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });

    const files = await fetchPullRequestChangedFiles('acme', 'demo', 7, 'tok_test');
    expect(files).toBeNull();
  });

  it('returns null when the first page fetch throws (network error)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const files = await fetchPullRequestChangedFiles('acme', 'demo', 7, 'tok_test');
    expect(files).toBeNull();
  });

  it('returns the partial list (not null) when an earlier page succeeded and a later page fails', async () => {
    // Page 1 is a full 100-file page (so pagination continues), page 2 fails.
    // The doc-comment on `fetchPullRequestChangedFiles` is explicit that this
    // is a DELIBERATE partial-success return, not a bug: a partial file list
    // is still real signal for the risk-pattern scan, better than falling
    // all the way back to the text heuristic. This is also why the caller
    // (`WebhookService.handleGitWebhook`) cannot distinguish "fully
    // successful multi-page fetch" from "partial fetch, later page failed"
    // from the return value alone — both are a truthy, non-empty array — and
    // therefore does NOT set `changed_files_fetch_failed` in this case.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `file_${i}.ts` }));
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => page1 })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const files = await fetchPullRequestChangedFiles('acme', 'demo', 7, 'tok_test');

    expect(files).not.toBeNull();
    expect(files).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
