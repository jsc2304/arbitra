/**
 * End-to-end proof for PR #999: escalation must fire on
 * the REAL production path — a raw GitHub webhook body through
 * `parseGitHubWebhook`, then `WebhookService.handleGitWebhook` /
 * `updateCaseWithPR` — not just against a hand-built `GitWebhookPayload`
 * (that was `webhook-service.escalation.test.ts`'s gap: it constructed
 * `changed_files` directly, which production never did, since
 * `parseGitHubWebhook` only mapped `changed_file_count`).
 *
 * Issue #1028 moved the real changed-file fetch out of `parseGitHubWebhook`
 * and into `handleGitWebhook` (it needs the resolved `Repository` row's
 * per-repo token, which only exists after repo resolution — see
 * `github-adapter.ts`'s and `webhook-service.ts`'s doc-comments), so
 * `payload.changed_files` is populated by `handleGitWebhook`, not by
 * `parseGitHubWebhook` — the mutation lands on the same `payload` object
 * either way, which is what this test asserts against.
 *
 * The only thing stubbed here is the outbound HTTP call to the GitHub
 * "list PR files" API (`global.fetch`) — everything else (JSON parsing,
 * `parseGitHubWebhook`, `WebhookService`, `evaluateObservedCaseEscalation`,
 * `detectCaseFields`) runs for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case, EventType, RiskLevel } from '@arbitra/shared';

const caseForPR: { value: Case | null } = { value: null };
const escalationThreshold: { value: RiskLevel } = { value: 'high' };

vi.mock('../../lib/firestore.js', () => {
  const chainableGet = vi.fn().mockImplementation(async () => {
    if (caseForPR.value === null) return { empty: true, docs: [] };
    return { empty: false, docs: [{ data: () => caseForPR.value }] };
  });
  const casesNode: { where: () => typeof casesNode; limit: () => typeof casesNode; get: typeof chainableGet } = {
    where: () => casesNode,
    limit: () => casesNode,
    get: chainableGet,
  };
  const casesMock = () => casesNode;

  const testRepo = {
    repository_id: 'repo_test',
    project_id: 'proj_test',
    name: 'acme/repo',
    url: 'https://github.com/acme/repo',
    provider: 'github',
    github_full_name: 'acme/repo',
  };
  const repositoriesMock = () => {
    const repoNode: {
      where: () => typeof repoNode;
      limit: () => typeof repoNode;
      get: () => Promise<{ empty: boolean; docs: Array<{ data: () => typeof testRepo }> }>;
      doc: () => { update: () => Promise<void> };
    } = {
      where: () => repoNode,
      limit: () => repoNode,
      get: async () => ({ empty: false, docs: [{ data: () => testRepo }] }),
      // `checkWebhookSubscriptionHealth` is fire-and-forget and stamps
      // `pull_request_event_seen_at` on the repo row — stub it out so that
      // background write doesn't log a spurious error in this test.
      doc: () => ({ update: async () => {} }),
    };
    return repoNode;
  };

  return {
    collections: {
      cases: casesMock,
      activeCases: casesMock,
      repositories: repositoriesMock,
      evidencePolicies: () => {
        const whereNode = {
          get: vi.fn().mockImplementation(async () => {
            if (!escalationThreshold.value) return { empty: true, docs: [] };
            return {
              empty: false,
              docs: [{
                data: () => ({
                  policy_id: 'pol_test',
                  project_id: 'proj_test',
                  rules: {},
                  version: 1,
                  created_at: '2026-01-01T00:00:00Z',
                  updated_at: '2026-01-01T00:00:00Z',
                  escalation: { risk_threshold: escalationThreshold.value },
                }),
              }],
            };
          }),
        };
        return { where: () => whereNode };
      },
    },
  };
});

vi.mock('../../lib/ids.js', () => ({
  generateId: (prefix: string) => `${prefix}_test`,
}));

import { WebhookService } from './webhook-service.js';
import { parseGitHubWebhook } from './github-adapter.js';

function makeObservedCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_test',
    title: 'Observed: fix/auth-bypass',
    description: 'Auto-created from agent activity',
    source_type: 'git',
    source_ref: 'fix/auth-bypass',
    project_id: 'proj_test',
    repository_id: 'repo_test',
    owner_user_id: 'system:observed-case',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    case_type: 'observed',
    status: 'in_build',
    decision_ready: false,
    current_branch: 'fix/auth-bypass',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Case;
}

function makeHarness(initial: Case) {
  const events: Array<{ type: EventType; payload: Record<string, unknown> }> = [];
  let currentCase = initial;
  caseForPR.value = currentCase;

  const caseRepo = {
    getById: vi.fn(async () => currentCase),
    update: vi.fn(async (_id: string, updates: Partial<Case>) => {
      currentCase = { ...currentCase, ...updates };
      caseForPR.value = currentCase;
      return currentCase;
    }),
  } as never;

  const caseService = { createCase: vi.fn(async () => currentCase) } as never;
  const evidenceService = { registerEvidence: vi.fn() } as never;

  const eventService = {
    emit: vi.fn(async (_caseId: string, type: EventType, payload: Record<string, unknown>) => {
      events.push({ type, payload });
      return { event_id: 'event_test', case_id: _caseId, type, actor_id: 'system', payload, created_at: '2026-01-01T00:00:00Z' };
    }),
  } as never;

  const pipelineAdapter = {
    getCase: vi.fn(async () => currentCase),
    updateCaseStatus: vi.fn(async (_id: string, status: Case['status']) => {
      currentCase = { ...currentCase, status };
      caseForPR.value = currentCase;
      return currentCase;
    }),
    updateCase: vi.fn(async (_id: string, updates: Partial<Case>) => {
      currentCase = { ...currentCase, ...updates };
      caseForPR.value = currentCase;
      return currentCase;
    }),
    loadPreconditionContext: vi.fn(async () => ({
      case_: currentCase,
      runs: [],
      findings: [],
      ruleResults: [],
      evidence: [],
      decisions: [],
      events: events.map((e) => ({ type: e.type })),
      actorId: 'system',
    })),
    createRun: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
    emitEvent: vi.fn(async (_caseId: string, type: EventType, payload: Record<string, unknown>) => {
      events.push({ type, payload });
    }),
    getActiveRuns: vi.fn(async () => []),
    createAutoApproveDecision: vi.fn(),
    closeOutstandingWaiverProposals: vi.fn(async () => ({ closed: 0 })),
    getProjectLifecycleProfile: vi.fn(async () => undefined),
  } as never;

  const service = new WebhookService(caseRepo, caseService, evidenceService, eventService, pipelineAdapter);

  return {
    service,
    events,
    get currentCase() {
      return currentCase;
    },
  };
}

/** Raw GitHub `pull_request.opened` webhook body — the real wire shape. */
function rawPullRequestOpenedBody(overrides: { changedFilesCount?: number } = {}): Record<string, unknown> {
  return {
    action: 'opened',
    pull_request: {
      number: 42,
      html_url: 'https://github.com/acme/repo/pull/42',
      title: 'Fix login bug',
      body: 'Fixes the login bug',
      head: { ref: 'fix/auth-bypass', sha: 'abc123' },
      changed_files: overrides.changedFilesCount ?? 1,
    },
    repository: { id: 999, full_name: 'acme/repo' },
  };
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('Escalation on the REAL webhook path: raw body -> parseGitHubWebhook -> handleGitWebhook (#999)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    caseForPR.value = null;
    escalationThreshold.value = 'high';
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('escalates a PR touching an auth-path file, titled "Fix login bug", via the real parse -> webhook chain', async () => {
    // The GitHub "list PR files" API response — the ONLY thing stubbed here.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ filename: 'packages/backend/src/lib/auth.ts' }],
    });

    const h = makeHarness(makeObservedCase());

    const rawBody = rawPullRequestOpenedBody();
    const payload = await parseGitHubWebhook('pull_request', rawBody);
    expect(payload).not.toBeNull();
    // `parseGitHubWebhook` itself never touches the network (issue #1028) —
    // the fetch happens inside `handleGitWebhook`, after it resolves the
    // Arbitra repository row.
    expect(payload!.changed_files).toBeUndefined();

    const result = await h.service.handleGitWebhook(payload!);
    await flushMicrotasks();

    // Proves the fetch actually happened (inside `handleGitWebhook`) and
    // populated real paths onto the SAME payload object before escalation
    // ran — this is exactly what was missing pre-fix (payload.changed_files
    // was always undefined all the way through).
    expect(payload!.changed_files).toEqual(['packages/backend/src/lib/auth.ts']);
    expect(result.action).toBe('case_updated');
    expect(h.currentCase.case_type).toBe('bugfix');
    expect(h.currentCase.risk_level).toBe('high');
    expect(h.events.find((e) => e.type === 'case_escalated')).toBeDefined();
  });
});
