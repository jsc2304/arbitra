import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case, EventType, Repository, WorkspaceEvent } from '@arbitra/shared';
import type { GitWebhookPayload } from './webhook-service.js';

/**
 * Tests for input-layer webhook hardening:
 *   (a) branch-delete push (all-zero commit sha) is dropped — no pr_updated
 *   (b) first `push` without prior `pull_request`, after the 24h grace
 *       period, emits exactly one `webhook_misconfigured` workspace event
 *   (c) `pull_request` ingestion flips `pull_request_event_seen_at` so the
 *       warning clears
 */

// Mutable stores shared between mocks and tests.
const stores: {
  caseByBranch: Case | null;
  repository: Repository | null;
  repoUpdates: Array<Record<string, unknown>>;
} = {
  caseByBranch: null,
  repository: null,
  repoUpdates: [],
};

const workspaceEvents: Array<Omit<WorkspaceEvent, 'event_id' | 'timestamp'>> = [];

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    cases: () => ({
      where: () => ({
        limit: () => ({
          get: vi.fn(async () => {
            if (stores.caseByBranch === null) return { empty: true, docs: [] };
            return { empty: false, docs: [{ data: () => stores.caseByBranch }] };
          }),
        }),
      }),
    }),
    activeCases: () => {
      const chain: {
        where: () => typeof chain;
        limit: () => typeof chain;
        get: () => Promise<{ empty: boolean; docs: Array<{ data: () => unknown }> }>;
      } = {
        where: () => chain,
        limit: () => chain,
        get: vi.fn(async () => {
          if (stores.caseByBranch === null) return { empty: true, docs: [] };
          return { empty: false, docs: [{ data: () => stores.caseByBranch }] };
        }),
      };
      return chain;
    },
    repositories: () => ({
      where: () => ({
        limit: () => ({
          get: vi.fn(async () => {
            if (stores.repository === null) return { empty: true, docs: [] };
            return { empty: false, docs: [{ data: () => stores.repository }] };
          }),
        }),
      }),
      doc: (_id: string) => ({
        update: vi.fn(async (patch: Record<string, unknown>) => {
          stores.repoUpdates.push(patch);
          if (stores.repository) {
            stores.repository = { ...stores.repository, ...patch } as Repository;
          }
        }),
      }),
      limit: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }),
    }),
    workspaceEvents: () => ({
      doc: () => ({ set: vi.fn(async () => undefined) }),
    }),
    evidencePolicies: () => ({
      where: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }),
    }),
  },
}));

vi.mock('../../lib/ids.js', () => ({
  generateId: (prefix: string) => `${prefix}_test`,
}));

import { WebhookService } from './webhook-service.js';

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    repository_id: 'repo_test',
    project_id: 'proj_test',
    name: 'acme/repo',
    url: 'https://github.com/acme/repo',
    provider: 'github',
    github_repository_id: 12345,
    github_full_name: 'acme/repo',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeService() {
  const events: Array<{ type: EventType; payload: Record<string, unknown> }> = [];

  const workspaceEventService = {
    record: vi.fn(async (input: Omit<WorkspaceEvent, 'event_id' | 'timestamp'>) => {
      workspaceEvents.push(input);
      return {
        ...input,
        event_id: 'workspaceEvent_test',
        timestamp: new Date().toISOString(),
      } as WorkspaceEvent;
    }),
  } as never;

  const caseRepo = {
    getById: vi.fn(async () => null),
    update: vi.fn(async () => undefined),
  } as never;

  const caseService = {
    createCase: vi.fn(async () => ({
      case_id: 'case_created_test',
      title: 't',
      description: '',
      source_type: 'git',
      source_ref: '',
      project_id: 'proj_test',
      repository_id: 'repo_test',
      risk_level: 'low',
      priority: 'normal',
      status: 'open',
      decision_ready: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    } as Case)),
  } as never;

  const evidenceService = { registerEvidence: vi.fn() } as never;

  const eventService = {
    emit: vi.fn(async (_caseId: string, type: EventType, payload: Record<string, unknown>) => {
      events.push({ type, payload });
    }),
  } as never;

  const service = new WebhookService(
    caseRepo,
    caseService,
    evidenceService,
    eventService,
    undefined,
    workspaceEventService,
  );

  return { service, events };
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('WebhookService — input-layer hardening', () => {
  beforeEach(() => {
    stores.caseByBranch = null;
    stores.repository = null;
    stores.repoUpdates = [];
    workspaceEvents.length = 0;
    // The `unlinked_pr_recorded` exit now also fires a fire-and-forget
    // `arbitra/case` commit-status publish (issue #1024). Stub `fetch` so
    // these unrelated tests never make a real GitHub API call.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('(a) zero-SHA push is dropped', () => {
    it('ignores a push with the all-zero commit sha and emits no pr_updated', async () => {
      const { service, events } = makeService();
      // Repo exists so the misconfig-health check can resolve cleanly; plenty old.
      stores.repository = makeRepo({ created_at: '2025-01-01T00:00:00Z' });
      // Case exists for this branch — proves we're not just short-circuiting on "no case".
      stores.caseByBranch = {
        case_id: 'case_test',
        status: 'in_build',
        current_branch: 'feat/test',
      } as Case;

      const payload: GitWebhookPayload = {
        action: 'push',
        event: 'push',
        branch: 'feat/test',
        commit_sha: '0000000000000000000000000000000000000000',
        repository: 'acme/repo',
        repository_id: 12345,
      };

      const result = await service.handleGitWebhook(payload);
      await flushMicrotasks();

      expect(result.action).toBe('ignored');
      expect(result.reason).toMatch(/branch-delete/i);
      expect(events.some((e) => e.type === 'pr_updated')).toBe(false);
      // Regression lock: the misconfig-health check must not fire a
      // false-positive on branch-delete pushes for pre-existing repos whose
      // `pull_request_event_seen_at` is unset and whose `created_at` is
      // >24h old. See webhook-service.ts early-return on ZERO_COMMIT_SHA.
      expect(workspaceEvents.filter((e) => e.type === 'webhook_misconfigured')).toHaveLength(0);
    });

    it('still processes a normal push with a real commit sha', async () => {
      const { service, events } = makeService();
      stores.repository = makeRepo({ created_at: '2025-01-01T00:00:00Z' });
      stores.caseByBranch = {
        case_id: 'case_test',
        status: 'in_build',
        current_branch: 'feat/test',
        updated_at: '2026-01-01T00:00:00Z',
      } as Case;

      const payload: GitWebhookPayload = {
        action: 'push',
        event: 'push',
        branch: 'feat/test',
        commit_sha: 'abc1234567890abcdef1234567890abcdef12345',
        repository: 'acme/repo',
        repository_id: 12345,
      };

      const result = await service.handleGitWebhook(payload);
      expect(result.action).toBe('case_updated');
      expect(events.some((e) => e.type === 'pr_updated')).toBe(true);
    });
  });

  describe('(b) push without prior pull_request triggers webhook_misconfigured once', () => {
    it('emits webhook_misconfigured when the repo is >24h old and no PR event has been seen', async () => {
      const { service } = makeService();
      const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      stores.repository = makeRepo({ created_at: longAgo });

      const payload: GitWebhookPayload = {
        action: 'push',
        event: 'push',
        branch: 'feat/unseen',
        commit_sha: 'abc1234567890abcdef1234567890abcdef12345',
        repository: 'acme/repo',
        repository_id: 12345,
      };

      await service.handleGitWebhook(payload);
      await flushMicrotasks();

      const misconfigs = workspaceEvents.filter((e) => e.type === 'webhook_misconfigured');
      expect(misconfigs).toHaveLength(1);
      expect(misconfigs[0]!.evidence?.['repo_id']).toBe('repo_test');
      expect(misconfigs[0]!.evidence?.['hint']).toMatch(/pull_request/);

      // Repo row stamped so we don't re-emit.
      const warnedUpdate = stores.repoUpdates.find((u) => 'webhook_misconfig_warned_at' in u);
      expect(warnedUpdate).toBeDefined();
    });

    it('does not warn within the 24h grace period', async () => {
      const { service } = makeService();
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      stores.repository = makeRepo({ created_at: recent });

      const payload: GitWebhookPayload = {
        action: 'push',
        event: 'push',
        branch: 'feat/fresh',
        commit_sha: 'abc1234567890abcdef1234567890abcdef12345',
        repository: 'acme/repo',
        repository_id: 12345,
      };

      await service.handleGitWebhook(payload);
      await flushMicrotasks();

      expect(workspaceEvents.filter((e) => e.type === 'webhook_misconfigured')).toHaveLength(0);
    });

    it('does not re-emit when the repo has already been warned', async () => {
      const { service } = makeService();
      const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      stores.repository = makeRepo({
        created_at: longAgo,
        webhook_misconfig_warned_at: '2026-04-01T00:00:00Z',
      });

      const payload: GitWebhookPayload = {
        action: 'push',
        event: 'push',
        branch: 'feat/again',
        commit_sha: 'abc1234567890abcdef1234567890abcdef12345',
        repository: 'acme/repo',
        repository_id: 12345,
      };

      await service.handleGitWebhook(payload);
      await flushMicrotasks();

      expect(workspaceEvents.filter((e) => e.type === 'webhook_misconfigured')).toHaveLength(0);
    });

    it('does not warn when pull_request_event_seen_at is set', async () => {
      const { service } = makeService();
      const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      stores.repository = makeRepo({
        created_at: longAgo,
        pull_request_event_seen_at: '2026-03-01T00:00:00Z',
      });

      const payload: GitWebhookPayload = {
        action: 'push',
        event: 'push',
        branch: 'feat/healthy',
        commit_sha: 'abc1234567890abcdef1234567890abcdef12345',
        repository: 'acme/repo',
        repository_id: 12345,
      };

      await service.handleGitWebhook(payload);
      await flushMicrotasks();

      expect(workspaceEvents.filter((e) => e.type === 'webhook_misconfigured')).toHaveLength(0);
    });
  });

  describe('(c) pull_request ingestion flips the flag', () => {
    it('stamps pull_request_event_seen_at on first pull_request event', async () => {
      const { service } = makeService();
      stores.repository = makeRepo({ created_at: '2025-01-01T00:00:00Z' });

      const payload: GitWebhookPayload = {
        action: 'opened',
        event: 'pull_request',
        pr_number: 1,
        pr_url: 'https://github.com/acme/repo/pull/1',
        branch: 'feat/first-pr',
        commit_sha: 'abc1234567890abcdef1234567890abcdef12345',
        repository: 'acme/repo',
        repository_id: 12345,
        changed_file_count: 2,
      };

      await service.handleGitWebhook(payload);
      await flushMicrotasks();

      const flagUpdate = stores.repoUpdates.find((u) => 'pull_request_event_seen_at' in u);
      expect(flagUpdate).toBeDefined();
      expect(flagUpdate!['pull_request_event_seen_at']).toBeTypeOf('string');
    });

    it('clears webhook_misconfig_warned_at in the same write that sets seen_at', async () => {
      const { service } = makeService();
      stores.repository = makeRepo({
        created_at: '2025-01-01T00:00:00Z',
        webhook_misconfig_warned_at: '2026-04-01T00:00:00Z',
      });

      const payload: GitWebhookPayload = {
        action: 'opened',
        event: 'pull_request',
        pr_number: 2,
        pr_url: 'https://github.com/acme/repo/pull/2',
        branch: 'fix/subscription-fixed',
        commit_sha: 'abc1234567890abcdef1234567890abcdef12345',
        repository: 'acme/repo',
        repository_id: 12345,
        changed_file_count: 1,
      };

      await service.handleGitWebhook(payload);
      await flushMicrotasks();

      const flagUpdate = stores.repoUpdates.find((u) => 'pull_request_event_seen_at' in u);
      expect(flagUpdate).toBeDefined();
      // Same write must remove the stale warning stamp (FieldValue.delete sentinel).
      expect(flagUpdate).toHaveProperty('webhook_misconfig_warned_at');
      expect(flagUpdate!['webhook_misconfig_warned_at']).not.toBeTypeOf('string');
    });

    it('is idempotent — does not rewrite the flag if already set', async () => {
      const { service } = makeService();
      stores.repository = makeRepo({
        created_at: '2025-01-01T00:00:00Z',
        pull_request_event_seen_at: '2026-03-01T00:00:00Z',
      });

      const payload: GitWebhookPayload = {
        action: 'synchronize',
        event: 'pull_request',
        pr_number: 1,
        pr_url: 'https://github.com/acme/repo/pull/1',
        branch: 'feat/existing-pr',
        commit_sha: 'abc1234567890abcdef1234567890abcdef12345',
        repository: 'acme/repo',
        repository_id: 12345,
      };

      await service.handleGitWebhook(payload);
      await flushMicrotasks();

      expect(
        stores.repoUpdates.find((u) => 'pull_request_event_seen_at' in u),
      ).toBeUndefined();
    });
  });
});
