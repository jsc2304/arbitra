import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case } from '@arbitra/shared';
import { fetchReviewContext } from './review-context.js';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_test_1',
    title: 'Fix login bug',
    description: 'Users cannot log in with SSO',
    source_type: 'manual',
    source_ref: 'manual',
    status: 'in_review',
    risk_level: 'medium',
    priority: 'high',
    validation_track: 'direct',
    owner_user_id: 'user_1',
    project_id: 'proj_1',
    repository_id: 'acme/widgets',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Case;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

function base64(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

describe('fetchReviewContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when the case has no PR ref and no branch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchReviewContext(
      makeCase({ current_pr_ref: undefined, current_branch: undefined }),
      'tok',
    );

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('happy path: PR case fetches head sha, changed file contents, and repo tree', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/pulls/42/files')) {
        return jsonResponse([
          { filename: 'src/foo.ts', status: 'modified' },
          { filename: 'src/removed.ts', status: 'removed' },
        ]);
      }
      if (url.includes('/pulls/42')) {
        return jsonResponse({ head: { sha: 'abc123' } });
      }
      if (url.includes('/contents/src/foo.ts')) {
        return jsonResponse({
          content: base64('import { bar } from "./bar";\nexport function foo() { return bar(); }\n'),
          encoding: 'base64',
        });
      }
      if (url.includes('/git/trees/abc123')) {
        return jsonResponse({
          tree: [
            { path: 'src/foo.ts', type: 'blob' },
            { path: 'src/bar.ts', type: 'blob' },
            { path: 'src', type: 'tree' },
          ],
          truncated: false,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const case_ = makeCase({ current_pr_ref: 'https://github.com/acme/widgets/pull/42' });
    const result = await fetchReviewContext(case_, 'tok');

    expect(result).not.toBeNull();
    expect(result!.head_ref).toBe('abc123');
    expect(result!.changed_files).toHaveLength(1);
    expect(result!.changed_files[0]!.path).toBe('src/foo.ts');
    expect(result!.changed_files[0]!.content).toContain('import { bar }');
    expect(result!.changed_files[0]!.truncated).toBe(false);
    expect(result!.repo_tree.truncated).toBe(false);
    expect(result!.repo_tree.paths).toEqual(['src/foo.ts', 'src/bar.ts']);

    // Authorization header used
    const call = fetchMock.mock.calls.find(([url]: [string]) => url.includes('/pulls/42') && !url.includes('files'));
    expect(call).toBeDefined();
    const init = call![1] as { headers: Record<string, string> };
    expect(init.headers['Authorization']).toBe('Bearer tok');
  });

  it('branch-only case: uses branch name as ref, fetches compare files and tree', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/compare/main...feature%2Fx')) {
        return jsonResponse({
          files: [{ filename: 'src/baz.ts', status: 'added' }],
        });
      }
      if (url.includes('/contents/src/baz.ts')) {
        return jsonResponse({
          content: base64('export const baz = 1;\n'),
          encoding: 'base64',
        });
      }
      if (url.includes('/git/trees/feature%2Fx')) {
        return jsonResponse({ tree: [{ path: 'src/baz.ts', type: 'blob' }], truncated: false });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const case_ = makeCase({ current_pr_ref: undefined, current_branch: 'feature/x' });
    const result = await fetchReviewContext(case_, 'tok');

    expect(result).not.toBeNull();
    expect(result!.head_ref).toBe('feature/x');
    expect(result!.changed_files).toHaveLength(1);
    expect(result!.changed_files[0]!.path).toBe('src/baz.ts');
    expect(result!.repo_tree.paths).toEqual(['src/baz.ts']);
  });

  it('caps a large file to a preview and marks it truncated', async () => {
    const bigContent = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/pulls/1/files')) {
        return jsonResponse([{ filename: 'src/big.ts', status: 'modified' }]);
      }
      if (url.includes('/pulls/1')) {
        return jsonResponse({ head: { sha: 'sha1' } });
      }
      if (url.includes('/contents/src/big.ts')) {
        return jsonResponse({ content: base64(bigContent), encoding: 'base64' });
      }
      if (url.includes('/git/trees/sha1')) {
        return jsonResponse({ tree: [], truncated: false });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const case_ = makeCase({ current_pr_ref: 'https://github.com/acme/widgets/pull/1' });
    const result = await fetchReviewContext(case_, 'tok');

    expect(result).not.toBeNull();
    expect(result!.changed_files).toHaveLength(1);
    const file = result!.changed_files[0]!;
    expect(file.truncated).toBe(true);
    expect(file.content.split('\n').length).toBeLessThanOrEqual(120);
  });

  it('caps the repo tree at 3000 paths and marks it truncated', async () => {
    const manyPaths = Array.from({ length: 3500 }, (_, i) => ({ path: `src/file${i}.ts`, type: 'blob' }));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/pulls/7/files')) {
        return jsonResponse([]);
      }
      if (url.includes('/pulls/7')) {
        return jsonResponse({ head: { sha: 'shaTree' } });
      }
      if (url.includes('/git/trees/shaTree')) {
        return jsonResponse({ tree: manyPaths, truncated: false });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const case_ = makeCase({ current_pr_ref: 'https://github.com/acme/widgets/pull/7' });
    const result = await fetchReviewContext(case_, 'tok');

    expect(result).not.toBeNull();
    expect(result!.repo_tree.truncated).toBe(true);
    expect(result!.repo_tree.paths).toHaveLength(3000);
  });

  it('caps changed files at 20 and skips binary/removed entries', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({ filename: `src/f${i}.ts`, status: 'modified' }));
    entries.push({ filename: 'assets/logo.png', status: 'added' });
    entries.push({ filename: 'src/deleted.ts', status: 'removed' });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/pulls/9/files')) {
        return jsonResponse(entries);
      }
      if (url.includes('/pulls/9')) {
        return jsonResponse({ head: { sha: 'shaCap' } });
      }
      if (url.includes('/contents/')) {
        return jsonResponse({ content: base64('export const x = 1;\n'), encoding: 'base64' });
      }
      if (url.includes('/git/trees/shaCap')) {
        return jsonResponse({ tree: [], truncated: false });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const case_ = makeCase({ current_pr_ref: 'https://github.com/acme/widgets/pull/9' });
    const result = await fetchReviewContext(case_, 'tok');

    expect(result).not.toBeNull();
    expect(result!.changed_files.length).toBeLessThanOrEqual(20);
    expect(result!.changed_files.every((f) => !f.path.endsWith('.png'))).toBe(true);
    expect(result!.changed_files.every((f) => f.path !== 'src/deleted.ts')).toBe(true);
  });

  it('fails soft to null when the PR fetch rejects outright', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);

    const case_ = makeCase({ current_pr_ref: 'https://github.com/acme/widgets/pull/5' });
    const result = await fetchReviewContext(case_, 'tok');

    expect(result).toBeNull();
  });

  it('fails soft to null on a 403 from the PR endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'Forbidden' }, 403));
    vi.stubGlobal('fetch', fetchMock);

    const case_ = makeCase({ current_pr_ref: 'https://github.com/acme/widgets/pull/5' });
    const result = await fetchReviewContext(case_, 'tok');

    expect(result).toBeNull();
  });

  it('returns partial data when the tree fetch fails but PR info succeeded', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/pulls/3/files')) {
        return jsonResponse([{ filename: 'src/ok.ts', status: 'modified' }]);
      }
      if (url.includes('/pulls/3')) {
        return jsonResponse({ head: { sha: 'shaPartial' } });
      }
      if (url.includes('/contents/src/ok.ts')) {
        return jsonResponse({ content: base64('export const ok = true;\n'), encoding: 'base64' });
      }
      if (url.includes('/git/trees/shaPartial')) {
        throw new Error('tree fetch exploded');
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const case_ = makeCase({ current_pr_ref: 'https://github.com/acme/widgets/pull/3' });
    const result = await fetchReviewContext(case_, 'tok');

    expect(result).not.toBeNull();
    expect(result!.changed_files).toHaveLength(1);
    expect(result!.repo_tree).toEqual({ paths: [], truncated: false });
  });

  it('works without a token (no Authorization header sent)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/pulls/11/files')) return jsonResponse([]);
      if (url.includes('/pulls/11')) return jsonResponse({ head: { sha: 'shaNoTok' } });
      if (url.includes('/git/trees/shaNoTok')) return jsonResponse({ tree: [], truncated: false });
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.GITHUB_TOKEN;

    const case_ = makeCase({ current_pr_ref: 'https://github.com/acme/widgets/pull/11' });
    const result = await fetchReviewContext(case_, undefined);

    expect(result).not.toBeNull();
    const call = fetchMock.mock.calls[0]!;
    const init = call[1] as { headers: Record<string, string> };
    expect(init.headers['Authorization']).toBeUndefined();
  });
});
