/**
 * End-to-end coverage for Observed Case escalation on PR enrichment (issue
 * #987 / ADR-0001): `WebhookService.updateCaseWithPR` — reached via
 * `pull_request.opened` matching an existing case, or `synchronize`/`push`
 * — runs `evaluateObservedCaseEscalation` for any `case_type: 'observed'`
 * case before applying the PR-link update.
 *
 * Harness is a trimmed copy of `webhook-service.observed-case.test.ts`'s.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case, EventType, RiskLevel } from '@arbitra/shared';
import type { GitWebhookPayload } from './webhook-service.js';

const caseForPR: { value: Case | null } = { value: null };
const escalationThreshold: { value: RiskLevel } = { value: 'high' };

vi.mock('../../lib/firestore.js', () => {
  // Supports an arbitrary chain of `.where(...)` calls before `.limit().get()`
  // — `findCaseByBranch` chains two (`current_branch`, `repository_id`).
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
    const repoNode: { where: () => typeof repoNode; limit: () => typeof repoNode; get: () => Promise<{ empty: boolean; docs: Array<{ data: () => typeof testRepo }> }> } = {
      where: () => repoNode,
      limit: () => repoNode,
      get: async () => ({ empty: false, docs: [{ data: () => testRepo }] }),
    };
    return repoNode;
  };

  return {
    collections: {
      cases: casesMock,
      activeCases: casesMock,
      repositories: repositoriesMock,
      // Drives `CompletenessEvaluator.getEscalationThreshold` inside the
      // real (unmocked) escalation service — a single project policy doc
      // carrying `escalation.risk_threshold`, or none (built-in default).
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

function prOpenedPayload(overrides: Partial<GitWebhookPayload> = {}): GitWebhookPayload {
  return {
    action: 'opened',
    pr_number: 42,
    pr_url: 'https://github.com/acme/repo/pull/42',
    branch: 'fix/auth-bypass',
    commit_sha: 'abc123',
    repository: 'acme/repo',
    title: 'Fix auth bypass',
    body: 'Closes the bypass',
    changed_files: ['packages/backend/src/lib/auth.ts'],
    ...overrides,
  };
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('WebhookService — Observed Case escalation on PR enrichment (#987)', () => {
  beforeEach(() => {
    caseForPR.value = null;
    escalationThreshold.value = 'high';
  });

  it('escalates a high-risk Observed Case on pull_request.opened and carries the detected case_type/risk into the case', async () => {
    // Revert the escalation call in `updateCaseWithPR` and this stays
    // `case_type: 'observed'`/`risk_level: 'low'` — the assertions below fail.
    const h = makeHarness(makeObservedCase());

    const result = await h.service.handleGitWebhook(prOpenedPayload());
    await flushMicrotasks();

    expect(result.action).toBe('case_updated');
    expect(h.currentCase.case_type).toBe('bugfix');
    expect(h.currentCase.risk_level).toBe('high');

    const escalatedEvent = h.events.find((e) => e.type === 'case_escalated');
    expect(escalatedEvent).toBeDefined();
    expect(escalatedEvent?.payload).toMatchObject({
      from_case_type: 'observed',
      to_case_type: 'bugfix',
      risk_level: 'high',
      threshold: 'high',
    });
  });

  it('a low-risk Observed Case is enriched with the PR link but never escalates', async () => {
    const h = makeHarness(makeObservedCase({
      title: 'Observed: chore/readme',
      current_branch: 'chore/readme',
    }));

    const result = await h.service.handleGitWebhook(prOpenedPayload({
      branch: 'chore/readme',
      changed_files: ['README.md'],
    }));
    await flushMicrotasks();

    expect(result.action).toBe('case_updated');
    expect(h.currentCase.case_type).toBe('observed');
    expect(h.currentCase.current_pr_ref).toBe('https://github.com/acme/repo/pull/42');
    expect(h.events.find((e) => e.type === 'case_escalated')).toBeUndefined();
  });

  it('re-evaluating an already-escalated case on a later sync is a no-op for escalation', async () => {
    const h = makeHarness(makeObservedCase({ case_type: 'bugfix', risk_level: 'high' }));

    const result = await h.service.handleGitWebhook(prOpenedPayload({ action: 'synchronize' }));
    await flushMicrotasks();

    expect(result.action).toBe('case_updated');
    expect(h.events.find((e) => e.type === 'case_escalated')).toBeUndefined();
  });

  it('a push enrichment with no changed_files never overwrites the existing risk_level (issue #1020)', async () => {
    // Revert the `hasFileSignal` guard in `evaluateObservedCaseEscalation`
    // and this `low` risk_level would flip to the ungrounded `medium`
    // default on every enrichment that lacks a file list — e.g. a `push`
    // payload — with no human ever having assessed the risk as `medium`.
    const h = makeHarness(makeObservedCase({
      risk_level: 'low',
      current_branch: 'chore/sync-main',
      source_ref: 'chore/sync-main',
    }));

    const result = await h.service.handleGitWebhook(prOpenedPayload({
      action: 'synchronize',
      branch: 'chore/sync-main',
      changed_files: undefined,
      // Neutral title/body/branch — this reproduces the reported bug
      // exactly: no file list AND no text-heuristic signal either, so
      // `detectCaseFields` falls all the way through to its ungrounded
      // `medium` default (`detectRiskLevel`'s "no file paths available"
      // branch), which must never overwrite the case's `low` risk_level.
      title: 'Sync latest main',
      body: 'Routine sync, no functional change',
    }));
    await flushMicrotasks();

    expect(result.action).toBe('case_updated');
    expect(h.currentCase.risk_level).toBe('low');
    expect(h.currentCase.case_type).toBe('observed');
    expect(h.events.find((e) => e.type === 'risk_level_changed')).toBeUndefined();
    expect(h.events.find((e) => e.type === 'case_escalated')).toBeUndefined();
  });

  it('never escalates a manually created case even with high-risk changed files', async () => {
    const h = makeHarness(makeObservedCase({
      case_type: 'ticket_implementation',
      owner_user_id: 'usr_1',
      risk_level: 'low',
    }));

    const result = await h.service.handleGitWebhook(prOpenedPayload());
    await flushMicrotasks();

    expect(result.action).toBe('case_updated');
    expect(h.currentCase.case_type).toBe('ticket_implementation');
    expect(h.currentCase.risk_level).toBe('low');
    expect(h.events.find((e) => e.type === 'case_escalated')).toBeUndefined();
  });
});
