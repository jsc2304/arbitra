/**
 * End-to-end regression tests for issues #1045 and #1046 — the two halves of
 * one defect: `arbitra/case` used to be published from case STATUS alone,
 * bound to no commit and to no PR identity.
 *
 * These run the REAL seams of the reproduction:
 *
 *     handleGitWebhook → (caseRepo.update) → eventService.emit('pr_updated')
 *       → EventNotifier.onCaseEvent → publishCaseCommitStatus
 *       → POST /repos/:owner/:repo/statuses/:sha
 *
 * The `eventService` stub is the only substitution, and it forwards straight
 * into a real `EventNotifier` — so a regression anywhere along that chain
 * (webhook exit, notifier trigger, verdict, pin) fails these tests, not just
 * a unit-level one.
 *
 * Sibling coverage: `commit-status-service.test.ts` (the pin's own rules),
 * `event-notifier.test.ts` (when the pin is requested),
 * `webhook-service.no-case-status.test.ts` (the #1024 case-less successes
 * these must not break).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case, Repository } from '@arbitra/shared';

// ── In-memory Firestore ──────────────────────────────────────────────────

let repos: Repository[] = [];
let cases: Case[] = [];
const casePatches: Array<{ id: string; patch: Record<string, unknown> }> = [];

function docsQuery<T>(rows: () => T[], filters: Array<[string, unknown]> = []) {
  return {
    where(field: string, _op: string, value: unknown) {
      return docsQuery(rows, [...filters, [field, value]]);
    },
    limit(_n: number) {
      return this;
    },
    async get() {
      const matched = rows().filter((r) =>
        filters.every(([f, v]) => (r as Record<string, unknown>)[f] === v),
      );
      return { empty: matched.length === 0, docs: matched.map((r) => ({ data: () => r })) };
    },
  };
}

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    repositories: () => ({
      where: (f: string, op: string, v: unknown) => docsQuery(() => repos).where(f, op, v),
      limit: (_n: number) => docsQuery(() => repos),
      doc: (_id: string) => ({ async update() { /* no-op */ } }),
    }),
    activeCases: () => ({
      where: (f: string, op: string, v: unknown) => docsQuery(() => cases).where(f, op, v),
    }),
    cases: () => ({
      where: (f: string, op: string, v: unknown) => docsQuery(() => cases).where(f, op, v),
      doc: (id: string) => ({
        async get() {
          const found = cases.find((c) => c.case_id === id);
          return { exists: Boolean(found), data: () => found };
        },
        async update(patch: Record<string, unknown>) {
          casePatches.push({ id, patch });
          const found = cases.find((c) => c.case_id === id);
          if (found) Object.assign(found, patch);
        },
        async set() { /* no-op */ },
      }),
    }),
    evidence: () => docsQuery(() => [] as unknown[]),
    // No stored policy → CompletenessEvaluator uses its built-in default.
    evidencePolicies: () => docsQuery(() => [] as unknown[]),
    workspaceEvents: () => ({
      doc: (_id: string) => ({ async set() { /* no-op */ } }),
      where: (f: string, op: string, v: unknown) => docsQuery(() => [] as unknown[]).where(f, op, v),
    }),
    notifications: () => ({
      doc: (_id: string) => ({ async set() { /* no-op */ } }),
      where: (f: string, op: string, v: unknown) => docsQuery(() => [] as unknown[]).where(f, op, v),
    }),
    users: () => ({
      doc: (_id: string) => ({ async get() { return { exists: false, data: () => undefined }; } }),
      where: (f: string, op: string, v: unknown) => docsQuery(() => [] as unknown[]).where(f, op, v),
    }),
    projects: () => ({
      doc: (_id: string) => ({ async get() { return { exists: false, data: () => undefined }; } }),
      where: (f: string, op: string, v: unknown) => docsQuery(() => [] as unknown[]).where(f, op, v),
    }),
  },
}));

vi.mock('../../lib/ids.js', () => ({
  generateId: (prefix: string) => `${prefix}_test`,
}));

const { WebhookService } = await import('./webhook-service.js');
const { EventNotifier } = await import('../notification/event-notifier.js');

// ── Harness ──────────────────────────────────────────────────────────────

/**
 * Wires the webhook's `eventService.emit` seam into a REAL `EventNotifier`,
 * which is what makes these tests end-to-end: the webhook only ever emits an
 * event; the notifier is what turns that into a GitHub status POST.
 */
function makeService() {
  const notifier = new EventNotifier();
  const caseRepo = {
    getById: vi.fn(async (id: string) => cases.find((c) => c.case_id === id) ?? null),
    update: vi.fn(async (id: string, patch: Partial<Case>) => {
      const found = cases.find((c) => c.case_id === id);
      if (found) Object.assign(found, patch);
      return found as Case;
    }),
  } as never;
  const eventService = {
    emit: vi.fn(
      async (caseId: string, type: string, payload: Record<string, unknown>, actorId: string) => {
        await notifier.onCaseEvent(caseId, type as never, payload, actorId);
        return { event_id: 'evt_test' };
      },
    ),
  } as never;
  return new WebhookService(caseRepo, undefined, undefined, eventService);
}

function makeRepo(): Repository {
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
  };
}

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_gated',
    title: 'Gated work',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_1',
    repository_id: 'repo_primary',
    owner_user_id: 'usr_owner',
    status: 'approved',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    case_type: 'bugfix',
    current_branch: 'feat/gated-work',
    current_pr_ref: 'https://github.com/acme/primary/pull/50',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: true,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as Case;
}

const fetchMock = vi.fn();

beforeEach(() => {
  repos = [makeRepo()];
  cases = [];
  casePatches.length = 0;
  fetchMock.mockReset();
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

function statusCalls(): Array<{ sha: string; body: { state: string; description: string } }> {
  return fetchMock.mock.calls
    .filter(([url]: [string]) => url.includes('/statuses/'))
    .map(([url, init]: [string, RequestInit]) => ({
      sha: url.split('/statuses/')[1]!,
      body: JSON.parse(init.body as string),
    }));
}

function syncPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'synchronize',
    event: 'pull_request',
    pr_url: 'https://github.com/acme/primary/pull/50',
    pr_number: 50,
    branch: 'feat/gated-work',
    commit_sha: 'SHA_B_UNREVIEWED',
    repository: 'acme/primary',
    repository_id: 1001,
    ...overrides,
  } as never;
}

// ── Issue #1045 ──────────────────────────────────────────────────────────

describe('issue #1045 — a push after approval must not certify the new head SHA', () => {
  it('publishes FAILURE on the unreviewed head SHA (the reproduced scenario)', async () => {
    // The reviewer's trace: webhook returned `{"action":"case_updated"}` and
    // the notifier produced exactly one call —
    // `POST .../statuses/SHA_B_UNREVIEWED {"state":"success",...}`.
    // Same webhook, same notifier, opposite verdict.
    cases = [makeCase({ status: 'approved', approved_head_sha: 'SHA_A_REVIEWED' })];
    const service = makeService();

    const result = await service.handleGitWebhook(syncPayload());

    expect(result).toEqual({ action: 'case_updated' });
    const published = statusCalls();
    expect(published).toHaveLength(1);
    expect(published[0]!.sha).toBe('SHA_B_UNREVIEWED');
    expect(published[0]!.body.state).toBe('failure');
    expect(published[0]!.body.description).toContain('superseded');
  });

  it('still publishes SUCCESS when the push carries the very commit that was approved', async () => {
    // A re-delivered webhook (or a status refresh) for the reviewed commit
    // must stay green — the pin gates on identity, not on "a push happened".
    cases = [makeCase({ status: 'approved', approved_head_sha: 'SHA_A_REVIEWED' })];
    const service = makeService();

    await service.handleGitWebhook(syncPayload({ commit_sha: 'SHA_A_REVIEWED' }));

    const published = statusCalls();
    expect(published).toHaveLength(1);
    expect(published[0]!.sha).toBe('SHA_A_REVIEWED');
    expect(published[0]!.body.state).toBe('success');
  });

  it('also covers pending_merge — the status an approved case actually rests in', async () => {
    // `approved → pending_merge` is an auto edge that fires immediately, so
    // a real approved case is almost always sitting in `pending_merge` when
    // the fixup push lands.
    cases = [makeCase({ status: 'pending_merge', approved_head_sha: 'SHA_A_REVIEWED' })];
    const service = makeService();

    await service.handleGitWebhook(syncPayload());

    expect(statusCalls()[0]!.body.state).toBe('failure');
  });

  it('fails closed for a legacy approved case that carries no pin at all', async () => {
    cases = [makeCase({ status: 'approved', approved_head_sha: undefined })];
    const service = makeService();

    await service.handleGitWebhook(syncPayload());

    const published = statusCalls();
    expect(published[0]!.body.state).toBe('failure');
    expect(published[0]!.body.description).toContain('not pinned');
  });

  it('leaves an in-flight (non-approved) case untouched — no false blocking', async () => {
    // `in_build` was never a `success`, so the pin has nothing to say here;
    // the ordinary evidence/status verdict still decides.
    cases = [makeCase({ status: 'in_build', approved_head_sha: undefined })];
    const service = makeService();

    await service.handleGitWebhook(syncPayload());

    const published = statusCalls();
    expect(published).toHaveLength(1);
    expect(published[0]!.body.state).not.toBe('success');
    expect(published[0]!.body.description).not.toContain('superseded');
  });
});

// ── Issue #1046 ──────────────────────────────────────────────────────────

describe('issue #1046 — a rejected case\'s own PR must not go green on the next push', () => {
  it('publishes FAILURE naming the rejection when the push is on the rejected case\'s OWN PR', async () => {
    // The reviewer's trace: `{"action":"ignored","reason":"case in terminal
    // state: rejected"}` plus exactly one status POST,
    // `{"state":"success","description":"no case — not enforced"}`, on the
    // new SHA — the exact SHA the required check evaluates.
    cases = [makeCase({ status: 'rejected' })];
    const service = makeService();

    const result = await service.handleGitWebhook(syncPayload());

    expect(result).toEqual({
      action: 'ignored',
      case_id: 'case_gated',
      reason: 'case in terminal state: rejected',
    });
    const published = statusCalls();
    expect(published).toHaveLength(1);
    expect(published[0]!.sha).toBe('SHA_B_UNREVIEWED');
    expect(published[0]!.body.state).toBe('failure');
    expect(published[0]!.body.description).toBe('case rejected');
  });

  it('publishes FAILURE on the `opened` exit too (a PR reopened on a rejected case)', async () => {
    cases = [makeCase({ status: 'rejected' })];
    const service = makeService();

    const result = await service.handleGitWebhook(syncPayload({
      action: 'opened',
      commit_sha: 'SHA_REOPENED',
      changed_file_count: 3,
    }));

    expect(result.action).toBe('ignored');
    const published = statusCalls();
    expect(published[0]!.sha).toBe('SHA_REOPENED');
    expect(published[0]!.body.state).toBe('failure');
    expect(published[0]!.body.description).toBe('case rejected');
  });

  it('KEEPS the case-less success when the branch was reused for a DIFFERENT PR (issue #1024)', async () => {
    // The scenario the terminal-case exit was written for. The terminal case
    // points at PR #50; this webhook is PR #77 on the same branch, so this
    // PR genuinely has no case and must not be blocked forever.
    cases = [makeCase({ status: 'rejected', current_pr_ref: 'https://github.com/acme/primary/pull/50' })];
    const service = makeService();

    await service.handleGitWebhook(syncPayload({
      pr_url: 'https://github.com/acme/primary/pull/77',
      pr_number: 77,
      commit_sha: 'SHA_REUSED_BRANCH',
    }));

    const published = statusCalls();
    expect(published).toHaveLength(1);
    expect(published[0]!.sha).toBe('SHA_REUSED_BRANCH');
    expect(published[0]!.body.state).toBe('success');
    expect(published[0]!.body.description).toBe('no case — not enforced');
  });

  it('KEEPS the case-less success for a different PR even when the stored ref is non-canonical', async () => {
    // The tolerant parser is what preserves this: without it, a
    // non-canonical stored ref would compare as `unknown` and — under the
    // fail-closed reading — wrongly block an unrelated reused-branch PR.
    cases = [makeCase({ status: 'rejected', current_pr_ref: 'github.com/acme/primary/pull/50' })];
    const service = makeService();

    await service.handleGitWebhook(syncPayload({
      pr_url: 'https://github.com/acme/primary/pull/77',
      pr_number: 77,
      commit_sha: 'SHA_REUSED_BRANCH',
    }));

    const published = statusCalls();
    expect(published[0]!.body.state).toBe('success');
    expect(published[0]!.body.description).toBe('no case — not enforced');
  });

  it('keeps the case-less success when the terminal case names no PR at all', async () => {
    cases = [makeCase({ status: 'done', current_pr_ref: undefined })];
    const service = makeService();

    await service.handleGitWebhook(syncPayload({ commit_sha: 'SHA_NO_REF' }));

    expect(statusCalls()[0]!.body.description).toBe('no case — not enforced');
  });

  // Every ref shape below reproduced the exploit against the first cut of
  // this fix: the ownership check returned `false` on a ref it could not
  // parse, which routed a REJECTED case's own PR to the case-less
  // `success`. `current_pr_ref` is settable through `update_case`, and
  // `updateCaseWithPR` only writes it when absent, so a non-canonical ref
  // persists indefinitely once stored.
  const NON_CANONICAL_OWN_REFS = [
    'github.com/acme/primary/pull/50',
    'http://github.com/acme/primary/pull/50',
    'https://www.github.com/acme/primary/pull/50',
    'https://GitHub.com/acme/primary/pull/50',
    'https://api.github.com/repos/acme/primary/pulls/50',
    'https://github.com/acme/primary/pull/50/',
    'https://github.com/acme/primary/pull/50?foo=1',
    'https://github.com/ACME/Primary/pull/50',
  ];

  for (const ref of NON_CANONICAL_OWN_REFS) {
    it(`publishes FAILURE when the rejected case stores its own PR as ${JSON.stringify(ref)}`, async () => {
      cases = [makeCase({ status: 'rejected', current_pr_ref: ref })];
      const service = makeService();

      await service.handleGitWebhook(syncPayload());

      const published = statusCalls();
      expect(published).toHaveLength(1);
      expect(published[0]!.sha).toBe('SHA_B_UNREVIEWED');
      expect(published[0]!.body.state).toBe('failure');
      expect(published[0]!.body.description).toBe('case rejected');
    });
  }

  it('publishes FAILURE even when the stored ref is unparseable garbage (fails CLOSED)', async () => {
    // Revert line: `ownsPullRequest` returning `false` on `'unknown'`. An
    // inconclusive comparison must preserve the verdict — guessing
    // "different PR" here is what silently merges rejected work.
    cases = [makeCase({ status: 'rejected', current_pr_ref: 'not-a-parseable-ref' })];
    const service = makeService();

    await service.handleGitWebhook(syncPayload());

    const published = statusCalls();
    expect(published).toHaveLength(1);
    expect(published[0]!.body.state).toBe('failure');
    expect(published[0]!.body.description).toBe('case rejected');
  });

  it('a terminal OBSERVED case on its own PR still publishes the unconditional not-enforced success', async () => {
    // Observed Cases were never gated on a review, so preserving "the case's
    // own verdict" here means preserving `success`, not inventing a failure.
    cases = [makeCase({ status: 'done', case_type: 'observed' })];
    const service = makeService();

    await service.handleGitWebhook(syncPayload({ commit_sha: 'SHA_OBSERVED' }));

    const published = statusCalls();
    expect(published[0]!.body.state).toBe('success');
    expect(published[0]!.body.description).toBe('observed — not enforced');
  });
});

// ── resolveCaseForPrRecovery (the #1036 admin escape hatch) ──────────────

describe('issue #1046 — the admin re-publish escape hatch cannot launder a rejection', () => {
  it('resolves a rejected case that OWNS the PR instead of reporting no case', async () => {
    // `commit-status-admin-service` publishes through
    // `publishNoCaseCommitStatus` (unconditional success) whenever this
    // returns `case: null` — so returning the case IS the fix.
    cases = [makeCase({ status: 'rejected' })];
    const service = makeService();

    const resolution = await service.resolveCaseForPrRecovery({
      owner: 'acme',
      repo: 'primary',
      branch: 'feat/gated-work',
      title: '',
      body: '',
      prUrl: 'https://github.com/acme/primary/pull/50',
    });

    expect(resolution.repositoryRegistered).toBe(true);
    expect(resolution.case?.case_id).toBe('case_gated');
    expect(resolution.case?.status).toBe('rejected');
  });

  it('resolves it even when only the branch rung matches (non-canonical stored ref)', async () => {
    cases = [makeCase({ status: 'rejected', current_pr_ref: 'https://github.com/acme/primary/pull/50?foo=1' })];
    const service = makeService();

    const resolution = await service.resolveCaseForPrRecovery({
      owner: 'acme',
      repo: 'primary',
      branch: 'feat/gated-work',
      title: '',
      body: '',
      prUrl: 'https://github.com/acme/primary/pull/50',
    });

    expect(resolution.case?.case_id).toBe('case_gated');
  });

  it('still reports no case for a branch reused after a terminal case on a DIFFERENT PR', async () => {
    cases = [makeCase({ status: 'done' })]; // owns PR #50
    const service = makeService();

    const resolution = await service.resolveCaseForPrRecovery({
      owner: 'acme',
      repo: 'primary',
      branch: 'feat/gated-work',
      title: '',
      body: '',
      prUrl: 'https://github.com/acme/primary/pull/77',
    });

    expect(resolution.repositoryRegistered).toBe(true);
    expect(resolution.case).toBeNull();
  });
});

// ── current_head_sha: the input the transactional pin reads ──────────────

describe('issue #1045 — the webhook records the head SHA the approval will pin', () => {
  it('records current_head_sha on a synchronize against a linked case', async () => {
    // Revert line: the `recordObservedHeadSha` call in `updateCaseWithPR`.
    // Without it `applyTransitionInTransaction` has nothing to pin — a
    // Firestore transaction cannot call GitHub — so every approval lands
    // unpinned and fails closed.
    cases = [makeCase({ status: 'in_build', current_head_sha: undefined })];
    const service = makeService();

    await service.handleGitWebhook(syncPayload({ commit_sha: 'SHA_PUSHED' }));

    expect(cases[0]!.current_head_sha).toBe('SHA_PUSHED');
  });

  it('does not record the all-zero branch-delete SHA', async () => {
    // Same reasoning as the `pr_updated` guard: it is not a commit, and
    // pinning it would be meaningless.
    cases = [makeCase({ status: 'in_build', current_head_sha: 'SHA_REAL' })];
    const service = makeService();

    await service.handleGitWebhook(syncPayload({
      action: 'push',
      event: 'push',
      commit_sha: '0000000000000000000000000000000000000000',
    }));

    expect(cases[0]!.current_head_sha).toBe('SHA_REAL');
  });

  it('feeds the pin end to end: push, approve, then a later push fails closed', async () => {
    // The whole mechanism in one pass — the webhook observes A, the
    // transition pins A, a later push of B is refused.
    cases = [makeCase({ status: 'in_build', current_head_sha: undefined })];
    const service = makeService();

    await service.handleGitWebhook(syncPayload({ commit_sha: 'SHA_A_REVIEWED' }));
    expect(cases[0]!.current_head_sha).toBe('SHA_A_REVIEWED');

    // Stand in for the approval transition, which stages exactly this write
    // (`transition-core.test.ts` pins that staging directly).
    cases[0]!.status = 'approved';
    cases[0]!.approved_head_sha = cases[0]!.current_head_sha;
    fetchMock.mockClear();

    await service.handleGitWebhook(syncPayload({ commit_sha: 'SHA_B_UNREVIEWED' }));

    const published = statusCalls();
    expect(published[0]!.sha).toBe('SHA_B_UNREVIEWED');
    expect(published[0]!.body.state).toBe('failure');
    expect(published[0]!.body.description).toContain('superseded');
  });
});
