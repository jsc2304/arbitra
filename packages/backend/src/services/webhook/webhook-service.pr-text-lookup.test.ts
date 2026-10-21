/**
 * Tests for the PR-title/body case-id dedup hook. When the branch name
 * carries no embedded case_id (e.g. Jira-style "feat/ATLAS-123")
 * but the PR description references the Arbitra case
 * ("Arbitra: case-pure-dawn-mQj7"), the webhook links that case up before
 * falling through to an unlinked-PR nudge. Mirrors the hand-rolled Firestore stub
 * shape used in `webhook-service.hybrid-lookup.test.ts`.
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
    case_id: 'case-pure-dawn-mQj7',
    title: 'Manual case',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_1',
    repository_id: 'repo_primary',
    risk_level: 'medium',
    priority: 'normal',
    status: 'open',
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
  // The `unlinked_pr_recorded` exit now also fires a fire-and-forget
  // `arbitra/case` commit-status publish (issue #1024), and `opened`/
  // `synchronize` events trigger the real changed-files fetch (issue #1028)
  // before that. Stub `fetch` so these unrelated tests never make a real
  // GitHub API call — the changed-files fetch (`/files?...`) succeeds with
  // an empty list so it never produces an unrelated
  // `changed_files_fetch_failed` workspace event that would pollute this
  // file's `workspaceEventWrites` assertions; every other call (e.g.
  // commit-status publish) keeps failing harmlessly as before.
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

describe('WebhookService — PR-text case-id dedup', () => {
  it('regression PR #25: Jira branch + body referencing case_id links to existing open case', async () => {
    // Reproduces the exact failure case: PR has Jira branch (no case token),
    // body literally contains "Arbitra: case-pure-dawn-mQj7", existing case
    // is in `open` and has no current_branch yet.
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-pure-dawn-mQj7',
      current_branch: undefined,
      current_pr_ref: undefined,
      repository_id: 'repo_primary',
      status: 'open',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/25',
      pr_number: 25,
      branch: 'feat/atlas-123-price-list-import',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 4,
      title: 'feat: implement ATLAS-123',
      body: 'Implements ATLAS-123.\n\nArbitra: case-pure-dawn-mQj7\n',
    });

    expect(result.action).toBe('case_linked_by_pr_text');
    expect(result.case_id).toBe('case-pure-dawn-mQj7');
    expect(h.createCase).not.toHaveBeenCalled();

    const update = caseUpdates.find((u) => u.id === 'case-pure-dawn-mQj7');
    expect(update).toBeDefined();
    expect(update!.patch.current_branch).toBe('feat/atlas-123-price-list-import');
    expect(update!.patch.current_pr_ref).toBe('https://github.com/acme/primary/pull/25');

    const prOpened = h.events.find((e) => e.type === 'pr_opened');
    expect(prOpened).toBeDefined();
    expect(prOpened!.payload).toMatchObject({
      linked_via: 'pr_text_case_id',
      pr_url: 'https://github.com/acme/primary/pull/25',
    });

    const comment = h.events.find((e) => e.type === 'comment_added');
    expect(comment).toBeDefined();
    expect(String(comment!.payload['body'])).toContain('manually linked via PR-text case_id');
  });

  it('extracts case_id from PR title when body is empty', async () => {
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-smart-ford-QW2U',
      current_branch: undefined,
      repository_id: 'repo_primary',
      status: 'in_build',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/8',
      pr_number: 8,
      branch: 'feat/jira-1234',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      title: 'feat: tweak (case-smart-ford-QW2U)',
      body: undefined,
    });

    expect(result.action).toBe('case_linked_by_pr_text');
    expect(result.case_id).toBe('case-smart-ford-QW2U');
  });

  it('runs branch-name lookup before PR-text lookup (branch wins when both match)', async () => {
    // Two cases that could match — the branch carries case A, the body
    // mentions case B. The branch-name path runs first and links case A;
    // the PR-text path must not also fire.
    repos = [makeRepo()];
    cases = [
      makeCase({
        case_id: 'case-aaaa-bbbb-1111',
        current_branch: undefined,
        repository_id: 'repo_primary',
        status: 'in_build',
      }),
      makeCase({
        case_id: 'case-cccc-dddd-2222',
        current_branch: undefined,
        repository_id: 'repo_primary',
        status: 'in_build',
      }),
    ];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/9',
      pr_number: 9,
      branch: 'feat/case-aaaa-bbbb-1111',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      title: 'feat: ref',
      body: 'Arbitra: case-cccc-dddd-2222',
    });

    expect(result.action).toBe('case_linked_by_branch_name');
    expect(result.case_id).toBe('case-aaaa-bbbb-1111');
    expect(caseUpdates.find((u) => u.id === 'case-cccc-dddd-2222')).toBeUndefined();
  });

  it('title wins when title and body carry different case ids', async () => {
    // Title and body each reference a different existing case. The combined
    // text is `${title}\n${body}`, and the regex returns the first hit, so
    // the title wins. This locks the precedence so a future refactor that
    // reorders the concat or switches to a multi-match strategy gets caught.
    repos = [makeRepo()];
    cases = [
      makeCase({
        case_id: 'case-title-aaaa-T111',
        current_branch: undefined,
        repository_id: 'repo_primary',
        status: 'open',
      }),
      makeCase({
        case_id: 'case-body-bbbb-B222',
        current_branch: undefined,
        repository_id: 'repo_primary',
        status: 'open',
      }),
    ];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/77',
      pr_number: 77,
      branch: 'feat/no-case-id-here',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      title: 'Refs case-title-aaaa-T111',
      body: 'Also mentions case-body-bbbb-B222 in the body for context.',
    });

    expect(result.action).toBe('case_linked_by_pr_text');
    expect(result.case_id).toBe('case-title-aaaa-T111');
    expect(caseUpdates.find((u) => u.id === 'case-body-bbbb-B222')).toBeUndefined();
  });

  it('records an unlinked-PR event when PR-text matches a case on a DIFFERENT repo', async () => {
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-pure-dawn-mQj7',
      repository_id: 'repo_other',
      status: 'open',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/25',
      pr_number: 25,
      branch: 'feat/atlas-123',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      body: 'Arbitra: case-pure-dawn-mQj7',
    });

    expect(result.action).toBe('unlinked_pr_recorded');
    expect(h.createCase).not.toHaveBeenCalled();
    expect(workspaceEventWrites).toHaveLength(1);
    expect(workspaceEventWrites[0]).toMatchObject({
      event_id: 'wse_unlinked_pr_repo_primary_25',
      type: 'unlinked_pull_request',
      actor_user_id: 'system:arbitra-webhook',
      evidence: {
        pr_url: 'https://github.com/acme/primary/pull/25',
        pr_number: 25,
        branch: 'feat/atlas-123',
        repository: 'acme/primary',
        github_repository_id: 1001,
        arbitra_repository_id: 'repo_primary',
      },
    });
    expect(caseUpdates.find((u) => u.id === 'case-pure-dawn-mQj7')).toBeUndefined();
  });

  it('records an unlinked-PR event when matched case is in terminal status', async () => {
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-pure-dawn-mQj7',
      repository_id: 'repo_primary',
      status: 'done',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/25',
      pr_number: 25,
      branch: 'feat/atlas-123',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      body: 'Arbitra: case-pure-dawn-mQj7',
    });

    expect(result.action).toBe('unlinked_pr_recorded');
    expect(h.createCase).not.toHaveBeenCalled();
    expect(workspaceEventWrites).toHaveLength(1);
    expect(workspaceEventWrites[0]!.type).toBe('unlinked_pull_request');
  });

  it('records an unlinked-PR event when title and body are both empty / undefined', async () => {
    repos = [makeRepo()];
    cases = [];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/25',
      pr_number: 25,
      branch: 'feat/atlas-123',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
    });

    expect(result.action).toBe('unlinked_pr_recorded');
    expect(h.createCase).not.toHaveBeenCalled();
    expect(workspaceEventWrites).toHaveLength(1);
    expect(workspaceEventWrites[0]!.evidence).toMatchObject({
      pr_url: 'https://github.com/acme/primary/pull/25',
      pr_number: 25,
      branch: 'feat/atlas-123',
      arbitra_repository_id: 'repo_primary',
    });
  });

  it('refuses to re-link a case that already owns a DIFFERENT PR (#813)', async () => {
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-pure-dawn-mQj7',
      repository_id: 'repo_primary',
      status: 'in_build',
      current_branch: 'feat/owning-branch',
      current_pr_ref: 'https://github.com/acme/primary/pull/1',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/99',
      pr_number: 99,
      branch: 'feat/unrelated-branch',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      title: 'feat: unrelated change',
      body: 'Arbitra-Case: case-pure-dawn-mQj7',
    });

    // Refused: falls through to the unlinked-PR nudge instead of stealing
    // the case out from under its real PR.
    expect(result.action).toBe('unlinked_pr_recorded');
    expect(caseUpdates.find((u) => u.id === 'case-pure-dawn-mQj7')).toBeUndefined();

    const stillOwned = cases.find((c) => c.case_id === 'case-pure-dawn-mQj7')!;
    expect(stillOwned.current_pr_ref).toBe('https://github.com/acme/primary/pull/1');
    expect(stillOwned.current_branch).toBe('feat/owning-branch');
  });

  it('re-delivery of the SAME PR event on an already-linked case still links (idempotent)', async () => {
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-pure-dawn-mQj7',
      repository_id: 'repo_primary',
      status: 'in_build',
      current_branch: 'feat/atlas-123',
      current_pr_ref: 'https://github.com/acme/primary/pull/25',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/25',
      pr_number: 25,
      branch: 'feat/atlas-123',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      title: 'feat: implement ATLAS-123',
      body: 'Arbitra-Case: case-pure-dawn-mQj7',
    });

    expect(result.action).toBe('case_linked_by_pr_text');
    expect(result.case_id).toBe('case-pure-dawn-mQj7');
  });

  it('treats a stored ref with a trailing slash as the SAME PR (non-canonical variant)', async () => {
    // Fails if the guard reverts from parsePrUrl-based identity comparison to raw `!==` string equality.
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-pure-dawn-mQj7',
      repository_id: 'repo_primary',
      status: 'in_build',
      current_branch: 'feat/owning-branch',
      current_pr_ref: 'https://github.com/acme/primary/pull/1/',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/1',
      pr_number: 1,
      branch: 'feat/owning-branch',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      title: 'feat: re-delivery',
      body: 'Arbitra-Case: case-pure-dawn-mQj7',
    });

    expect(result.action).toBe('case_linked_by_pr_text');
    expect(result.case_id).toBe('case-pure-dawn-mQj7');
  });

  it('treats a stored http:// ref as the SAME PR as an incoming https:// ref', async () => {
    // Fails if the guard reverts to raw `!==` string equality (protocol mismatch would trip it).
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-pure-dawn-mQj7',
      repository_id: 'repo_primary',
      status: 'in_build',
      current_branch: 'feat/owning-branch',
      current_pr_ref: 'http://github.com/acme/primary/pull/1',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/1',
      pr_number: 1,
      branch: 'feat/owning-branch',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      title: 'feat: re-delivery',
      body: 'Arbitra-Case: case-pure-dawn-mQj7',
    });

    expect(result.action).toBe('case_linked_by_pr_text');
  });

  it('treats a stored ref with an extra query string as the SAME PR (e.g. a ref pasted via update_case)', async () => {
    // Fails if the guard reverts to raw `!==` string equality (query string would trip it).
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-pure-dawn-mQj7',
      repository_id: 'repo_primary',
      status: 'in_build',
      current_branch: 'feat/owning-branch',
      current_pr_ref: 'https://github.com/acme/primary/pull/1?diff=unified',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/1',
      pr_number: 1,
      branch: 'feat/owning-branch',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      title: 'feat: re-delivery',
      body: 'Arbitra-Case: case-pure-dawn-mQj7',
    });

    expect(result.action).toBe('case_linked_by_pr_text');
  });

  it('still refuses when stored and incoming refs share a PR number but point at a DIFFERENT repo', async () => {
    // Fails if the parsed-identity comparison drops owner/repo and matches on PR number alone.
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-pure-dawn-mQj7',
      repository_id: 'repo_primary',
      status: 'in_build',
      current_branch: 'feat/owning-branch',
      current_pr_ref: 'https://github.com/acme/primary/pull/1',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/other-repo/pull/1',
      pr_number: 1,
      branch: 'feat/unrelated-branch',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      title: 'feat: unrelated change',
      body: 'Arbitra-Case: case-pure-dawn-mQj7',
    });

    expect(result.action).toBe('unlinked_pr_recorded');
    expect(caseUpdates.find((u) => u.id === 'case-pure-dawn-mQj7')).toBeUndefined();

    const stillOwned = cases.find((c) => c.case_id === 'case-pure-dawn-mQj7')!;
    expect(stillOwned.current_pr_ref).toBe('https://github.com/acme/primary/pull/1');
  });

  it('an unparseable stored ref that differs from the incoming pr_url is still refused (fallback = today\'s string equality)', async () => {
    // Fails if the fallback for an unparseable stored ref stops using strict string equality (e.g. treats it as always-equal or always-different-but-silently-passes).
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-pure-dawn-mQj7',
      repository_id: 'repo_primary',
      status: 'in_build',
      current_branch: 'feat/owning-branch',
      current_pr_ref: 'manually-linked-ref-not-a-url',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/1',
      pr_number: 1,
      branch: 'feat/unrelated-branch',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      title: 'feat: unrelated change',
      body: 'Arbitra-Case: case-pure-dawn-mQj7',
    });

    expect(result.action).toBe('unlinked_pr_recorded');
    expect(caseUpdates.find((u) => u.id === 'case-pure-dawn-mQj7')).toBeUndefined();

    const stillOwned = cases.find((c) => c.case_id === 'case-pure-dawn-mQj7')!;
    expect(stillOwned.current_pr_ref).toBe('manually-linked-ref-not-a-url');
  });

  it('an unparseable stored ref that matches the incoming pr_url EXACTLY still links (idempotent redelivery)', async () => {
    // Fails if the unparseable fallback stops treating an exact string match as the same PR.
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-pure-dawn-mQj7',
      repository_id: 'repo_primary',
      status: 'in_build',
      current_branch: 'feat/owning-branch',
      current_pr_ref: 'manually-linked-ref-not-a-url',
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'manually-linked-ref-not-a-url',
      pr_number: 1,
      branch: 'feat/owning-branch',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      title: 'feat: re-delivery',
      body: 'Arbitra-Case: case-pure-dawn-mQj7',
    });

    expect(result.action).toBe('case_linked_by_pr_text');
  });

  it('links normally when the case has no current_pr_ref yet (not a re-link)', async () => {
    repos = [makeRepo()];
    cases = [makeCase({
      case_id: 'case-pure-dawn-mQj7',
      repository_id: 'repo_primary',
      status: 'open',
      current_branch: undefined,
      current_pr_ref: undefined,
    })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/30',
      pr_number: 30,
      branch: 'feat/fresh-branch',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      title: 'feat: fresh work',
      body: 'Arbitra-Case: case-pure-dawn-mQj7',
    });

    expect(result.action).toBe('case_linked_by_pr_text');
    const update = caseUpdates.find((u) => u.id === 'case-pure-dawn-mQj7');
    expect(update!.patch.current_pr_ref).toBe('https://github.com/acme/primary/pull/30');
  });

  it('records an unlinked-PR event when body references a non-existent case id', async () => {
    repos = [makeRepo()];
    cases = [];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/primary/pull/25',
      pr_number: 25,
      branch: 'feat/atlas-123',
      repository: 'acme/primary',
      repository_id: 1001,
      changed_file_count: 1,
      body: 'Arbitra: case-ghost-id-ZZ99',
    });

    expect(result.action).toBe('unlinked_pr_recorded');
    expect(h.createCase).not.toHaveBeenCalled();
    expect(workspaceEventWrites).toHaveLength(1);
    expect(workspaceEventWrites[0]!.evidence).toMatchObject({
      pr_url: 'https://github.com/acme/primary/pull/25',
      pr_number: 25,
      branch: 'feat/atlas-123',
      arbitra_repository_id: 'repo_primary',
    });
  });
});
