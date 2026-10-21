/**
 * Tests for `/api/projects/match`. Covers the canonicalization matrix from
 * `docs/specs/device-flow-and-per-tool-tokens.md` §I.1: four URL forms map
 * to the same row; mixed case is lowercased; GitLab subgroups produce a
 * multi-segment slug; no match returns `{ matches: [] }`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { canonicalizeRepoUrl } from '../../auth/connect/_helpers';

const {
  reposByFullNameGet,
  reposAllGet,
  projectsGet,
  checkIsAdminMock,
  isEffectiveMemberMock,
  authenticate,
} = vi.hoisted(() => ({
  reposByFullNameGet: vi.fn(),
  reposAllGet: vi.fn(),
  projectsGet: vi.fn(),
  checkIsAdminMock: vi.fn(),
  isEffectiveMemberMock: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock('@arbitra/backend', () => {
  // Repositories chain: distinguish the `.where('github_full_name', '==',
  // ...)` indexed path from the unconstrained fallback `.limit(...).get()`.
  const repoQuery = () => {
    const obj: Record<string, unknown> = {
      where: () => {
        // Returning a chain whose `.limit().get()` resolves to the
        // by-full-name fixture lets the indexed path be exercised.
        const sub: Record<string, unknown> = {
          limit: () => sub,
          get: reposByFullNameGet,
        };
        return sub;
      },
      limit: () => obj,
      get: reposAllGet,
    };
    return obj;
  };
  return {
    collections: {
      repositories: () => repoQuery(),
      projects: () => ({ get: projectsGet }),
    },
    checkIsAdmin: checkIsAdminMock,
    isEffectiveMember: isEffectiveMemberMock,
    formatError: (error: unknown) => ({
      status: 500,
      body: { error: { message: error instanceof Error ? error.message : 'error' } },
    }),
  };
});

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    handleError: (err: unknown) => {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status });
    },
  };
});

import { GET } from './route';

function makeRequest(repoUrl: string | null): NextRequest {
  const url = new URL('http://localhost/api/projects/match');
  if (repoUrl !== null) url.searchParams.set('repo_url', repoUrl);
  return new NextRequest(url.toString(), { method: 'GET' });
}

function repoDocs(items: Array<{ repository_id: string; project_id: string; github_full_name?: string; url: string; name: string }>) {
  return {
    empty: items.length === 0,
    docs: items.map((data) => ({ data: () => data })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1', email: 'u@x' });
  checkIsAdminMock.mockResolvedValue(false);
  isEffectiveMemberMock.mockReturnValue(true);
  projectsGet.mockResolvedValue({
    docs: [{
      data: () => ({
        project_id: 'proj_99',
        name: 'arbitra-app',
        members: ['user_1'],
        reviewer_pool: [],
        tech_leads: [],
      }),
    }],
  });
});

describe('canonicalizeRepoUrl — pure helper', () => {
  it('maps git@…:owner/repo.git, https://github.com/owner/repo, /owner/repo.git, and trailing-slash to the same canonical', () => {
    const forms = [
      'git@github.com:foo/bar.git',
      'git@github.com:foo/bar',
      'https://github.com/foo/bar',
      'https://github.com/foo/bar.git',
      'https://github.com/foo/bar/',
      'https://www.github.com/foo/bar',
    ];
    const canonicals = forms.map(canonicalizeRepoUrl);
    for (const c of canonicals) {
      expect(c).toEqual({ host: 'github.com', slug: 'foo/bar' });
    }
  });

  it('lowercases mixed-case input (GitHub paths are case-insensitive)', () => {
    expect(canonicalizeRepoUrl('https://github.com/Foo/Bar')).toEqual({ host: 'github.com', slug: 'foo/bar' });
  });

  it('preserves GitLab subgroup hierarchy in the slug', () => {
    expect(canonicalizeRepoUrl('https://gitlab.com/group/sub/repo')).toEqual({
      host: 'gitlab.com',
      slug: 'group/sub/repo',
    });
  });

  it('returns null for garbage input', () => {
    expect(canonicalizeRepoUrl('')).toBeNull();
    expect(canonicalizeRepoUrl('not-a-url')).toBeNull();
  });
});

describe('GET /api/projects/match', () => {
  it('returns 400 when repo_url is missing', async () => {
    const res = await GET(makeRequest(null));
    expect(res.status).toBe(400);
  });

  it('matches by github_full_name and groups by project', async () => {
    reposByFullNameGet.mockResolvedValueOnce(repoDocs([
      { repository_id: 'repo_1', project_id: 'proj_99', github_full_name: 'foo/bar', url: 'https://github.com/foo/bar', name: 'bar' },
    ]));
    const res = await GET(makeRequest('git@github.com:foo/bar.git'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.matches).toHaveLength(1);
    expect(json.matches[0]).toMatchObject({
      project_id: 'proj_99',
      project_name: 'arbitra-app',
      repositories: [{ repository_id: 'repo_1', url: 'https://github.com/foo/bar', name: 'bar' }],
    });
  });

  it('returns empty matches when no repository row hits and no substring match', async () => {
    reposByFullNameGet.mockResolvedValue(repoDocs([]));
    reposAllGet.mockResolvedValue(repoDocs([
      { repository_id: 'repo_x', project_id: 'proj_99', github_full_name: 'unrelated/repo', url: 'https://github.com/unrelated/repo', name: 'repo' },
    ]));
    const res = await GET(makeRequest('https://github.com/no/match'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.matches).toEqual([]);
  });

  it('filters out projects the caller cannot access', async () => {
    reposByFullNameGet.mockResolvedValueOnce(repoDocs([
      { repository_id: 'repo_1', project_id: 'proj_99', github_full_name: 'foo/bar', url: 'https://github.com/foo/bar', name: 'bar' },
    ]));
    isEffectiveMemberMock.mockReturnValue(false);
    const res = await GET(makeRequest('https://github.com/foo/bar'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.matches).toEqual([]);
  });

  it('falls back to a substring scan for non-GitHub hosts (GitLab)', async () => {
    // The indexed by-full-name lookup is GitHub-only; for GitLab we expect
    // the fallback substring scan to be the only path that matches.
    reposByFullNameGet.mockResolvedValue(repoDocs([]));
    reposAllGet.mockResolvedValue(repoDocs([
      { repository_id: 'repo_gl', project_id: 'proj_99', url: 'https://gitlab.com/group/sub/repo', name: 'repo' },
    ]));
    const res = await GET(makeRequest('https://gitlab.com/group/sub/repo'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.matches).toHaveLength(1);
    expect(json.matches[0].repositories[0].repository_id).toBe('repo_gl');
  });
});
