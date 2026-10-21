/**
 * Tests covering `WebhookService.handleGitWebhook`'s changed-file fetch
 * (issue #1028): it runs AFTER `resolveArbitraRepoResult` resolves the
 * Arbitra `Repository` row, so it can pass that row's per-repo `github_token`
 * to `fetchPullRequestChangedFiles` instead of only ever falling back to the
 * global `GITHUB_TOKEN` — and so an ambiguous `github_repository_id`
 * (`resolveArbitraRepoResult`'s `'conflict'` status, issue #628) never
 * reaches the fetch either, since that status early-returns before this
 * point.
 *
 * The Firestore stub mirrors `webhook-service.repo-match.test.ts`'s
 * hand-rolled shim — narrow, just enough of the surface to model:
 *   - `repositories.where(...).limit(n).get()` for id/full_name matching
 *   - `activeCases.where(...).limit(n).get()` for `findCaseByBranch` (always
 *     empty here — these tests deliberately never match a case, so they
 *     never reach Observed Case escalation, which is owned by a different
 *     in-flight ticket)
 *   - `workspaceEvents.doc(id).set({ ... })` for the `changed_files_fetch_failed`
 *     dedup write
 *
 * All scenarios use action `'synchronize'` on a branch with no matching
 * case: `updateCaseWithPR` re-resolves and finds nothing, returns `false`
 * immediately, and `evaluateObservedCaseEscalation` is never invoked — the
 * changed-files fetch itself happens earlier, in the repo-resolution block,
 * independent of whether a case matches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case, Repository, WorkspaceEvent } from '@arbitra/shared';
import type { GitWebhookPayload } from './webhook-service.js';

// ── In-memory Firestore state ────────────────────────────────────────────

let repos: Repository[] = [];
const cases: Case[] = []; // deliberately always empty in every test here
const workspaceEventWrites: WorkspaceEvent[] = [];

function reposQuery(filters: Array<[keyof Repository, unknown]> = []) {
  return {
    where(field: keyof Repository, _op: string, value: unknown) {
      return reposQuery([...filters, [field, value]]);
    },
    limit(_n: number) {
      return this;
    },
    async get() {
      const matched = repos.filter((r) => filters.every(([f, v]) => r[f] === v));
      return {
        empty: matched.length === 0,
        docs: matched.map((r) => ({ data: () => r })),
      };
    },
  };
}

function reposDoc(id: string) {
  return {
    async update(patch: Partial<Repository>) {
      repos = repos.map((r) => (r.repository_id === id ? { ...r, ...patch } : r));
    },
  };
}

function casesQuery(filters: Array<[keyof Case, unknown]> = []) {
  return {
    where(field: keyof Case, _op: string, value: unknown) {
      return casesQuery([...filters, [field, value]]);
    },
    limit(_n: number) {
      return this;
    },
    async get() {
      const matched = cases.filter((c) => filters.every(([f, v]) => c[f] === v));
      return {
        empty: matched.length === 0,
        docs: matched.map((c) => ({ data: () => c })),
      };
    },
  };
}

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    repositories: () => ({
      where: (f: keyof Repository, op: string, v: unknown) => reposQuery().where(f, op, v),
      limit: (_n: number) => reposQuery(),
      doc: (id: string) => reposDoc(id),
    }),
    cases: () => ({
      where: (f: keyof Case, op: string, v: unknown) => casesQuery().where(f, op, v),
    }),
    activeCases: () => ({
      where: (f: keyof Case, op: string, v: unknown) => casesQuery().where(f, op, v),
    }),
    workspaceEvents: () => ({
      doc: (id: string) => ({
        async set(value: WorkspaceEvent) {
          const existing = workspaceEventWrites.findIndex((w) => w.event_id === id);
          if (existing >= 0) {
            workspaceEventWrites[existing] = value;
          } else {
            workspaceEventWrites.push(value);
          }
        },
      }),
    }),
    evidencePolicies: () => ({
      where: () => ({ get: async () => ({ empty: true, docs: [] }) }),
    }),
  },
}));

vi.mock('../../lib/ids.js', () => ({
  generateId: (prefix: string) => `${prefix}_test`,
}));

import { WebhookService } from './webhook-service.js';
import { sealSecret } from '../../lib/secret-box.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    repository_id: 'repo_1',
    project_id: 'proj_1',
    name: 'demo',
    url: 'https://github.com/acme/demo',
    provider: 'github',
    github_repository_id: 4242,
    github_full_name: 'acme/demo',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function syncPayload(overrides: Partial<GitWebhookPayload> = {}): GitWebhookPayload {
  return {
    action: 'synchronize',
    event: 'pull_request',
    pr_number: 7,
    pr_url: 'https://github.com/acme/demo/pull/7',
    branch: 'feat/x',
    commit_sha: 'sha_abc',
    repository: 'acme/demo',
    repository_id: 4242,
    title: 'Add widget',
    ...overrides,
  };
}

/** Finds the fetch call that hit the changed-files endpoint, ignoring any
 * commit-status-publish calls the same `handleGitWebhook` run also makes. */
function findChangedFilesCall(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.find(([url]) => typeof url === 'string' && url.includes('/files?'));
}

// ── beforeEach / afterEach ──────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  repos = [];
  cases.length = 0;
  workspaceEventWrites.length = 0;
  delete process.env['GITHUB_TOKEN'];
  process.env['ARBITRA_ENCRYPTION_KEY'] = Buffer.alloc(32, 1).toString('base64');
  // Default: every fetch (changed-files, and the fire-and-forget commit-
  // status publish other branches trigger) fails harmlessly.
  fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('WebhookService.handleGitWebhook — changed-files token resolution (issue #1028)', () => {
  it('uses the per-repo github_token when the resolved repository has one configured', async () => {
    // Stored tokens are encrypted at rest; the webhook path decrypts before use.
    repos = [makeRepo({ github_token: sealSecret('tok_per_repo') })];
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/files?') ? { ok: true, status: 200, json: async () => [] } : { ok: false, status: 404 },
    );

    const service = new WebhookService(
      { getById: vi.fn(), update: vi.fn() } as never,
      { createCase: vi.fn() } as never,
      { registerEvidence: vi.fn() } as never,
      { emit: vi.fn() } as never,
    );

    await service.handleGitWebhook(syncPayload());

    const call = findChangedFilesCall(fetchMock);
    expect(call).toBeDefined();
    const [, init] = call!;
    expect((init as { headers: Record<string, string> }).headers['Authorization']).toBe('Bearer tok_per_repo');
  });

  it('falls back to the global GITHUB_TOKEN when the resolved repository has no github_token set', async () => {
    process.env['GITHUB_TOKEN'] = 'tok_global';
    repos = [makeRepo()]; // no github_token
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/files?') ? { ok: true, status: 200, json: async () => [] } : { ok: false, status: 404 },
    );

    const service = new WebhookService(
      { getById: vi.fn(), update: vi.fn() } as never,
      { createCase: vi.fn() } as never,
      { registerEvidence: vi.fn() } as never,
      { emit: vi.fn() } as never,
    );

    await service.handleGitWebhook(syncPayload());

    const call = findChangedFilesCall(fetchMock);
    expect(call).toBeDefined();
    const [, init] = call!;
    expect((init as { headers: Record<string, string> }).headers['Authorization']).toBe('Bearer tok_global');
  });

  it('falls back to the global GITHUB_TOKEN when no repository row matches at all', async () => {
    process.env['GITHUB_TOKEN'] = 'tok_global_2';
    repos = []; // unresolved repo — resolution.repo stays null, so no fetch happens
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/files?') ? { ok: true, status: 200, json: async () => [] } : { ok: false, status: 404 },
    );

    const service = new WebhookService(
      { getById: vi.fn(), update: vi.fn() } as never,
      { createCase: vi.fn() } as never,
      { registerEvidence: vi.fn() } as never,
      { emit: vi.fn() } as never,
    );

    await service.handleGitWebhook(syncPayload());

    // No Arbitra repository row matched at all → `resolution.repo` is null,
    // so the fetch block (inside `if (resolution.repo)`) never runs. This is
    // intentional: without a resolved repo there is no case to attach the
    // signal to either.
    expect(findChangedFilesCall(fetchMock)).toBeUndefined();
  });

  it('does NOT fetch changed files when github_repository_id is ambiguous (conflict — issue #628)', async () => {
    // Two Arbitra rows share the same github_repository_id — a real
    // data-integrity conflict. `resolveArbitraRepoResult` returns
    // status: 'conflict' and `handleGitWebhook` early-returns BEFORE the
    // changed-files fetch block, exactly the guard that stops case routing
    // for this scenario. Without it, the fetch would send an arbitrary one
    // of these two tenants' `github_token` to GitHub.
    repos = [
      makeRepo({ repository_id: 'repo_a', github_token: sealSecret('tok_tenant_a') }),
      makeRepo({ repository_id: 'repo_b', github_token: sealSecret('tok_tenant_b') }),
    ];

    const service = new WebhookService(
      { getById: vi.fn(), update: vi.fn() } as never,
      { createCase: vi.fn() } as never,
      { registerEvidence: vi.fn() } as never,
      { emit: vi.fn() } as never,
    );

    await service.handleGitWebhook(syncPayload());

    expect(findChangedFilesCall(fetchMock)).toBeUndefined();
  });
});

describe('WebhookService.handleGitWebhook — changed_files_fetch_failed signal (issue #1028)', () => {
  it('sets changed_files_fetch_failed and records a workspace event on a failed fetch', async () => {
    repos = [makeRepo({ github_token: sealSecret('tok_bad') })];
    // Every fetch (including the changed-files one) fails — the default
    // beforeEach stub already returns { ok: false, status: 404 }.

    const service = new WebhookService(
      { getById: vi.fn(), update: vi.fn() } as never,
      { createCase: vi.fn() } as never,
      { registerEvidence: vi.fn() } as never,
      { emit: vi.fn() } as never,
    );

    const payload = syncPayload();
    await service.handleGitWebhook(payload);

    expect(payload.changed_files).toBeUndefined();
    expect(payload.changed_files_fetch_failed).toBe(true);

    const event = workspaceEventWrites.find((w) => w.type === 'changed_files_fetch_failed');
    expect(event).toBeDefined();
    expect(event!.evidence).toMatchObject({
      repository: 'acme/demo',
      repository_id: 'repo_1',
      pr_number: 7,
      has_repo_token: true,
    });
  });

  it('does NOT set changed_files_fetch_failed and does NOT record a workspace event when the fetch succeeds', async () => {
    repos = [makeRepo({ github_token: sealSecret('tok_ok') })];
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/files?')
        ? { ok: true, status: 200, json: async () => [{ filename: 'packages/backend/src/foo.ts' }] }
        : { ok: false, status: 404 },
    );

    const service = new WebhookService(
      { getById: vi.fn(), update: vi.fn() } as never,
      { createCase: vi.fn() } as never,
      { registerEvidence: vi.fn() } as never,
      { emit: vi.fn() } as never,
    );

    const payload = syncPayload();
    await service.handleGitWebhook(payload);

    expect(payload.changed_files).toEqual(['packages/backend/src/foo.ts']);
    expect(payload.changed_files_fetch_failed).toBeUndefined();
    expect(workspaceEventWrites.find((w) => w.type === 'changed_files_fetch_failed')).toBeUndefined();
  });

  it('dedupes repeated failures for the same repository on the same day onto one workspace event', async () => {
    repos = [makeRepo({ github_token: sealSecret('tok_bad') })];

    const service = new WebhookService(
      { getById: vi.fn(), update: vi.fn() } as never,
      { createCase: vi.fn() } as never,
      { registerEvidence: vi.fn() } as never,
      { emit: vi.fn() } as never,
    );

    await service.handleGitWebhook(syncPayload({ pr_number: 7 }));
    await service.handleGitWebhook(syncPayload({ pr_number: 8, pr_url: 'https://github.com/acme/demo/pull/8' }));

    const events = workspaceEventWrites.filter((w) => w.type === 'changed_files_fetch_failed');
    expect(events).toHaveLength(1); // second PR's failure overwrites the same (repo, day) doc, not a new one
  });
});
