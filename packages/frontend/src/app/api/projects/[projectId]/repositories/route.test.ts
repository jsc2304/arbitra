import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  whereGet,
  limitGet,
  setRepo,
  docGet,
  docUpdate,
  docDelete,
  generateId,
} = vi.hoisted(() => ({
  whereGet: vi.fn(),
  // Backs the direct `collections.repositories().limit(n).get()` scan
  // `findConflictingRepositoryByUrl` uses (issue #1048 follow-up F2) — a
  // SEPARATE mock from `whereGet` because that call has no `.where()` in
  // front of it (Firestore can't query on a parsed/derived url).
  limitGet: vi.fn(),
  setRepo: vi.fn(),
  docGet: vi.fn(),
  docUpdate: vi.fn(),
  docDelete: vi.fn(),
  // Real-shaped stub so the A8a id-format assertions below are meaningful
  // without pulling in the real `ids.js` (and its firebase-admin-adjacent
  // barrel) into a frontend-package test.
  generateId: vi.fn((entityType: string) => `${entityType === 'repository' ? 'repo_' : `${entityType}_`}abcdefgh12345678`),
}));

vi.mock('@arbitra/backend', async (importOriginal) => {
  // `parseRepoRef` / `sameRepoRef` are kept REAL (not mocked) — the url-
  // uniqueness tests below exercise the actual comparison the webhook
  // matcher uses, not a re-description of it.
  const actual = await importOriginal<typeof import('@arbitra/backend')>();
  return {
    ...actual,
    collections: {
      repositories: () => ({
        where: () => ({
          limit: () => ({
            get: whereGet,
          }),
        }),
        limit: () => ({
          get: limitGet,
        }),
        doc: () => ({
          set: setRepo,
          get: docGet,
          update: docUpdate,
          delete: docDelete,
        }),
      }),
    },
    generateId,
  };
});

const { authenticate, requireProjectAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    requireProjectAccess,
    handleError: (err: unknown) => {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status });
    },
  };
});

import { POST, PATCH, DELETE } from './route';

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/projects/proj_1/repositories', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function makePatchReq(repoId: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/projects/proj_1/repositories?repoId=${repoId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function makeDeleteReq(repoId: string): NextRequest {
  return new NextRequest(`http://localhost/api/projects/proj_1/repositories?repoId=${repoId}`, {
    method: 'DELETE',
  });
}

const params = { params: Promise.resolve({ projectId: 'proj_1' }) };

// The route imports `@arbitra/backend` lazily; the first cold load pulls in the
// whole backend (firebase-admin, …) and can exceed the 5 s per-test budget on a
// busy machine. Load it once up front so every test measures only the route.
beforeAll(async () => {
  await import('@arbitra/backend');
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireProjectAccess.mockResolvedValue(null);
  // Default: no existing repo shares the github_repository_id, and the
  // url-uniqueness scan finds no rows at all.
  whereGet.mockResolvedValue({ empty: true, docs: [] });
  limitGet.mockResolvedValue({ empty: true, docs: [] });
  setRepo.mockResolvedValue(undefined);
  docUpdate.mockResolvedValue(undefined);
  docDelete.mockResolvedValue(undefined);
});

describe('POST /api/projects/[projectId]/repositories', () => {
  it('registers a repo with a new github_repository_id (201)', async () => {
    const res = await POST(makeReq({ name: 'web', github_repository_id: 12345 }), params);

    expect(res.status).toBe(201);
    expect(setRepo).toHaveBeenCalledOnce();
    const persisted = setRepo.mock.calls[0]![0] as { github_repository_id?: number };
    expect(persisted.github_repository_id).toBe(12345);
  });

  it('rejects a second repo with the same github_repository_id (409 + existing repo id)', async () => {
    whereGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ data: () => ({ repository_id: 'repo_existing' }) }],
    });

    const res = await POST(makeReq({ name: 'web-dup', github_repository_id: 12345 }), params);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.existing_repository_id).toBe('repo_existing');
    expect(body.error.github_repository_id).toBe(12345);
    // The duplicate must never be written.
    expect(setRepo).not.toHaveBeenCalled();
  });

  it('registers a repo without github_repository_id unchanged (201, no dedup query)', async () => {
    const res = await POST(makeReq({ name: 'web-no-id' }), params);

    expect(res.status).toBe(201);
    expect(whereGet).not.toHaveBeenCalled();
    expect(setRepo).toHaveBeenCalledOnce();
    const persisted = setRepo.mock.calls[0]![0] as { github_repository_id?: number };
    expect(persisted.github_repository_id).toBeUndefined();
  });

  it('rejects a non-integer github_repository_id (400)', async () => {
    const res = await POST(makeReq({ name: 'web', github_repository_id: 'not-a-number' }), params);

    expect(res.status).toBe(400);
    expect(setRepo).not.toHaveBeenCalled();
  });

  it('mints repository_id via generateId("repository") instead of `repo_${Date.now()}` (A8a)', async () => {
    // Regression guard: two same-millisecond POSTs used to silently
    // overwrite each other via Firestore `.set()` because the id was
    // time-derived.
    const res = await POST(makeReq({ name: 'web' }), params);
    expect(res.status).toBe(201);
    expect(generateId).toHaveBeenCalledWith('repository');
    const persisted = setRepo.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted.repository_id).toMatch(/^repo_[A-Za-z0-9_-]+$/);
    expect(persisted.repository_id).not.toMatch(/^repo_\d+$/);
  });
});

// Issue #1048 follow-up F2: `url` uniqueness at registration, the same
// discipline `github_repository_id` already gets above. Before this,
// registering the same GitHub repository twice created two Arbitra rows
// that the webhook's step-3 resolver could only ever treat as ambiguous —
// reachable through ordinary use, not an edge case, since nothing stopped it
// at the source.
describe('POST /api/projects/[projectId]/repositories — url uniqueness (issue #1048 F2)', () => {
  it('rejects a url that resolves to the same repository as an existing row (409)', async () => {
    limitGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ data: () => ({ repository_id: 'repo_existing', url: 'https://github.com/acme/api' }) }],
    });

    const res = await POST(
      makeReq({ name: 'duplicate', url: 'https://github.com/acme/api.git' }), // same repo, different shape
      params,
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.existing_repository_id).toBe('repo_existing');
    expect(setRepo).not.toHaveBeenCalled();
  });

  it('accepts a url for a genuinely different repository', async () => {
    limitGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ data: () => ({ repository_id: 'repo_existing', url: 'https://github.com/acme/api' }) }],
    });

    const res = await POST(
      makeReq({ name: 'unrelated', url: 'https://github.com/acme/api-gateway' }),
      params,
    );

    expect(res.status).toBe(201);
    expect(setRepo).toHaveBeenCalledOnce();
    const persisted = setRepo.mock.calls[0]![0] as { url?: string };
    expect(persisted.url).toBe('https://github.com/acme/api-gateway');
  });

  it('does not block registration when url is omitted', async () => {
    const res = await POST(makeReq({ name: 'no-url' }), params);

    expect(res.status).toBe(201);
    expect(limitGet).not.toHaveBeenCalled();
    expect(setRepo).toHaveBeenCalledOnce();
  });

});

// Issue #1059 item 3: `url` was previously stored after `.trim()` only, with
// no check that it could ever resolve to a GitHub webhook delivery. A typo
// or a non-GitHub host used to be silently accepted, then produced a silent
// no-match at webhook time — and every no-match exit publishes
// `arbitra/case: success`, so the failure was invisible to the operator.
describe('POST /api/projects/[projectId]/repositories — url format validation (issue #1059)', () => {
  it('rejects unparseable free text with a 400, not a silent 201', async () => {
    const res = await POST(
      makeReq({ name: 'weird', url: 'not a url at all, just notes' }),
      params,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/does not resolve to a github\.com owner\/repo/);
    expect(setRepo).not.toHaveBeenCalled();
    // Format is checked before the uniqueness scan runs at all.
    expect(limitGet).not.toHaveBeenCalled();
  });

  it('rejects a well-formed url on a non-github.com host with a 400', async () => {
    const res = await POST(
      makeReq({ name: 'wrong-host', url: 'https://gitlab.com/acme/api' }),
      params,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/gitlab\.com/);
    expect(body.error.message).toMatch(/github\.com/);
    expect(setRepo).not.toHaveBeenCalled();
  });

  it('accepts a well-formed github.com url (format check does not block real registrations)', async () => {
    limitGet.mockResolvedValueOnce({ empty: true, docs: [] });

    const res = await POST(
      makeReq({ name: 'fine', url: 'https://github.com/acme/api' }),
      params,
    );

    expect(res.status).toBe(201);
    expect(setRepo).toHaveBeenCalledOnce();
  });
});

// Issue #1059 item 2: the uniqueness scan reads at most 200 rows. Past that
// bound, `conflict === null` no longer means "verified unique" — it means
// "no conflict among the rows we looked at". The guard must fail closed
// (refuse) rather than silently register a row it can no longer prove is
// unique.
describe('POST /api/projects/[projectId]/repositories — uniqueness scan bound (issue #1059 item 2)', () => {
  it('refuses registration with 503 when the scan hits its 200-row bound', async () => {
    limitGet.mockResolvedValueOnce({
      empty: false,
      docs: Array.from({ length: 200 }, (_, i) => ({
        data: () => ({ repository_id: `repo_${i}`, url: `https://github.com/acme/repo-${i}` }),
      })),
    });

    const res = await POST(
      makeReq({ name: 'new-repo', url: 'https://github.com/acme/brand-new' }),
      params,
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('repository_scan_bound_exceeded');
    expect(setRepo).not.toHaveBeenCalled();
  });

  it('registers normally when the scan returns fewer rows than the bound', async () => {
    limitGet.mockResolvedValueOnce({
      empty: false,
      docs: Array.from({ length: 5 }, (_, i) => ({
        data: () => ({ repository_id: `repo_${i}`, url: `https://github.com/acme/repo-${i}` }),
      })),
    });

    const res = await POST(
      makeReq({ name: 'new-repo', url: 'https://github.com/acme/brand-new' }),
      params,
    );

    expect(res.status).toBe(201);
    expect(setRepo).toHaveBeenCalledOnce();
  });
});

// `repoId` is a query param, not derived from the
// path — `requireProjectAccess(params.projectId, ...)` only proves the
// caller belongs to `proj_1`, not that `repoId` actually belongs to it. A
// member of proj_1 could otherwise PATCH/DELETE a `github_token`-bearing
// repo that belongs to proj_2 (IDOR) by supplying its repoId here.
describe('PATCH /api/projects/[projectId]/repositories — cross-project IDOR guard', () => {
  it('404s when the repo belongs to a different project', async () => {
    docGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ repository_id: 'repo_other', project_id: 'proj_2', name: 'other-proj-repo' }),
    });

    const res = await PATCH(makePatchReq('repo_other', { name: 'hijacked' }), params);

    expect(res.status).toBe(404);
    expect(docUpdate).not.toHaveBeenCalled();
  });

  it('404s when the repo does not exist', async () => {
    docGet.mockResolvedValueOnce({ exists: false, data: () => undefined });

    const res = await PATCH(makePatchReq('repo_missing', { name: 'x' }), params);

    expect(res.status).toBe(404);
    expect(docUpdate).not.toHaveBeenCalled();
  });

  it('updates when the repo belongs to the caller\'s project', async () => {
    docGet
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({ repository_id: 'repo_mine', project_id: 'proj_1', name: 'old-name' }),
      })
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({ repository_id: 'repo_mine', project_id: 'proj_1', name: 'new-name' }),
      });

    const res = await PATCH(makePatchReq('repo_mine', { name: 'new-name' }), params);

    expect(res.status).toBe(200);
    expect(docUpdate).toHaveBeenCalledOnce();
  });
});

describe('PATCH /api/projects/[projectId]/repositories — url uniqueness (issue #1048 F2)', () => {
  it('rejects editing a url to collide with a DIFFERENT existing row (409)', async () => {
    docGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ repository_id: 'repo_b', project_id: 'proj_1', url: 'https://github.com/acme/other' }),
    });
    limitGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ data: () => ({ repository_id: 'repo_a', url: 'https://github.com/acme/api' }) }],
    });

    const res = await PATCH(makePatchReq('repo_b', { url: 'https://github.com/acme/api' }), params);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.existing_repository_id).toBe('repo_a');
    expect(docUpdate).not.toHaveBeenCalled();
  });

  it('allows editing a url to an equivalent shape of its OWN current url (excludes self)', async () => {
    docGet
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({ repository_id: 'repo_a', project_id: 'proj_1', url: 'https://github.com/acme/api' }),
      })
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({ repository_id: 'repo_a', project_id: 'proj_1', url: 'https://github.com/acme/api.git' }),
      });
    // The scan returns only the row being edited itself — must be excluded.
    limitGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ data: () => ({ repository_id: 'repo_a', url: 'https://github.com/acme/api' }) }],
    });

    const res = await PATCH(
      makePatchReq('repo_a', { url: 'https://github.com/acme/api.git' }), // same repo, .git suffix added
      params,
    );

    expect(res.status).toBe(200);
    expect(docUpdate).toHaveBeenCalledOnce();
    const patch = docUpdate.mock.calls[0]![0] as { url?: string };
    expect(patch.url).toBe('https://github.com/acme/api.git');
  });

  it('rejects editing to a malformed/non-github url with a 400 (issue #1059 item 3)', async () => {
    docGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ repository_id: 'repo_a', project_id: 'proj_1', url: 'https://github.com/acme/api' }),
    });

    const res = await PATCH(makePatchReq('repo_a', { url: 'https://gitlab.com/acme/api' }), params);

    expect(res.status).toBe(400);
    expect(docUpdate).not.toHaveBeenCalled();
    expect(limitGet).not.toHaveBeenCalled();
  });

  it('refuses the edit with 503 when the scan hits its 200-row bound (issue #1059 item 2)', async () => {
    docGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ repository_id: 'repo_a', project_id: 'proj_1', url: 'https://github.com/acme/api' }),
    });
    limitGet.mockResolvedValueOnce({
      empty: false,
      docs: Array.from({ length: 200 }, (_, i) => ({
        data: () => ({ repository_id: `repo_${i}`, url: `https://github.com/acme/repo-${i}` }),
      })),
    });

    const res = await PATCH(makePatchReq('repo_a', { url: 'https://github.com/acme/brand-new' }), params);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('repository_scan_bound_exceeded');
    expect(docUpdate).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/projects/[projectId]/repositories — cross-project IDOR guard', () => {
  it('404s when the repo belongs to a different project', async () => {
    docGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ repository_id: 'repo_other', project_id: 'proj_2' }),
    });

    const res = await DELETE(makeDeleteReq('repo_other'), params);

    expect(res.status).toBe(404);
    expect(docDelete).not.toHaveBeenCalled();
  });

  it('404s when the repo does not exist', async () => {
    docGet.mockResolvedValueOnce({ exists: false, data: () => undefined });

    const res = await DELETE(makeDeleteReq('repo_missing'), params);

    expect(res.status).toBe(404);
    expect(docDelete).not.toHaveBeenCalled();
  });

  it('deletes when the repo belongs to the caller\'s project', async () => {
    docGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ repository_id: 'repo_mine', project_id: 'proj_1' }),
    });

    const res = await DELETE(makeDeleteReq('repo_mine'), params);

    expect(res.status).toBe(200);
    expect(docDelete).toHaveBeenCalledOnce();
  });
});

describe('POST /api/projects/[projectId]/repositories — token storage (#912)', () => {
  afterEach(() => {
    delete process.env['ARBITRA_ENCRYPTION_KEY'];
  });

  /** Reverts: `sealSecret(...)` around the stored github_token. */
  it('stores the repository token encrypted and returns only a mask', async () => {
    process.env['ARBITRA_ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
    const res = await POST(makeReq({ name: 'web', github_token: 'ghp_secret_value' }), params);

    expect(res.status).toBe(201);
    const persisted = setRepo.mock.calls[0]![0] as { github_token?: string };
    expect(persisted.github_token).toMatch(/^enc:v1:/);
    expect(persisted.github_token).not.toContain('ghp_secret_value');
    const body = await res.json();
    expect(body.github_token).toBe('••••');
  });

  it('refuses to store a token when no encryption key is configured', async () => {
    const res = await POST(makeReq({ name: 'web', github_token: 'ghp_secret_value' }), params);

    expect(res.status).toBe(400);
    expect(setRepo).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/projects/[projectId]/repositories — token input', () => {
  beforeEach(() => {
    docGet.mockResolvedValue({ exists: true, data: () => ({ repository_id: 'repo_1', project_id: 'proj_1' }) });
  });

  /** Reverts: the type / mask check before sealing. */
  it('rejects a non-string token and the masked placeholder', async () => {
    for (const github_token of [123, '••••']) {
      const res = await PATCH(makePatchReq('repo_1', { github_token }), params);
      expect(res.status).toBe(400);
    }
    expect(docUpdate).not.toHaveBeenCalled();
  });
});
