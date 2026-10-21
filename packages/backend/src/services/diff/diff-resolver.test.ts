import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case } from '@arbitra/shared';
import {
  DiffResolver,
  ownerRepoFromUrl,
  parseOwnerRepo,
  MAX_DIFF_LINES,
  DIFF_TRUNCATION_MARKER_PREFIX,
} from './diff-resolver.js';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Big change',
    description: '',
    status: 'in_review',
    risk_level: 'medium',
    priority: 'normal',
    validation_track: 'direct',
    project_id: 'p1',
    repository_id: 'acme/widgets',
    current_pr_ref: 'https://github.com/acme/widgets/pull/7',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Case;
}

/** A syntactically plausible diff of exactly `lines` lines. */
function makeDiff(lines: number): string {
  const out = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts'];
  while (out.length < lines) out.push(`+line ${out.length}`);
  return out.slice(0, lines).join('\n');
}

type FetchInit = { headers?: Record<string, string> };

/**
 * Routes a mocked `fetch` by Accept header: the `v3.diff` request gets
 * `diffBody` as raw text, any other (JSON metadata) request gets a body
 * carrying `headSha` under both `head.sha` (what the PR endpoint returns)
 * and a bare `sha` (what the single-commit endpoint returns) — one mock
 * shape serves both `fetchPrDiff` and `fetchCompareDiff`.
 */
function mockFetchReturning(diffBody: string, headSha = 'sha_default') {
  return vi.fn(async (_url: string, init?: FetchInit) => {
    const accept = init?.headers?.Accept;
    if (accept === 'application/vnd.github.v3.diff') {
      return { ok: true, status: 200, statusText: 'OK', text: async () => diffBody };
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ sha: headSha, head: { sha: headSha } }) };
  }) as unknown as typeof fetch;
}

/**
 * Routes a mocked `fetch` by BOTH url substring and Accept header, so a test
 * can make one leg of a two-call resolve (diff vs. metadata; PR vs. branch
 * compare/commit) fail independently of the others.
 */
function mockFetchByUrl(
  routes: Array<{
    urlIncludes: string;
    accept: 'diff' | 'json';
    ok: boolean;
    status?: number;
    body?: string;
    sha?: string;
  }>,
) {
  return vi.fn(async (url: string, init?: FetchInit) => {
    const wantsDiff = init?.headers?.Accept === 'application/vnd.github.v3.diff';
    const route = routes.find(
      (r) => url.includes(r.urlIncludes) && (r.accept === 'diff') === wantsDiff,
    );
    if (!route) {
      throw new Error(`mockFetchByUrl: no route for ${url} (accept: ${init?.headers?.Accept})`);
    }
    if (wantsDiff) {
      return {
        ok: route.ok,
        status: route.status ?? (route.ok ? 200 : 500),
        statusText: route.ok ? 'OK' : 'Error',
        text: async () => route.body ?? '',
      };
    }
    return {
      ok: route.ok,
      status: route.status ?? (route.ok ? 200 : 500),
      statusText: route.ok ? 'OK' : 'Error',
      json: async () => ({ sha: route.sha, head: { sha: route.sha } }),
    };
  }) as unknown as typeof fetch;
}

describe('DiffResolver — truncation reporting (#877)', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('appends an explicit truncation marker to a diff over the line cap', async () => {
    const total = MAX_DIFF_LINES + 431;
    globalThis.fetch = mockFetchReturning(makeDiff(total));

    const result = await new DiffResolver('tok').resolve(makeCase());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.truncated).toBe(true);
    // The marker must live INSIDE the diff text: an LLM adapter that only
    // ever sees `diff` is otherwise never told it got a prefix.
    expect(result.diff).toContain(DIFF_TRUNCATION_MARKER_PREFIX);
    expect(result.diff).toContain(`Only the first ${MAX_DIFF_LINES} of ${total} lines`);
    // Content is still capped — the marker is additional, not a replacement.
    const contentLines = result.diff.split('\n').slice(0, MAX_DIFF_LINES);
    expect(contentLines).toHaveLength(MAX_DIFF_LINES);
    expect(contentLines[0]).toBe('diff --git a/src/a.ts b/src/a.ts');
  });

  it('reports the pre-truncation line count, not the size of the surviving prefix', async () => {
    const total = MAX_DIFF_LINES + 1;
    globalThis.fetch = mockFetchReturning(makeDiff(total));

    const result = await new DiffResolver('tok').resolve(makeCase());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lineCount).toBe(total);
  });

  it('leaves a diff under the cap untouched and reports its real line count', async () => {
    const body = makeDiff(600);
    globalThis.fetch = mockFetchReturning(body);

    const result = await new DiffResolver('tok').resolve(makeCase());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.truncated).toBe(false);
    expect(result.lineCount).toBe(600);
    expect(result.diff).toBe(body);
    expect(result.diff).not.toContain(DIFF_TRUNCATION_MARKER_PREFIX);
  });
});

// ---------------------------------------------------------------------------
// Commit identity (issue #1054)
// ---------------------------------------------------------------------------
//
// `Run.reviewed_head_sha` is what lets `review_run_completed` /
// `auto_approve_criteria_met` (preconditions.ts) require a completed review
// to match `Case.current_head_sha` before it counts toward the gate. The
// `v3.diff` Accept header returns raw diff text with no JSON body, so the
// head SHA has to come from a second, ordinary GitHub call — these tests
// prove that call actually happens and its result actually reaches the
// resolved `DiffResult`.

describe('DiffResolver — commit identity (issue #1054)', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('captures the PR head SHA via a second JSON metadata call', async () => {
    const fetchMock = mockFetchReturning(makeDiff(10), 'sha_pr_head_abc');
    globalThis.fetch = fetchMock;

    const result = await new DiffResolver('tok').resolve(makeCase());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.source).toBe('pr');
    expect(result.headSha).toBe('sha_pr_head_abc');
    // Two calls: the diff-text fetch AND the JSON metadata fetch that
    // resolves the head SHA — not one call reused for both purposes.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('captures the branch tip commit SHA for a branch-compare resolve', async () => {
    globalThis.fetch = mockFetchReturning(makeDiff(10), 'sha_branch_tip_def');

    const result = await new DiffResolver('tok').resolve(
      makeCase({ current_pr_ref: undefined, current_branch: 'feature/x' }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.source).toBe('branch_compare');
    expect(result.headSha).toBe('sha_branch_tip_def');
  });

  /** Reverts: the `ownerRepoFromUrl(repositoryUrl)` fallback in resolve(). */
  it('branch-compares a registered repository (internal id) using its URL', async () => {
    globalThis.fetch = mockFetchReturning(makeDiff(10), 'sha_tip');

    const result = await new DiffResolver('tok').resolve(
      makeCase({ repository_id: 'repo_abc123', current_pr_ref: undefined, current_branch: 'feature/x' }),
      'https://github.com/acme/widgets.git',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.source).toBe('branch_compare');
    expect(String((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0])).toContain('/repos/acme/widgets/compare/');
  });

  it('parses owner/repo from https and scp-style GitHub URLs', () => {
    expect(ownerRepoFromUrl('https://github.com/acme/widgets')).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(ownerRepoFromUrl('git@github.com:acme/widgets.git')).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(ownerRepoFromUrl('https://gitlab.com/acme/widgets')).toBeNull();
    expect(ownerRepoFromUrl(undefined)).toBeNull();
  });

  /** Reverts: the URL fallback in parseOwnerRepo, which review context and verification also use. */
  it('parseOwnerRepo falls back to the repository URL for an internal repository id', () => {
    expect(parseOwnerRepo('repo_abc123', undefined, 'https://github.com/acme/widgets')).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(parseOwnerRepo('repo_abc123')).toBeNull();
  });

  it('fails with no_diff_source (and never calls GitHub) when the case has neither a PR ref nor a branch', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await new DiffResolver('tok').resolve(
      makeCase({ current_pr_ref: undefined, current_branch: undefined }),
    );

    expect(result).toEqual({ ok: false, reason: 'no_diff_source' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails with diff_fetch_failed (not no_diff_source) when the PR diff fetch itself fails and there is no branch to fall back to', async () => {
    globalThis.fetch = mockFetchByUrl([
      { urlIncludes: '/pulls/', accept: 'diff', ok: false, status: 404 },
      { urlIncludes: '/pulls/', accept: 'json', ok: true, sha: 'unused' },
    ]);

    const result = await new DiffResolver('tok').resolve(
      makeCase({ current_branch: undefined }),
    );

    expect(result).toEqual({ ok: false, reason: 'diff_fetch_failed' });
  });

  it('fails with diff_fetch_failed when the diff fetch succeeds but the head-SHA metadata call fails', async () => {
    globalThis.fetch = mockFetchByUrl([
      { urlIncludes: '/pulls/', accept: 'diff', ok: true, body: makeDiff(10) },
      { urlIncludes: '/pulls/', accept: 'json', ok: false, status: 403 },
    ]);

    const result = await new DiffResolver('tok').resolve(
      makeCase({ current_branch: undefined }),
    );

    expect(result).toEqual({ ok: false, reason: 'diff_fetch_failed' });
  });

  it('falls back to branch compare (with its own head SHA) when the PR diff fetch fails but a branch is also set', async () => {
    globalThis.fetch = mockFetchByUrl([
      // PR diff fetch fails (e.g. too many files -> 406) …
      { urlIncludes: '/pulls/', accept: 'diff', ok: false, status: 406 },
      { urlIncludes: '/pulls/', accept: 'json', ok: true, sha: 'unused_pr_sha' },
      // … falls through to the branch-compare strategy, which succeeds.
      { urlIncludes: '/compare/', accept: 'diff', ok: true, body: makeDiff(20) },
      { urlIncludes: '/commits/', accept: 'json', ok: true, sha: 'sha_fallback_branch' },
    ]);

    const result = await new DiffResolver('tok').resolve(
      makeCase({ current_branch: 'feature/x' }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.source).toBe('branch_compare');
    expect(result.headSha).toBe('sha_fallback_branch');
  });
});
