/**
 * Tests covering the rename-proof repository matcher, `repository.renamed`
 * handling, and the observable rejection-logging path introduced alongside.
 *
 * The Firestore stub below is a hand-rolled in-memory shim — good enough to
 * model:
 *   - `cases.where(field, '==', v).limit(n).get()` for `findCaseByBranch`
 *   - `repositories.where(...).where(...).limit(n).get()` for id/full_name
 *   - `repositories.limit(n).get()` for the legacy substring scan
 *   - `repositories.doc(id).update({ ... })` for backfill / rename persistence
 *   - `workspaceEvents.doc(id).set({ ... })` for rejection + rename audit
 *
 * We deliberately don't try to mock the full Firestore surface; using a
 * narrow stub keeps intent obvious and failures local to the behaviour under
 * test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case, Repository, WorkspaceEvent, EventType } from '@arbitra/shared';
import type { GitWebhookPayload } from './webhook-service.js';

// ── In-memory Firestore state ────────────────────────────────────────────

let repos: Repository[] = [];
let cases: Case[] = [];
const repoUpdates: Array<{ id: string; patch: Partial<Repository> }> = [];
const workspaceEventWrites: WorkspaceEvent[] = [];

/**
 * When > 0, the NEXT N `where('github_repository_id', ...)` reads return empty
 * regardless of state, then normal reads resume. Models an eventually-
 * consistent STALE read where the primary routing lookup misses an id that a
 * subsequent fresh read (the backfill preflight) sees — the only path that
 * makes the full_name / URL backfill-preflight conflict reachable.
 */
let staleGithubIdReads = 0;

function reposQuery(filters: Array<[keyof Repository, unknown]> = []) {
  return {
    where(field: keyof Repository, _op: string, value: unknown) {
      return reposQuery([...filters, [field, value]]);
    },
    limit(_n: number) {
      return this;
    },
    async get() {
      const isGithubIdQuery = filters.some(([f]) => f === 'github_repository_id');
      if (isGithubIdQuery && staleGithubIdReads > 0) {
        staleGithubIdReads -= 1;
        return { empty: true, docs: [] };
      }
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
      repoUpdates.push({ id, patch });
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
          // Upsert keyed by doc id, mirroring real Firestore `set`. This is
          // what makes deterministic-id dedup observable: repeated writes to
          // the same `event_id` (e.g. a per-(github id, day) conflict id)
          // collapse onto one entry instead of accumulating.
          const existing = workspaceEventWrites.findIndex((w) => w.event_id === id);
          if (existing >= 0) {
            workspaceEventWrites[existing] = value;
          } else {
            workspaceEventWrites.push(value);
          }
        },
      }),
    }),
    // Not used in these tests but present in the real module.
    evidencePolicies: () => ({
      where: () => ({ get: async () => ({ empty: true, docs: [] }) }),
    }),
  },
}));

vi.mock('../../lib/ids.js', () => ({
  generateId: (prefix: string) => `${prefix}_test`,
}));

import { WebhookService, parseRepoRef } from './webhook-service.js';
import { verifyGitHubSignature } from './github-adapter.js';

// ── Harness ──────────────────────────────────────────────────────────────

interface Harness {
  service: WebhookService;
  events: Array<{ case_id: string; type: EventType; payload: Record<string, unknown> }>;
  createCase: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const events: Harness['events'] = [];
  const caseRepo = { getById: vi.fn(), update: vi.fn() } as never;
  const createCase = vi.fn(async (input: { case_id?: string }) => ({
    case_id: input.case_id ?? 'case_new',
    title: 't',
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
  const caseService = {
    createCase,
  } as never;
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

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    repository_id: 'repo_legacy_1',
    project_id: 'proj_1',
    name: 'demo',
    url: 'https://github.com/acme/demo-april-18',
    provider: 'github',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function renamePayload(overrides: Partial<GitWebhookPayload> = {}): GitWebhookPayload {
  return {
    action: 'renamed',
    event: 'repository',
    repository: 'acme/arcade',
    repository_id: 4242,
    repository_old_full_name: 'acme/demo-april-18',
    ...overrides,
  };
}

// ── beforeEach ───────────────────────────────────────────────────────────

beforeEach(() => {
  repos = [];
  cases = [];
  repoUpdates.length = 0;
  workspaceEventWrites.length = 0;
  staleGithubIdReads = 0;
  // The `unlinked_pr_recorded` / `skipped_auto_creation` exits now also fire
  // a fire-and-forget `arbitra/case` commit-status publish (issue #1024).
  // Stub `fetch` so these unrelated tests never make a real GitHub API call.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('WebhookService — rename-proof repository matching', () => {
  it('matches by numeric github_repository_id when the row has one (rename-proof fast path)', async () => {
    // Row has old full_name but the immutable id lets us match after rename.
    repos = [
      makeRepo({
        repository_id: 'repo_a',
        github_repository_id: 4242,
        github_full_name: 'acme/demo-april-18',
      }),
    ];
    const h = makeHarness();

    // Use a synchronize event (cheapest code path that still runs resolve) —
    // we assert the id match via a background backfill NOT being needed.
    await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'pull_request',
      repository: 'acme/arcade', // NEW name
      repository_id: 4242, // unchanged
      branch: 'feat/x',
    });

    // No identity backfill needed — the row already has id + full_name set.
    // A `pull_request_event_seen_at` stamp from the webhook-health check is
    // allowed (and expected), it's unrelated to repo-matching behaviour.
    const identityBackfills = repoUpdates.filter(
      (u) =>
        u.id === 'repo_a'
        && ('github_repository_id' in u.patch || 'github_full_name' in u.patch),
    );
    expect(identityBackfills).toHaveLength(0);
  });

  it('opportunistically backfills github_repository_id when matched via legacy url-substring', async () => {
    // Legacy row: no id, no cached full_name. Only the stored `url` contains
    // the OLD slug — this is the state of every legacy row.
    repos = [makeRepo({ repository_id: 'repo_legacy', url: 'https://github.com/acme/demo-april-18' })];
    const h = makeHarness();

    await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/demo-april-18/pull/7',
      pr_number: 7,
      branch: 'feat/x',
      repository: 'acme/demo-april-18',
      repository_id: 4242,
      changed_file_count: 3,
    });
    // Flush fire-and-forget background backfill.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // At least one backfill write to repo_legacy carrying the new id.
    const backfill = repoUpdates.find((u) => u.id === 'repo_legacy');
    expect(backfill).toBeDefined();
    expect(backfill!.patch.github_repository_id).toBe(4242);
    // full_name is cached so the next event skips the legacy scan.
    expect(backfill!.patch.github_full_name).toBe('acme/demo-april-18');
  });

  it('does NOT clobber an existing github_repository_id (guards against bad payloads)', async () => {
    // Row already has an id; even if some payload with a different (wrong) id
    // arrives and happens to match by full_name, the backfill must skip.
    repos = [
      makeRepo({
        repository_id: 'repo_a',
        github_repository_id: 4242,
        github_full_name: 'acme/renamed',
      }),
    ];
    const h = makeHarness();

    await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'pull_request',
      repository: 'acme/renamed',
      repository_id: 9999, // WRONG — matched via full_name fallback
      branch: 'feat/x',
    });

    // Must not overwrite 4242.
    const touching = repoUpdates.filter(
      (u) => u.id === 'repo_a' && 'github_repository_id' in (u.patch ?? {}),
    );
    expect(touching).toHaveLength(0);
  });
});

describe('WebhookService — default_branch backfill (#1009)', () => {
  it('backfills default_branch from the payload onto a matched row that has none yet', async () => {
    repos = [makeRepo({ repository_id: 'repo_a', github_repository_id: 4242 })];
    const h = makeHarness();

    await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'pull_request',
      repository: 'acme/demo-april-18',
      repository_id: 4242,
      repository_default_branch: 'main',
      branch: 'feat/x',
    });

    const backfill = repoUpdates.find((u) => u.id === 'repo_a' && u.patch.default_branch !== undefined);
    expect(backfill).toBeDefined();
    expect(backfill!.patch.default_branch).toBe('main');
  });

  it('does not write when the payload carries the same default_branch already stored', async () => {
    repos = [makeRepo({ repository_id: 'repo_a', github_repository_id: 4242, default_branch: 'main' })];
    const h = makeHarness();

    await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'pull_request',
      repository: 'acme/demo-april-18',
      repository_id: 4242,
      repository_default_branch: 'main',
      branch: 'feat/x',
    });

    const backfill = repoUpdates.find((u) => u.id === 'repo_a' && u.patch.default_branch !== undefined);
    expect(backfill).toBeUndefined();
  });

  it('updates a stale stored default_branch when the payload disagrees (repo renamed its default on GitHub)', async () => {
    repos = [makeRepo({ repository_id: 'repo_a', github_repository_id: 4242, default_branch: 'master' })];
    const h = makeHarness();

    await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'pull_request',
      repository: 'acme/demo-april-18',
      repository_id: 4242,
      repository_default_branch: 'main',
      branch: 'feat/x',
    });

    const backfill = repoUpdates.find((u) => u.id === 'repo_a' && u.patch.default_branch !== undefined);
    expect(backfill).toBeDefined();
    expect(backfill!.patch.default_branch).toBe('main');
  });

  it('never writes when the payload carries no default_branch (legacy-shaped / test payloads)', async () => {
    repos = [makeRepo({ repository_id: 'repo_a', github_repository_id: 4242 })];
    const h = makeHarness();

    await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'pull_request',
      repository: 'acme/demo-april-18',
      repository_id: 4242,
      branch: 'feat/x',
    });

    const backfill = repoUpdates.find((u) => u.id === 'repo_a' && 'default_branch' in u.patch);
    expect(backfill).toBeUndefined();
  });
});

describe('WebhookService — duplicate github_repository_id guard (#628)', () => {
  it('single row owning the id routes exactly as before (regression guard — no conflict event)', async () => {
    // Exactly one row carries the id: the normal case must behave identically
    // to the legacy `.limit(1)` fast path — same routing, NO conflict event.
    repos = [
      makeRepo({
        repository_id: 'repo_only',
        github_repository_id: 4242,
        github_full_name: 'acme/arcade',
      }),
    ];
    cases = [
      {
        case_id: 'case_only',
        repository_id: 'repo_only',
        current_branch: 'feat/x',
        status: 'in_build',
        updated_at: '2026-01-01T00:00:00Z',
      } as unknown as Case,
    ];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'pull_request',
      repository: 'acme/arcade',
      repository_id: 4242,
      branch: 'feat/x',
    });

    // Routed to the single owning repo's case — unchanged behaviour.
    expect(result.action).toBe('case_updated');
    expect(h.events.some((e) => e.type === 'pr_updated')).toBe(true);
    // No conflict event and no unknown-repository rejection.
    expect(workspaceEventWrites.filter((w) => w.type === 'webhook_repository_id_conflict')).toHaveLength(0);
    expect(workspaceEventWrites.filter((w) => w.type === 'webhook_rejected')).toHaveLength(0);
  });

  it('two rows sharing the id do NOT route to an arbitrary row; a diagnosable conflict event is recorded (not mis-attributed)', async () => {
    repos = [
      makeRepo({
        repository_id: 'repo_dup_a',
        github_repository_id: 4242,
        github_full_name: 'acme/arcade',
      }),
      makeRepo({
        repository_id: 'repo_dup_b',
        github_repository_id: 4242,
        github_full_name: 'acme/arcade',
      }),
    ];
    // A case exists on one of the conflicting repos + matching branch. The
    // event must NOT be attributed to it (would be arbitrary routing).
    cases = [
      {
        case_id: 'case_dup_a',
        repository_id: 'repo_dup_a',
        current_branch: 'feat/x',
        status: 'in_build',
        updated_at: '2026-01-01T00:00:00Z',
      } as unknown as Case,
    ];
    const h = makeHarness();

    await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'pull_request',
      repository: 'acme/arcade',
      repository_id: 4242,
      branch: 'feat/x',
    });

    // No case event emitted — routing stopped, nothing mis-attributed.
    expect(h.events).toHaveLength(0);
    // Exactly one diagnosable conflict event, listing BOTH conflicting rows.
    const conflicts = workspaceEventWrites.filter((w) => w.type === 'webhook_repository_id_conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.evidence).toMatchObject({
      github_repository_id: 4242,
      conflicting_repository_ids: ['repo_dup_a', 'repo_dup_b'],
    });
    // Conflict supersedes the unknown-repository rejection (not double-logged).
    expect(workspaceEventWrites.filter((w) => w.type === 'webhook_rejected')).toHaveLength(0);
    // Deterministic, per-(id, day) dedup id so repeats collapse to one doc.
    expect(conflicts[0]!.event_id).toMatch(/^wse_repo_id_conflict_4242_/);
  });

  it('opened: two rows sharing the id do NOT create a case (no mis-attributed proj_default case); conflict event recorded once', async () => {
    // Regression (#647): the early-exit on conflict previously only
    // covered synchronize/push. On `action: 'opened'` the handler fell through
    // to auto-create, which — with `resolveArbitraRepo` returning null on
    // conflict — created a GARBAGE case (project_id `proj_default`,
    // repository_id = raw payload slug). That is exactly the mis-attribution
    // #628 prevents.
    repos = [
      makeRepo({
        repository_id: 'repo_dup_a',
        github_repository_id: 4242,
        github_full_name: 'acme/arcade',
      }),
      makeRepo({
        repository_id: 'repo_dup_b',
        github_repository_id: 4242,
        github_full_name: 'acme/arcade',
      }),
    ];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/arcade/pull/9',
      pr_number: 9,
      branch: 'feat/x',
      repository: 'acme/arcade',
      repository_id: 4242,
      changed_file_count: 3,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // NO case created — webhook auto-create must never fire on a conflict.
    expect(h.createCase).not.toHaveBeenCalled();
    // Handler returns a non-mutating, conflict-flavoured result (not case_created).
    expect(result.action).toBe('ignored');
    expect(result.reason).toContain('repository_id conflict');
    expect(result.case_id).toBeUndefined();
    // No case events emitted at all (no case_created / pr_updated).
    expect(h.events).toHaveLength(0);
    // Exactly one diagnosable conflict event, listing BOTH conflicting rows.
    const conflicts = workspaceEventWrites.filter((w) => w.type === 'webhook_repository_id_conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.evidence).toMatchObject({
      github_repository_id: 4242,
      conflicting_repository_ids: ['repo_dup_a', 'repo_dup_b'],
    });
    // Conflict supersedes the unknown-repository rejection (not double-logged).
    expect(workspaceEventWrites.filter((w) => w.type === 'webhook_rejected')).toHaveLength(0);
  });

  it('opened: single row owning the id records an unlinked PR nudge instead of creating a case', async () => {
    // Mirror of the conflict test but with exactly one owning row: the normal
    // `opened` path now records a workspace-level nudge. Guards against the
    // conflict early-return over-reaching and suppressing the legitimate
    // no-conflict path.
    repos = [
      makeRepo({
        repository_id: 'repo_only',
        project_id: 'proj_only',
        github_repository_id: 4242,
        github_full_name: 'acme/arcade',
      }),
    ];
    cases = [];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/arcade/pull/9',
      pr_number: 9,
      branch: 'feat/x',
      repository: 'acme/arcade',
      repository_id: 4242,
      changed_file_count: 3,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(h.createCase).not.toHaveBeenCalled();
    expect(result.action).toBe('unlinked_pr_recorded');
    const unlinked = workspaceEventWrites.filter((w) => w.type === 'unlinked_pull_request');
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toMatchObject({
      event_id: 'wse_unlinked_pr_repo_only_9',
      actor_user_id: 'system:arbitra-webhook',
      evidence: {
        pr_url: 'https://github.com/acme/arcade/pull/9',
        pr_number: 9,
        branch: 'feat/x',
        repository: 'acme/arcade',
        github_repository_id: 4242,
        arbitra_repository_id: 'repo_only',
      },
    });
    // No conflict event on the happy path.
    expect(workspaceEventWrites.filter((w) => w.type === 'webhook_repository_id_conflict')).toHaveLength(0);
  });

  it('backfill is SKIPPED and a conflict event recorded when another row already owns the payload id', async () => {
    // `repo_owner` already carries 4242; `repo_needs_backfill` lacks an id but
    // matches the payload by full_name. The backfill-preflight conflict is only
    // reachable when the primary id-routing read is STALE (misses the owner)
    // while the preflight's fresh read sees it — so we arm a single stale read
    // for the primary routing id query; the preflight id query (which runs
    // before the now-deferred health check) then sees the owner and the
    // backfill is refused.
    repos = [
      makeRepo({
        repository_id: 'repo_owner',
        github_repository_id: 4242,
        github_full_name: 'acme/owner',
        url: 'https://github.com/acme/owner',
      }),
      makeRepo({
        repository_id: 'repo_needs_backfill',
        github_full_name: 'acme/arcade',
        url: 'https://github.com/acme/arcade',
      }),
    ];
    staleGithubIdReads = 1; // primary routing id read miss (health check now runs after resolve)
    const h = makeHarness();

    await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'pull_request',
      repository: 'acme/arcade', // matches repo_needs_backfill by full_name
      repository_id: 4242, // already owned by repo_owner
      branch: 'feat/x',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Backfill must NOT have stamped 4242 onto repo_needs_backfill.
    const stampedId = repoUpdates.filter(
      (u) => u.id === 'repo_needs_backfill' && 'github_repository_id' in (u.patch ?? {}),
    );
    expect(stampedId).toHaveLength(0);
    // Conflict event recorded instead.
    const conflicts = workspaceEventWrites.filter((w) => w.type === 'webhook_repository_id_conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.evidence).toMatchObject({ github_repository_id: 4242 });
  });

  it('backfills as before when no other row owns the payload id', async () => {
    // Legacy row matched by url-substring, no id, and 4242 is owned by nobody.
    repos = [
      makeRepo({
        repository_id: 'repo_legacy',
        url: 'https://github.com/acme/demo-april-18',
      }),
    ];
    const h = makeHarness();

    await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/demo-april-18/pull/7',
      pr_number: 7,
      branch: 'feat/x',
      repository: 'acme/demo-april-18',
      repository_id: 4242,
      changed_file_count: 3,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const backfill = repoUpdates.find(
      (u) => u.id === 'repo_legacy' && u.patch.github_repository_id === 4242,
    );
    expect(backfill).toBeDefined();
    expect(backfill!.patch.github_full_name).toBe('acme/demo-april-18');
    // No conflict — backfill happened normally.
    expect(workspaceEventWrites.filter((w) => w.type === 'webhook_repository_id_conflict')).toHaveLength(0);
  });
});

describe('WebhookService — repository.renamed event', () => {
  it('updates stored full_name on rename and writes an arbitra_repo_renamed workspace event', async () => {
    repos = [
      makeRepo({
        repository_id: 'repo_a',
        github_repository_id: 4242,
        github_full_name: 'acme/demo-april-18',
      }),
    ];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook(renamePayload());

    expect(result.action).toBe('repository_renamed');
    expect(result.repository_id).toBe('repo_a');

    const update = repoUpdates.find((u) => u.id === 'repo_a');
    expect(update).toBeDefined();
    expect(update!.patch.github_full_name).toBe('acme/arcade');
    expect(update!.patch.github_repository_id).toBe(4242);

    const audit = workspaceEventWrites.find((w) => w.type === 'arbitra_repo_renamed');
    expect(audit).toBeDefined();
    expect(audit!.summary).toContain('acme/demo-april-18');
    expect(audit!.summary).toContain('acme/arcade');
    expect(audit!.evidence).toMatchObject({
      repository_id: 'repo_a',
      github_repository_id: 4242,
      old_full_name: 'acme/demo-april-18',
      new_full_name: 'acme/arcade',
    });
  });

  it('logs a webhook_rejected workspace event when the renamed repo is unknown', async () => {
    // No matching row — rename for a repo we don't track.
    repos = [];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook(renamePayload({ repository_id: 7777 }));

    expect(result.action).toBe('ignored');
    const reject = workspaceEventWrites.find((w) => w.type === 'webhook_rejected');
    expect(reject).toBeDefined();
    expect(reject!.summary).toContain('unknown repository');
    expect(reject!.evidence).toMatchObject({ event: 'repository', repository_id: 7777 });
  });

  it('falls back to old full_name match when legacy row has no github_repository_id', async () => {
    // Pre-migration row without id — only matchable via the OLD slug.
    repos = [makeRepo({ repository_id: 'repo_legacy', url: 'https://github.com/acme/demo-april-18' })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook(renamePayload());

    expect(result.action).toBe('repository_renamed');
    const update = repoUpdates.find(
      (u) => u.id === 'repo_legacy' && u.patch.github_full_name === 'acme/arcade',
    );
    expect(update).toBeDefined();
    expect(update!.patch.github_repository_id).toBe(4242);
  });
});

describe('WebhookService — rejection logging', () => {
  it('writes a case_events row when branch matches an existing case', async () => {
    repos = [
      makeRepo({
        repository_id: 'r',
        github_repository_id: 4242,
        github_full_name: 'acme/arcade',
      }),
    ];
    cases = [
      {
        case_id: 'case_abc',
        title: 't',
        description: '',
        source_type: 'git',
        source_ref: '',
        project_id: 'p',
        repository_id: 'r',
        risk_level: 'low',
        priority: 'normal',
        status: 'in_build',
        decision_ready: false,
        current_branch: 'feat/x',
        created_at: '',
        updated_at: '',
      } as Case,
    ];
    const h = makeHarness();

    await h.service.logWebhookRejection({
      reason: 'Invalid webhook signature',
      event: 'pull_request',
      branch: 'feat/x',
      repository: 'acme/arcade',
      repository_id: 4242,
    });

    // Emitted on the case, not workspace.
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.case_id).toBe('case_abc');
    expect(h.events[0]!.type).toBe('webhook_rejected');
    expect(h.events[0]!.payload).toMatchObject({
      reason: 'Invalid webhook signature',
      event: 'pull_request',
      branch: 'feat/x',
    });
    expect(workspaceEventWrites).toHaveLength(0);
  });

  it('writes a workspace_events row when no case matches the branch', async () => {
    cases = [];
    const h = makeHarness();

    await h.service.logWebhookRejection({
      reason: 'unknown repository',
      event: 'repository',
      repository_id: 9999,
    });

    expect(workspaceEventWrites).toHaveLength(1);
    expect(workspaceEventWrites[0]!.type).toBe('webhook_rejected');
    expect(workspaceEventWrites[0]!.summary).toContain('unknown repository');
    expect(h.events).toHaveLength(0);
  });

  it('logs webhook_rejected on PR event when repository.id does not match any stored repo', async () => {
    // No stored repo at all — a PR event arrives with a real-looking
    // repository.id. Must produce exactly one workspace_events row.
    repos = [];
    cases = [];
    const h = makeHarness();

    await h.service.handleGitWebhook({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/unseen/pull/1',
      pr_number: 1,
      branch: 'feat/y',
      repository: 'acme/unseen',
      repository_id: 11111,
      changed_file_count: 1,
    });

    const rejects = workspaceEventWrites.filter((w) => w.type === 'webhook_rejected');
    expect(rejects).toHaveLength(1);
    expect(rejects[0]!.evidence).toMatchObject({
      reason: 'unknown repository',
      repository: 'acme/unseen',
      repository_id: 11111,
    });
  });

  it('silences internal errors — a rejection-log failure must not throw to the caller', async () => {
    // Force emit() to reject. The guard must swallow it.
    const h = makeHarness();
    cases = [
      { case_id: 'case_x', current_branch: 'feat/x', status: 'open' } as unknown as Case,
    ];
    // Swap in a throwing emit.
    (h.service as unknown as { eventService: { emit: (...args: unknown[]) => Promise<unknown> } })
      .eventService = { emit: async () => { throw new Error('boom'); } };

    await expect(
      h.service.logWebhookRejection({ reason: 'x', branch: 'feat/x' }),
    ).resolves.toBeUndefined();
  });

  it('does NOT attach a rejection from repo A to a case from repo B on the same branch', async () => {
    // Repro: `acme/other-repo` push with bad signature
    // landed on an Acme Atlas case because both were on branch `main`.
    repos = [
      makeRepo({
        repository_id: 'repo_acme',
        github_repository_id: 1001,
        github_full_name: 'acme/atlas',
      }),
      // Note: repo A (`acme/other-repo`) is intentionally NOT stored — the
      // rejection arrives from an unknown repo.
    ];
    cases = [
      {
        case_id: 'case_acme_main',
        title: 't',
        description: '',
        source_type: 'git',
        source_ref: '',
        project_id: 'p',
        repository_id: 'repo_acme',
        risk_level: 'low',
        priority: 'normal',
        status: 'in_build',
        decision_ready: false,
        current_branch: 'main',
        created_at: '',
        updated_at: '',
      } as Case,
    ];
    const h = makeHarness();

    await h.service.logWebhookRejection({
      reason: 'Invalid webhook signature',
      event: 'push',
      branch: 'main',
      repository: 'acme/other-repo',
      repository_id: 2002,
    });

    // No case event written on the Acme case.
    expect(h.events).toHaveLength(0);
    // Rejection lands as workspace-level event.
    const rejects = workspaceEventWrites.filter((w) => w.type === 'webhook_rejected');
    expect(rejects).toHaveLength(1);
    expect(rejects[0]!.evidence).toMatchObject({
      reason: 'Invalid webhook signature',
      repository: 'acme/other-repo',
      repository_id: 2002,
      branch: 'main',
    });
  });

  it('attaches a rejection to a case in the SAME repo on a matching branch', async () => {
    repos = [
      makeRepo({
        repository_id: 'repo_acme',
        github_repository_id: 1001,
        github_full_name: 'acme/atlas',
      }),
    ];
    cases = [
      {
        case_id: 'case_acme_feat',
        title: 't',
        description: '',
        source_type: 'git',
        source_ref: '',
        project_id: 'p',
        repository_id: 'repo_acme',
        risk_level: 'low',
        priority: 'normal',
        status: 'in_build',
        decision_ready: false,
        current_branch: 'feat/y',
        created_at: '',
        updated_at: '',
      } as Case,
    ];
    const h = makeHarness();

    await h.service.logWebhookRejection({
      reason: 'Invalid webhook signature',
      event: 'pull_request',
      branch: 'feat/y',
      repository: 'acme/atlas',
      repository_id: 1001,
    });

    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.case_id).toBe('case_acme_feat');
    expect(h.events[0]!.type).toBe('webhook_rejected');
    expect(workspaceEventWrites.filter((w) => w.type === 'webhook_rejected')).toHaveLength(0);
  });

  it('emits a workspace-level rejection when the source repo is unknown (no misleading case attribution)', async () => {
    // Same-branch case in a stored repo — the rejection comes from a
    // different, unknown repo. Must not get attributed to that case.
    repos = [
      makeRepo({
        repository_id: 'repo_known',
        github_repository_id: 1001,
        github_full_name: 'known/repo',
      }),
    ];
    cases = [
      {
        case_id: 'case_known_main',
        repository_id: 'repo_known',
        current_branch: 'main',
        status: 'in_build',
      } as unknown as Case,
    ];
    const h = makeHarness();

    await h.service.logWebhookRejection({
      reason: 'Invalid webhook signature',
      event: 'push',
      branch: 'main',
      repository: 'unknown/repo',
      repository_id: 9999,
    });

    expect(h.events).toHaveLength(0);
    const rejects = workspaceEventWrites.filter((w) => w.type === 'webhook_rejected');
    expect(rejects).toHaveLength(1);
  });
});

describe('WebhookService#resolveRepositoryForSignal — strict matching (issue #1013)', () => {
  // Repro: a Claude Code session in a
  // non-git container folder named "arbitra" emitted repository "arbitra"
  // (the signal hook's directory-basename fallback). The legacy
  // `url.includes(name)` matcher attributed it to arbitra-app because
  // "arbitra" is a substring of its URL. Reverting `resolveRepositoryForSignal`
  // to call `resolveArbitraRepo`/its substring step (instead of its own exact
  // matchers) makes this test fail: it would return the arbitra-app row.
  it('does NOT attribute a bare name that only substring-matches a stored repository URL', async () => {
    repos = [
      makeRepo({
        repository_id: 'repo_arbitra_app',
        name: 'arbitra-app',
        url: 'https://github.com/acme/arbitra-app',
      }),
    ];
    const h = makeHarness();

    const resolved = await h.service.resolveRepositoryForSignal('arbitra');

    expect(resolved).toBeNull();
  });

  it('does NOT attribute a bare ref that exactly equals a stored repository `name` (cross-project collision guard)', async () => {
    // `Repository.name` has no global uniqueness — it's scoped by convention
    // to project_id only. Two different projects can each hold a repo named
    // "arbitra-mcp"; signals carry no project context to disambiguate by.
    // Matching on exact `name` would let a signal from client B's
    // "arbitra-mcp" attribute to client A's repo of the same name. Reverting
    // `resolveRepositoryForSignal` to add a `name`-equality step back in
    // makes this test fail (it would resolve to `repo_a`).
    repos = [makeRepo({ repository_id: 'repo_a', name: 'arbitra-app', url: 'https://github.com/acme/arbitra-app' })];
    const h = makeHarness();

    const resolved = await h.service.resolveRepositoryForSignal('arbitra-app');

    expect(resolved).toBeNull();
  });

  it('resolves an exact github_full_name', async () => {
    repos = [makeRepo({ repository_id: 'repo_a', github_full_name: 'acme/arbitra-app' })];
    const h = makeHarness();

    const resolved = await h.service.resolveRepositoryForSignal('acme/arbitra-app');

    expect(resolved?.repository_id).toBe('repo_a');
  });

  it('resolves an exact https URL', async () => {
    repos = [makeRepo({ repository_id: 'repo_a', url: 'https://github.com/acme/arbitra-app' })];
    const h = makeHarness();

    const resolved = await h.service.resolveRepositoryForSignal('https://github.com/acme/arbitra-app');

    expect(resolved?.repository_id).toBe('repo_a');
  });

  it('resolves an equivalent git@ SSH URL against a stored https URL (normalized, with .git suffix)', async () => {
    repos = [makeRepo({ repository_id: 'repo_a', url: 'https://github.com/acme/arbitra-app' })];
    const h = makeHarness();

    const resolved = await h.service.resolveRepositoryForSignal('git@github.com:acme/arbitra-app.git');

    expect(resolved?.repository_id).toBe('repo_a');
  });

  it('resolves a stored .git-suffixed URL against a bare https ref', async () => {
    repos = [makeRepo({ repository_id: 'repo_a', url: 'https://github.com/acme/arbitra-app.git' })];
    const h = makeHarness();

    const resolved = await h.service.resolveRepositoryForSignal('https://github.com/acme/arbitra-app');

    expect(resolved?.repository_id).toBe('repo_a');
  });

  it('returns null for a completely unknown ref', async () => {
    repos = [makeRepo({ repository_id: 'repo_a', url: 'https://github.com/acme/arbitra-app' })];
    const h = makeHarness();

    const resolved = await h.service.resolveRepositoryForSignal('totally-unrelated-name');

    expect(resolved).toBeNull();
  });
});

describe('WebhookService — webhook payload url matching is exact, not substring (issue #1048)', () => {
  // Step 3 used to be `url.includes(payload.repository)` and this describe
  // block's original test PINNED that loose behavior with a bare repo name
  // (`'demo-april-18'`, no owner) to prove the WEBHOOK path — a different
  // entry point from `resolveRepositoryForSignal` — kept working after the
  // #1013 signal-path fix. That premise was itself the #1048 bug: a real
  // GitHub webhook payload's `repository` field is ALWAYS a well-formed
  // `owner/repo` slug, so the loose test never represented an actual
  // webhook payload — and the substring step it exercised is NOT a rare
  // legacy path in production. It is the NORMAL first-webhook match for
  // every freshly registered repository (the registration route writes
  // neither `github_full_name` nor `github_repository_id`), and a substring
  // hit permanently backfills the WRONG row's identity onto a sibling
  // repository whose slug happens to extend the payload's.
  //
  // The legitimate scenario this block guards — a legacy row with only a
  // `url` (no cached id/full_name) still gets matched by the webhook path —
  // is preserved below, now keyed on the FULL owner/repo slug a real GitHub
  // payload actually carries.
  it('still matches a legacy row via exact url match when a GitHub payload has no id/full_name cached', async () => {
    repos = [makeRepo({ repository_id: 'repo_legacy', url: 'https://github.com/acme/demo-april-18' })];
    cases = [
      {
        case_id: 'case_legacy',
        repository_id: 'repo_legacy',
        current_branch: 'feat/x',
        status: 'in_build',
        updated_at: '2026-01-01T00:00:00Z',
      } as unknown as Case,
    ];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'push',
      repository: 'acme/demo-april-18', // full owner/repo slug — what GitHub actually sends
      branch: 'feat/x',
    });

    expect(result.action).toBe('case_updated');
  });

  it('does NOT match a bare repo name that only substring-matches the stored url (strict boundary)', async () => {
    // Same stored row as above, but the payload now carries the loose bare
    // name the old test used to pin as a match. It must no longer resolve.
    repos = [makeRepo({ repository_id: 'repo_legacy', url: 'https://github.com/acme/demo-april-18' })];
    cases = [
      {
        case_id: 'case_legacy',
        repository_id: 'repo_legacy',
        current_branch: 'feat/x',
        status: 'in_build',
        updated_at: '2026-01-01T00:00:00Z',
      } as unknown as Case,
    ];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'push',
      repository: 'demo-april-18', // partial slug — only a substring of the stored url
      branch: 'feat/x',
    });

    expect(result.action).toBe('no_matching_case');
    // No identity backfill onto the unrelated row from this non-match.
    expect(repoUpdates.filter((u) => u.id === 'repo_legacy')).toHaveLength(0);
  });

  it('does NOT match a prefix-sibling repo — "owner/repo" is not a match for a row whose url is "owner/repo-suffix"', async () => {
    // The exact production scenario from issue #1048: `acme/api` is a
    // substring of `https://github.com/acme/api-gateway`. Registering
    // `acme/api`'s first webhook must not resolve to (and poison) the
    // `api-gateway` row.
    repos = [makeRepo({ repository_id: 'repo_gateway', url: 'https://github.com/acme/api-gateway' })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'push',
      repository: 'acme/api',
      branch: 'feat/x',
    });

    expect(result.action).toBe('no_matching_case');
    expect(repoUpdates.filter((u) => u.id === 'repo_gateway')).toHaveLength(0);
  });

  it('an ambiguous url scan still ROUTES (to the oldest row, deterministically) but refuses to backfill it (issue #1048 follow-up F2)', async () => {
    // Two rows whose `url` both resolve to the same target — a duplicate
    // registration. Registration does not (yet) enforce `url` uniqueness the
    // way it enforces `github_repository_id`'s, so this is reachable through
    // ordinary use — unlike the `github_repository_id` conflict (#628),
    // which registration DOES prevent. Refusing to route here (as the
    // id-conflict guard does) would leave the duplicate permanently
    // unroutable: backfill never runs, so it can never self-heal, and every
    // future PR on EITHER row would publish a case-less `success` forever.
    // So this ROUTES — deterministically to the oldest row — while still
    // refusing the backfill that would risk stamping identity onto the
    // wrong one, and records a conflict event for an operator to deduplicate.
    repos = [
      makeRepo({ repository_id: 'repo_dup_2', url: 'https://github.com/acme/dup', project_id: 'proj_2', created_at: '2026-06-01T00:00:00Z' }),
      makeRepo({ repository_id: 'repo_dup_1', url: 'https://github.com/acme/dup', project_id: 'proj_1', created_at: '2026-01-01T00:00:00Z' }),
    ];
    cases = [
      {
        case_id: 'case_on_oldest',
        repository_id: 'repo_dup_1',
        current_branch: 'feat/x',
        status: 'in_build',
        updated_at: '2026-01-01T00:00:00Z',
      } as unknown as Case,
    ];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'push',
      repository: 'acme/dup',
      branch: 'feat/x',
    });

    // Routed to the OLDER row (repo_dup_1, created 2026-01-01), never the
    // newer duplicate (repo_dup_2, created 2026-06-01) and never whichever
    // the in-memory scan happened to return first (repo_dup_2 is listed
    // first in `repos` above to prove ordering isn't accidental). The only
    // case in this test is bound to repo_dup_1, so `case_updated` (rather
    // than `no_matching_case`) is itself the proof of which row was chosen
    // — `synchronize`'s response shape carries no `case_id` to assert on
    // directly.
    expect(result.action).toBe('case_updated');

    // Neither row gets backfilled — an ambiguous match must never risk
    // stamping github_repository_id/github_full_name onto the wrong row.
    expect(repoUpdates.filter((u) => u.id === 'repo_dup_1' || u.id === 'repo_dup_2')).toHaveLength(0);

    const conflictEvent = workspaceEventWrites.find((w) => w.type === 'webhook_repository_url_conflict');
    expect(conflictEvent).toBeDefined();
    expect(conflictEvent!.evidence).toMatchObject({
      repository_full_name: 'acme/dup',
      conflicting_repositories: expect.arrayContaining([
        expect.objectContaining({ repository_id: 'repo_dup_1', project_id: 'proj_1', url: 'https://github.com/acme/dup' }),
        expect.objectContaining({ repository_id: 'repo_dup_2', project_id: 'proj_2', url: 'https://github.com/acme/dup' }),
      ]),
    });
  });
});

describe('WebhookService — webhook-path url matching tolerates real-world url shapes (issue #1048 follow-up F1)', () => {
  // `Repository.url` is unvalidated free text (packages/frontend/.../repositories/route.ts
  // stores `body.url?.trim() ?? ''` with no format check, fed by a plain
  // `type="text"` input) — these are the shapes a person plausibly pastes
  // there. Every stored url below must still resolve the SAME webhook
  // payload (`acme/api`) to the SAME row, via `parseRepoRef`.
  const shapes: Array<[label: string, storedUrl: string]> = [
    ['already-canonical https url', 'https://github.com/acme/api'],
    ['git@ SSH shorthand with .git', 'git@github.com:acme/api.git'],
    ['.git suffix', 'https://github.com/acme/api.git'],
    ['trailing slash', 'https://github.com/acme/api/'],
    ['http:// scheme', 'http://github.com/acme/api'],
    ['ssh:// with git@ user', 'ssh://git@github.com/acme/api'],
    ['ssh:// with no user', 'ssh://github.com/acme/api'],
    ['git:// scheme', 'git://github.com/acme/api'],
    ['mixed case', 'HTTPS://GitHub.com/Acme/API'],
    ['leading/trailing whitespace', '  https://github.com/acme/api  '],
    // Shapes that only matched under the old loose substring check and
    // regressed to a false negative under naive strict equality — F1 fixes
    // these specifically.
    ['scheme-less host', 'github.com/acme/api'],
    ['www. host prefix', 'https://www.github.com/acme/api'],
    ['browser-copied path suffix', 'https://github.com/acme/api/tree/main'],
    ['bare owner/repo, no host at all', 'acme/api'],
    ['embedded token credentials', 'https://ghp_abc123@github.com/acme/api'],
    ['embedded user:pass credentials', 'https://user:pass@github.com/acme/api'],
    // A browser's address bar for a repository's own home page produces
    // exactly this shape (query string) or this one (fragment) — the old
    // `.includes()` matched both; a byte-exact comparison would not have.
    ['query string on the repo segment', 'https://github.com/acme/api?tab=readme'],
    ['fragment on the repo segment', 'https://github.com/acme/api#readme'],
  ];

  it.each(shapes)('matches webhook payload "acme/api" against stored url shape: %s', async (_label, storedUrl) => {
    repos = [makeRepo({ repository_id: 'repo_shape', url: storedUrl })];
    cases = [
      {
        case_id: 'case_shape',
        repository_id: 'repo_shape',
        current_branch: 'feat/x',
        status: 'in_build',
        updated_at: '2026-01-01T00:00:00Z',
      } as unknown as Case,
    ];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'push',
      repository: 'acme/api',
      branch: 'feat/x',
    });

    expect(result.action).toBe('case_updated');
  });

  it('deliberately does NOT match a GitHub Enterprise host against a github.com payload', async () => {
    // handleGitWebhook's step-3 target is always built as
    // `https://github.com/<payload.repository>` — a row genuinely hosted on
    // a different GitHub instance is a DIFFERENT system, not a formatting
    // variant. Conflating hosts would reopen the same cross-repository
    // collision this whole comparison exists to prevent, one layer up.
    repos = [makeRepo({ repository_id: 'repo_enterprise', url: 'https://github.enterprise.internal/acme/api' })];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'push',
      repository: 'acme/api',
      branch: 'feat/x',
    });

    expect(result.action).toBe('no_matching_case');
    expect(repoUpdates.filter((u) => u.id === 'repo_enterprise')).toHaveLength(0);
  });

  it('yields a clean no-match for the real Clerk placeholder row (provider: other, no host/owner/repo shape)', async () => {
    // Clerk-only projects register a
    // sentinel Repository row with no real GitHub identity at all. Step 3
    // has no provider filter — it scans every row — so this must fail to
    // PARSE (not just fail to match by accident) or a payload could in
    // principle collide with it. `parseRepoRef` requires three `/`-separated
    // segments (host, owner, repo); this url has a host and exactly ONE path
    // segment, so it returns null and is excluded before comparison.
    repos = [
      makeRepo({
        repository_id: 'repo_clerk_placeholder',
        provider: 'other',
        url: 'https://clerk-placeholder.invalid/no-source-repository',
        github_full_name: undefined,
      }),
    ];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'synchronize',
      event: 'push',
      repository: 'acme/api',
      branch: 'feat/x',
    });

    expect(result.action).toBe('no_matching_case');
    expect(repoUpdates.filter((u) => u.id === 'repo_clerk_placeholder')).toHaveLength(0);
  });
});

describe('parseRepoRef — direct unit coverage (issue #1048 follow-up review)', () => {
  it('strips a query string on the repo segment (browser-copied repo home-page url)', () => {
    expect(parseRepoRef('https://github.com/acme/api?tab=readme')).toEqual({
      host: 'github.com', owner: 'acme', repo: 'api',
    });
  });

  it('strips a fragment on the repo segment', () => {
    expect(parseRepoRef('https://github.com/acme/api#readme')).toEqual({
      host: 'github.com', owner: 'acme', repo: 'api',
    });
  });

  it('discards a query string that lands in an already-discarded extra path segment', () => {
    // `/tree/main?x` — the query is inside a segment past owner/repo, which
    // step 3 never reads at all, so this was already correct before the fix.
    expect(parseRepoRef('https://github.com/acme/api/tree/main?x')).toEqual({
      host: 'github.com', owner: 'acme', repo: 'api',
    });
  });

  it('yields null for the real Clerk placeholder row (host + one path segment, no owner/repo split)', () => {
    expect(parseRepoRef('https://clerk-placeholder.invalid/no-source-repository')).toBeNull();
  });

  it('fails CLOSED on a dotted bare segment ("a.b/api") instead of guessing a host', () => {
    // "a.b" contains a dot, so the no-scheme branch treats it as a HOST and
    // prepends https:// — "https://a.b/api" then has a host and only ONE
    // path segment, so the 3-group regex never matches. Must be null, not a
    // guess at owner/repo.
    expect(parseRepoRef('a.b/api')).toBeNull();
  });

  it('parses a dot-free bare owner/repo where the repo name itself contains a dot ("acme/api.js")', () => {
    expect(parseRepoRef('acme/api.js')).toEqual({
      host: 'github.com', owner: 'acme', repo: 'api.js',
    });
  });

  it('yields null for a dot-free HOST string with a path, instead of misreading it as owner/repo ("localhost/acme/api")', () => {
    // Issue #1059: the no-scheme heuristic
    // used to treat "localhost" as a bare owner ("localhost/acme/api" ->
    // {owner: "localhost", repo: "acme"}, silently dropping "/api") because
    // it has no dot. That accepted a THREE-segment string as if it were the
    // two-segment "owner/repo" shorthand. The bare-slug branch now requires
    // an EXACT two-segment match (nothing after `owner/repo`), so a third
    // segment fails the whole parse instead of being silently absorbed.
    expect(parseRepoRef('localhost/acme/api')).toBeNull();
  });

  it('still parses a genuine two-segment bare slug whose first segment happens to be dot-free ("localhost/api")', () => {
    // Residual, DELIBERATE ambiguity (not solved by #1059): a bare two-segment
    // "host-without-dot/path" is indistinguishable from a real owner/repo
    // slug and is still read as one. Only the three-segment absorption case
    // above was the reported misclassification.
    expect(parseRepoRef('localhost/api')).toEqual({
      host: 'github.com', owner: 'localhost', repo: 'api',
    });
  });

  it('does NOT match a prefix-sibling repo name (acme/api vs acme/api-gateway)', () => {
    expect(parseRepoRef('https://github.com/acme/api')).not.toEqual(
      parseRepoRef('https://github.com/acme/api-gateway'),
    );
  });
});

describe('verifyGitHubSignature — defensive behaviour', () => {
  it('returns false cleanly on a signature header that is too short (length mismatch)', () => {
    // timingSafeEqual throws on length mismatch; the helper must short-circuit
    // and return false so the route responds 401 instead of 500-ing.
    expect(verifyGitHubSignature('x', 'sha256=short', 'secret')).toBe(false);
  });

  it('returns false on an empty signature header', () => {
    expect(verifyGitHubSignature('x', '', 'secret')).toBe(false);
  });
});

describe('WebhookService — unsupported repository actions', () => {
  it('ignores a repository.transferred event without throwing', async () => {
    // `transferred` is not in the supported-action list; it should return
    // cleanly without writing any rejection (we only log rejections for
    // actionable-but-failed cases).
    repos = [];
    const h = makeHarness();

    const result = await h.service.handleGitWebhook({
      action: 'transferred',
      event: 'repository',
      repository: 'acme/transferred',
      repository_id: 5555,
    });

    expect(result.action).toBe('ignored');
    expect(result.reason).toContain('transferred');
    // No rejection logged — `ignored` is a clean no-op, not a failure.
    expect(workspaceEventWrites.filter((w) => w.type === 'webhook_rejected')).toHaveLength(0);
  });
});
