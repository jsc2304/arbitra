/**
 * Tests for issue #1024: a `pull_request.opened` webhook that will NOT get
 * an Arbitra case at all (branch-pattern blocked, zero changed files, or the
 * default unlinked-PR nudge) must still publish an unconditional `success`
 * `arbitra/case` commit status. Otherwise a required `arbitra/case` check
 * would block that PR forever — GitHub's required-status-check semantics
 * treat a context that never reports as "Expected — waiting for status".
 *
 * Uses the same hand-rolled Firestore stub shape as
 * `webhook-service.hybrid-lookup.test.ts` — this file only exercises the
 * three `opened`-branch exits that fall through without linking a case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case, Repository, WorkspaceEvent, EventType } from '@arbitra/shared';

// ── In-memory Firestore state ────────────────────────────────────────────

let repos: Repository[] = [];
const cases: Case[] = [];
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
      doc: (_id: string) => ({ async update() { /* no-op for these tests */ } }),
    }),
    cases: () => ({
      where: (f: keyof Case, op: string, v: unknown) => casesQuery().where(f, op, v),
      doc: (_id: string) => ({ async set() { /* no-op */ } }),
    }),
    activeCases: () => ({
      where: (f: keyof Case, op: string, v: unknown) => casesQuery().where(f, op, v),
    }),
    workspaceEvents: () => ({
      doc: (_id: string) => ({
        async set(value: WorkspaceEvent) {
          workspaceEventWrites.push(value);
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

// ── Harness ──────────────────────────────────────────────────────────────

function makeHarness() {
  const caseRepo = { getById: vi.fn(), update: vi.fn() } as never;
  const caseService = { createCase: vi.fn() } as never;
  const evidenceService = { registerEvidence: vi.fn() } as never;
  const eventService = { emit: vi.fn() } as never;
  return new WebhookService(caseRepo, caseService, evidenceService, eventService);
}

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    repository_id: 'repo_primary',
    project_id: 'proj_1',
    name: 'primary',
    url: 'https://github.com/acme/primary',
    provider: 'github',
    github_repository_id: 1001,
    github_full_name: 'acme/primary',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  repos = [];
  workspaceEventWrites.length = 0;
  cases.length = 0;
  fetchMock.mockReset();
  // `opened`/`synchronize` events now trigger the real changed-files fetch
  // (issue #1028) before any commit-status publish. Give `/files?...` calls
  // a real (empty) JSON body so that succeeds silently — the default
  // `{ ok: true, status: 201 }` below has no `.json()` method, which is fine
  // for the `/statuses/...` POST this file is actually testing (it never
  // reads the response body) but would throw if the changed-files fetch's
  // `response.json()` call hit it, turning every `opened` test here into an
  // unrelated `changed_files_fetch_failed` workspace event.
  fetchMock.mockImplementation(async (url: string) =>
    url.includes('/files?')
      ? { ok: true, status: 200, json: async () => [] }
      : { ok: true, status: 201 },
  );
  vi.stubGlobal('fetch', fetchMock);
  process.env['GITHUB_TOKEN'] = 'test-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['GITHUB_TOKEN'];
});

function statusCallBody(): { state: string; description: string; context: string } {
  const call = fetchMock.mock.calls.find(([url]: [string]) => url.includes('/statuses/'));
  expect(call).toBeDefined();
  return JSON.parse((call![1] as RequestInit).body as string);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('WebhookService — arbitra/case status for PRs with no case (issue #1024)', () => {
  it('publishes success when auto-case-creation is blocked by branch pattern', async () => {
    const service = makeHarness();
    repos = [makeRepo()];

    const result = await service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/42',
      pr_number: 42,
      branch: 'main', // BLOCKED_BRANCH_PATTERNS: /^main$/
      commit_sha: 'sha_main',
      repository: 'acme/primary',
      repository_id: 1001,
    });

    expect(result.action).toBe('skipped_auto_creation');
    expect(fetchMock).toHaveBeenCalled();
    const url = fetchMock.mock.calls.find(([u]: [string]) => u.includes('/statuses/'))![0];
    expect(url).toBe('https://api.github.com/repos/acme/primary/statuses/sha_main');
    const body = statusCallBody();
    expect(body.state).toBe('success');
    expect(body.description).toBe('no case — not enforced');
    expect(body.context).toBe('arbitra/case');
  });

  it('publishes success when auto-case-creation is blocked by zero changed files', async () => {
    const service = makeHarness();
    repos = [makeRepo()];

    const result = await service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/43',
      pr_number: 43,
      branch: 'feat/no-op',
      commit_sha: 'sha_noop',
      changed_file_count: 0,
      repository: 'acme/primary',
      repository_id: 1001,
    });

    expect(result.action).toBe('skipped_auto_creation');
    const body = statusCallBody();
    expect(body.state).toBe('success');
  });

  it('publishes success for the default unlinked-PR nudge (no case anywhere matched)', async () => {
    const service = makeHarness();
    repos = [makeRepo()];

    const result = await service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/44',
      pr_number: 44,
      branch: 'feat/some-real-work',
      commit_sha: 'sha_real',
      changed_file_count: 3,
      repository: 'acme/primary',
      repository_id: 1001,
    });

    expect(result.action).toBe('unlinked_pr_recorded');
    expect(workspaceEventWrites.length).toBe(1); // the unlinked-PR nudge itself
    const body = statusCallBody();
    expect(body.state).toBe('success');
    expect(body.description).toBe('no case — not enforced');
  });

  it('does not call GitHub when the payload has no pr_url', async () => {
    const service = makeHarness();
    repos = [makeRepo()];

    await service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      branch: 'main',
      repository: 'acme/primary',
      repository_id: 1001,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('WebhookService — arbitra/case status for terminal-case and conflict exits (issue #1024)', () => {
  it('publishes success when opened matches a case in a TERMINAL status (branch reused after a closed case)', async () => {
    const service = makeHarness();
    repos = [makeRepo()];
    cases.push({
      case_id: 'case_terminal',
      repository_id: 'repo_primary',
      current_branch: 'feat/reused-branch',
      status: 'rejected',
      updated_at: '2026-01-01T00:00:00Z',
    } as Case);

    const result = await service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/50',
      pr_number: 50,
      branch: 'feat/reused-branch',
      commit_sha: 'sha_reused',
      repository: 'acme/primary',
      repository_id: 1001,
    });

    expect(result).toEqual({
      action: 'ignored',
      case_id: 'case_terminal',
      reason: 'case in terminal state: rejected',
    });
    const body = statusCallBody();
    expect(body.state).toBe('success');
    expect(body.description).toBe('no case — not enforced');
  });

  it('publishes success (issue #1024): synchronize on a case-less PR (second push after a case-less opened)', async () => {
    // Observed trace: `SYNC RESULT {"action":"no_matching_case"}
    // FETCH CALLS 0` — a case-less PR's second push published nothing,
    // permanently blocking the normal review-fixup case once required.
    const service = makeHarness();
    repos = [makeRepo()];
    // No case anywhere matches this branch — mirrors an unlinked-PR nudge
    // that never got a case created for it.

    const result = await service.handleGitWebhook({
      action: 'synchronize',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/51',
      pr_number: 51,
      branch: 'feat/no-case-branch',
      commit_sha: 'sha_sync_2',
      repository: 'acme/primary',
      repository_id: 1001,
    });

    expect(result).toEqual({ action: 'no_matching_case' });
    expect(fetchMock).toHaveBeenCalled();
    const url = fetchMock.mock.calls.find(([u]: [string]) => u.includes('/statuses/'))![0];
    expect(url).toBe('https://api.github.com/repos/acme/primary/statuses/sha_sync_2');
    const body = statusCallBody();
    expect(body.state).toBe('success');
    expect(body.description).toBe('no case — not enforced');
  });

  it('publishes success when synchronize matches a case in a TERMINAL status', async () => {
    const service = makeHarness();
    repos = [makeRepo()];
    cases.push({
      case_id: 'case_terminal_2',
      repository_id: 'repo_primary',
      current_branch: 'feat/reused-branch-2',
      status: 'done',
      updated_at: '2026-01-01T00:00:00Z',
    } as Case);

    const result = await service.handleGitWebhook({
      action: 'synchronize',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/52',
      pr_number: 52,
      branch: 'feat/reused-branch-2',
      commit_sha: 'sha_sync_terminal',
      repository: 'acme/primary',
      repository_id: 1001,
    });

    expect(result).toEqual({
      action: 'ignored',
      case_id: 'case_terminal_2',
      reason: 'case in terminal state: done',
    });
    const body = statusCallBody();
    expect(body.state).toBe('success');
  });

  it('does NOT publish for a plain push synchronize with no pr_url (nothing to attach a status to)', async () => {
    const service = makeHarness();
    repos = [makeRepo()];

    const result = await service.handleGitWebhook({
      action: 'push',
      event: 'push',
      branch: 'feat/direct-push',
      commit_sha: 'sha_push',
      repository: 'acme/primary',
      repository_id: 1001,
    });

    expect(result).toEqual({ action: 'no_matching_case' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('publishes success for a PR opened on a repository_id conflict', async () => {
    const service = makeHarness();
    repos = [
      makeRepo({ repository_id: 'repo_dup_a' }),
      makeRepo({ repository_id: 'repo_dup_b' }),
    ];

    const result = await service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/53',
      pr_number: 53,
      branch: 'feat/conflict',
      commit_sha: 'sha_conflict',
      repository: 'acme/primary',
      repository_id: 1001,
    });

    expect(result.action).toBe('ignored');
    expect(result.reason).toContain('repository_id conflict');
    const body = statusCallBody();
    expect(body.state).toBe('success');
    expect(body.description).toBe('no case — not enforced');
  });
});
