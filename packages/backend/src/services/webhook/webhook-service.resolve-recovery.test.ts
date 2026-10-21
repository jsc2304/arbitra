/**
 * Tests for `WebhookService.resolveCaseForPrRecovery` (issue #1032) — the
 * read-only case-resolution ladder the admin commit-status recovery
 * endpoint uses. Proves two things:
 *
 *   1. Resolution runs the SAME ladder `handleGitWebhook` runs (branch-name
 *      case id → PR-text case id → `findCaseByBranch` → `current_pr_ref`),
 *      not just an exact `current_pr_ref` match — so a case whose
 *      `current_pr_ref` is empty (the `pull_request.opened` webhook was
 *      lost — issue #1032's own headline scenario) still gets found via an
 *      earlier rung.
 *   2. It is READ-ONLY: unlike `tryLinkCaseByBranchName`/`tryLinkCaseByPrText`,
 *      a match here never persists a link or emits an event — a status
 *      re-publish must never silently change which case owns a PR.
 *
 * Uses the same hand-rolled Firestore stub shape as
 * `webhook-service.hybrid-lookup.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case, Repository } from '@arbitra/shared';

let repos: Repository[] = [];
let cases: Case[] = [];
const repoDocUpdates: Array<{ id: string; patch: unknown }> = [];

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
      return { empty: matched.length === 0, docs: matched.map((r) => ({ data: () => r })) };
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
      return { empty: matched.length === 0, docs: matched.map((c) => ({ data: () => c })) };
    },
  };
}

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    repositories: () => ({
      where: (f: keyof Repository, op: string, v: unknown) => reposQuery().where(f, op, v),
      limit: (_n: number) => reposQuery(),
      doc: (id: string) => ({
        async update(patch: unknown) {
          repoDocUpdates.push({ id, patch });
        },
      }),
    }),
    activeCases: () => ({
      where: (f: keyof Case, op: string, v: unknown) => casesQuery().where(f, op, v),
    }),
  },
}));

import { WebhookService } from './webhook-service.js';

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
    status: 'needs_human_decision',
    validation_track: 'direct',
    decision_ready: false,
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    ...overrides,
  } as Case;
}

function makeHarness() {
  const update = vi.fn();
  const caseRepo = {
    getById: vi.fn(async (id: string) => {
      const match = cases.find((c) => c.case_id === id);
      if (!match) throw new Error('NotFound');
      return match;
    }),
    update,
  } as never;
  const emit = vi.fn();
  const eventService = { emit } as never;
  const service = new WebhookService(caseRepo, undefined, undefined, eventService);
  return { service, update, emit };
}

beforeEach(() => {
  repos = [makeRepo()];
  cases = [];
  repoDocUpdates.length = 0;
});

describe('WebhookService.resolveCaseForPrRecovery', () => {
  it('reports repositoryRegistered: false when owner/repo matches no Arbitra Repository row', async () => {
    const { service } = makeHarness();

    const result = await service.resolveCaseForPrRecovery({
      owner: 'someoneelse',
      repo: 'unrelated',
      branch: 'main',
      title: '',
      body: '',
      prUrl: 'https://github.com/someoneelse/unrelated/pull/1',
    });

    expect(result).toEqual({ repositoryRegistered: false, case: null });
  });

  it('resolves via the branch-name case id — same as the webhook — WITHOUT linking or emitting anything', async () => {
    cases = [makeCase()];
    const { service, update, emit } = makeHarness();

    const result = await service.resolveCaseForPrRecovery({
      owner: 'acme',
      repo: 'primary',
      branch: 'feat/case-pure-dawn-mQj7-add-widget',
      title: '',
      body: '',
      prUrl: 'https://github.com/acme/primary/pull/1',
    });

    expect(result.repositoryRegistered).toBe(true);
    expect(result.case?.case_id).toBe('case-pure-dawn-mQj7');
    expect(update).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('resolves via PR-text (title/body) when the branch carries no case id', async () => {
    cases = [makeCase()];
    const { service, update, emit } = makeHarness();

    const result = await service.resolveCaseForPrRecovery({
      owner: 'acme',
      repo: 'primary',
      branch: 'jira/PROJ-123',
      title: 'feat: add widget',
      body: 'Arbitra-Case: case-pure-dawn-mQj7',
      prUrl: 'https://github.com/acme/primary/pull/1',
    });

    expect(result.case?.case_id).toBe('case-pure-dawn-mQj7');
    expect(update).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('resolves via findCaseByBranch (current_branch) when current_pr_ref is EMPTY — the exact scenario a lost pull_request.opened delivery leaves behind', async () => {
    cases = [makeCase({ current_branch: 'feat/owning-branch', current_pr_ref: undefined })];
    const { service } = makeHarness();

    const result = await service.resolveCaseForPrRecovery({
      owner: 'acme',
      repo: 'primary',
      branch: 'feat/owning-branch',
      title: 'unrelated title',
      body: 'unrelated body, no case id mentioned',
      prUrl: 'https://github.com/acme/primary/pull/9',
    });

    expect(result.case?.case_id).toBe('case-pure-dawn-mQj7');
  });

  it('falls back to current_pr_ref (findCaseByPrUrl) only when nothing else in the ladder matched', async () => {
    cases = [makeCase({ current_branch: 'unrelated-branch', current_pr_ref: 'https://github.com/acme/primary/pull/9' })];
    const { service } = makeHarness();

    const result = await service.resolveCaseForPrRecovery({
      owner: 'acme',
      repo: 'primary',
      branch: 'some/other-branch',
      title: '',
      body: '',
      prUrl: 'https://github.com/acme/primary/pull/9',
    });

    expect(result.case?.case_id).toBe('case-pure-dawn-mQj7');
  });

  it('treats a TERMINAL case matched via any rung as no-case (falls through the whole ladder, mirroring the webhook terminal-case exits)', async () => {
    cases = [makeCase({ status: 'done', current_branch: 'feat/owning-branch' })];
    const { service } = makeHarness();

    const result = await service.resolveCaseForPrRecovery({
      owner: 'acme',
      repo: 'primary',
      branch: 'feat/owning-branch',
      title: '',
      body: '',
      prUrl: 'https://github.com/acme/primary/pull/9',
    });

    expect(result.repositoryRegistered).toBe(true);
    expect(result.case).toBeNull();
  });

  it('returns case: null (not an error) when the repo is registered but nothing on the ladder matches', async () => {
    const { service } = makeHarness();

    const result = await service.resolveCaseForPrRecovery({
      owner: 'acme',
      repo: 'primary',
      branch: 'chore/unrelated',
      title: 'chore: bump deps',
      body: '',
      prUrl: 'https://github.com/acme/primary/pull/123',
    });

    expect(result).toEqual({ repositoryRegistered: true, repositoryId: 'repo_primary', case: null });
  });

  it('a branch-name candidate belonging to a DIFFERENT repository falls through rather than claiming a foreign case', async () => {
    cases = [makeCase({ repository_id: 'repo_other' })];
    const { service } = makeHarness();

    const result = await service.resolveCaseForPrRecovery({
      owner: 'acme',
      repo: 'primary',
      branch: 'feat/case-pure-dawn-mQj7-add-widget',
      title: '',
      body: '',
      prUrl: 'https://github.com/acme/primary/pull/1',
    });

    expect(result.case).toBeNull();
  });

  it('resolution is genuinely write-free, including through the legacy url-substring repository match', async () => {
    // A repo row with NO cached `github_full_name` only matches via the
    // legacy `url.includes(...)` fallback (`resolveArbitraRepoResult` step
    // 3) — the exact path that used to backfill `github_full_name` from
    // whatever owner/repo slug the caller supplied. An admin-supplied slug
    // reaching that write would poison the row's future webhook routing.
    repos = [makeRepo({
      repository_id: 'repo_legacy',
      github_full_name: undefined,
      github_repository_id: undefined,
      url: 'https://github.com/acme/legacy-repo',
    })];
    cases = [makeCase({ repository_id: 'repo_legacy' })];
    const { service, update, emit } = makeHarness();

    const result = await service.resolveCaseForPrRecovery({
      owner: 'acme',
      repo: 'legacy-repo',
      branch: 'feat/case-pure-dawn-mQj7-add-widget',
      title: '',
      body: '',
      prUrl: 'https://github.com/acme/legacy-repo/pull/1',
    });

    expect(result.repositoryRegistered).toBe(true);
    expect(result.case?.case_id).toBe('case-pure-dawn-mQj7');
    // The would-be backfill target (`github_full_name` was undefined going
    // in) must NOT have been written.
    expect(repoDocUpdates).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
