/**
 * Tests for the hybrid `pull_request.opened` lookup: before falling back to
 * the branch-scan (`findCaseByBranch`) and recording an unlinked-PR nudge, the webhook
 * parses the branch name for an embedded Arbitra case_id and links that case
 * up if one exists. Prevents duplicate cases when IDE agents create a case
 * before pushing a branch (so `current_branch` isn't populated yet).
 *
 * Uses the same hand-rolled Firestore stub shape as `webhook-service.repo-match.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case, Repository, WorkspaceEvent, EventType } from '@arbitra/shared';

// ── In-memory Firestore state ────────────────────────────────────────────

let repos: Repository[] = [];
let cases: Case[] = [];
const caseUpdates: Array<{ id: string; patch: Partial<Case> }> = [];
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

interface Harness {
  service: WebhookService;
  events: Array<{ case_id: string; type: EventType; payload: Record<string, unknown> }>;
  createCase: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const events: Harness['events'] = [];
  const createCase = vi.fn(async (input: { case_id?: string; title?: string }) => ({
    case_id: input.case_id ?? 'case_auto_created',
    title: input.title ?? 't',
    description: '',
    source_type: 'git',
    source_ref: '',
    project_id: 'p',
    repository_id: 'r',
    risk_level: 'low',
    priority: 'normal',
    status: 'open',
    decision_ready: false,
    created_at: '',
    updated_at: '',
  } as Case));
  const caseRepo = {
    getById: vi.fn(async (id: string) => {
      const match = cases.find((c) => c.case_id === id);
      if (!match) throw new Error('NotFound');
      return match;
    }),
    update: vi.fn(async (id: string, patch: Partial<Case>) => {
      caseUpdates.push({ id, patch });
      cases = cases.map((c) => (c.case_id === id ? { ...c, ...patch } : c));
      return cases.find((c) => c.case_id === id)!;
    }),
  } as never;
  const caseService = { createCase } as never;
  const evidenceService = { registerEvidence: vi.fn() } as never;
  const eventService = {
    emit: vi.fn(async (case_id: string, type: EventType, payload: Record<string, unknown>) => {
      events.push({ case_id, type, payload });
      return { event_id: 'e', case_id, type, actor_id: 'system', payload, created_at: '' };
    }),
  } as never;
  const service = new WebhookService(caseRepo, caseService, evidenceService, eventService);
  return { service, events, createCase };
}

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case-abc-xyz-QW2U',
    title: 'Manual case',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_1',
    repository_id: 'repo_primary',
    risk_level: 'medium',
    priority: 'normal',
    status: 'in_build',
    decision_ready: false,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    ...overrides,
  } as Case;
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

// ── beforeEach ───────────────────────────────────────────────────────────

beforeEach(() => {
  repos = [];
  cases = [];
  caseUpdates.length = 0;
  workspaceEventWrites.length = 0;
  // The `unlinked_pr_recorded` / `skipped_auto_creation` exits now also fire
  // a fire-and-forget `arbitra/case` commit-status publish (issue #1024),
  // and `opened`/`synchronize` events trigger the real changed-files fetch
  // (issue #1028) before any of these branches run. Stub `fetch` so these
  // unrelated tests never make a real GitHub API call — the changed-files
  // fetch (`/files?...`) succeeds with an empty list so it never produces
  // an unrelated `changed_files_fetch_failed` workspace event that would
  // pollute this file's `workspaceEventWrites` assertions; every other call
  // (e.g. commit-status publish) keeps failing harmlessly as before.
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    url.includes('/files?')
      ? { ok: true, status: 200, json: async () => [] }
      : { ok: false, status: 404 },
  ));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('WebhookService — hybrid PR-opened case lookup', () => {
  it('links an existing non-terminal case on the same repo when the branch carries its case_id', async () => {
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-abc-xyz-QW2U',
      current_branch: undefined, // manual case created before branch push
      current_pr_ref: undefined,
      repository_id: 'repo_primary',
      status: 'in_build',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/42',
      pr_number: 42,
      branch: 'refactor/case-abc-xyz-QW2U-foo',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 3,
    });

    expect(result.action).toBe('case_linked_by_branch_name');
    expect(result.case_id).toBe('case-abc-xyz-QW2U');

    // Auto-create must NOT fire.
    expect(h.createCase).not.toHaveBeenCalled();

    // Case updated with branch + PR ref.
    const update = caseUpdates.find((u) => u.id === 'case-abc-xyz-QW2U');
    expect(update).toBeDefined();
    expect(update!.patch.current_branch).toBe('refactor/case-abc-xyz-QW2U-foo');
    expect(update!.patch.current_pr_ref).toBe('https://github.com/acme/primary/pull/42');

    // pr_opened event emitted, plus audit comment.
    const prOpened = h.events.find((e) => e.type === 'pr_opened');
    expect(prOpened).toBeDefined();
    expect(prOpened!.payload).toMatchObject({
      linked_via: 'branch_name_case_id',
      pr_url: 'https://github.com/acme/primary/pull/42',
    });
    const comment = h.events.find((e) => e.type === 'comment_added');
    expect(comment).toBeDefined();
    expect(String(comment!.payload['body'])).toContain('manually linked via branch-name case_id');
  });

  it('records an unlinked-PR event when the matched case is on a DIFFERENT repo', async () => {
    // Payload repo resolves to repo_primary but the case lives on repo_other.
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-abc-xyz-QW2U',
      repository_id: 'repo_other',
      status: 'in_build',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/42',
      pr_number: 42,
      branch: 'refactor/case-abc-xyz-QW2U-foo',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 3,
    });

    expect(result.action).toBe('unlinked_pr_recorded');
    expect(h.createCase).not.toHaveBeenCalled();
    expect(workspaceEventWrites).toHaveLength(1);
    expect(workspaceEventWrites[0]).toMatchObject({
      event_id: 'wse_unlinked_pr_repo_primary_42',
      type: 'unlinked_pull_request',
      actor_user_id: 'system:arbitra-webhook',
      evidence: {
        pr_url: 'https://github.com/acme/primary/pull/42',
        pr_number: 42,
        branch: 'refactor/case-abc-xyz-QW2U-foo',
        repository: 'acme/primary',
        github_repository_id: 1001,
        arbitra_repository_id: 'repo_primary',
      },
    });
    // The existing case must NOT have been touched.
    expect(caseUpdates.find((u) => u.id === 'case-abc-xyz-QW2U')).toBeUndefined();
  });

  it('records an unlinked-PR event when the matched case is in a terminal status (done)', async () => {
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-abc-xyz-QW2U',
      repository_id: 'repo_primary',
      status: 'done',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/42',
      pr_number: 42,
      branch: 'refactor/case-abc-xyz-QW2U-foo',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 3,
    });

    // findCaseByBranch doesn't match either (no case has this current_branch),
    // so we record a nudge rather than reviving or duplicating the terminal case.
    expect(result.action).toBe('unlinked_pr_recorded');
    expect(h.createCase).not.toHaveBeenCalled();
    expect(workspaceEventWrites).toHaveLength(1);
    expect(workspaceEventWrites[0]!.type).toBe('unlinked_pull_request');
  });

  it('falls through when the branch has no parseable case id (e.g. main)', async () => {
    repos = [makeRepo()];
    cases = []; // nothing to find via any path
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/42',
      pr_number: 42,
      branch: 'main', // blocked pattern but we still want to exercise the path
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 3,
    });

    // `main` hits the blocked-branch guard before the unlinked-PR nudge — important
    // outcome: the branch-name extractor returns null and we don't crash.
    expect(result.action).toBe('skipped_auto_creation');
    expect(h.createCase).not.toHaveBeenCalled();
    expect(workspaceEventWrites).toHaveLength(0);
  });

  it('records an unlinked-PR event when the parsed case id does not resolve in Firestore', async () => {
    repos = [makeRepo()];
    cases = []; // no case exists for this id
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/99',
      pr_number: 99,
      branch: 'refactor/case-ghost-case-id-ZZ99',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 2,
    });

    expect(result.action).toBe('unlinked_pr_recorded');
    expect(h.createCase).not.toHaveBeenCalled();
    expect(workspaceEventWrites).toHaveLength(1);
    expect(workspaceEventWrites[0]!.evidence).toMatchObject({
      pr_url: 'https://github.com/acme/primary/pull/99',
      pr_number: 99,
      branch: 'refactor/case-ghost-case-id-ZZ99',
      repository: 'acme/primary',
      arbitra_repository_id: 'repo_primary',
    });
  });

  it('links by case id even when current_branch on the case is empty (primary bug scenario)', async () => {
    // Reproduces the original bug: manual case has no current_branch set
    // because the agent created it before pushing. Without the hybrid lookup,
    // findCaseByBranch misses; the hybrid lookup must link instead of leaving
    // the PR to become an unlinked-PR nudge.
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-short-rim-x76o',
      current_branch: undefined,
      current_pr_ref: undefined,
      repository_id: 'repo_primary',
      status: 'open',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/7',
      pr_number: 7,
      branch: 'refactor/case-short-rim-x76o-wave4',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 5,
    });

    expect(result.action).toBe('case_linked_by_branch_name');
    expect(result.case_id).toBe('case-short-rim-x76o');
    expect(h.createCase).not.toHaveBeenCalled();
  });
});
