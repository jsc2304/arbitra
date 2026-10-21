/**
 * Tests for auto-reject-orphan on `pr_closed` while case is still in `open`.
 * Mirrors `webhook-service.close-on-merge.test.ts` shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Case,
  CaseStatus,
  Evidence,
  EventType,
  CreateEvidenceInput,
} from '@arbitra/shared';
import type { GitWebhookPayload } from './webhook-service.js';

const caseForPR: { value: Case | null } = { value: null };

vi.mock('../../lib/firestore.js', () => {
  const casesMock = () => ({
    where: () => ({
      limit: () => ({
        get: vi.fn().mockImplementation(async () => {
          if (caseForPR.value === null) {
            return { empty: true, docs: [] };
          }
          return {
            empty: false,
            docs: [{ data: () => caseForPR.value }],
          };
        }),
      }),
    }),
  });
  return {
    collections: {
      cases: casesMock,
      activeCases: casesMock,
      evidencePolicies: () => ({
        where: () => ({
          get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
        }),
      }),
    },
  };
});

vi.mock('../../lib/ids.js', () => ({
  generateId: (prefix: string) => `${prefix}_test`,
}));

import { WebhookService } from './webhook-service.js';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_test',
    title: 'Test case',
    description: 'Auto-created from PR',
    source_type: 'git',
    source_ref: 'https://github.com/acme/repo/pull/25',
    project_id: 'proj_test',
    repository_id: 'repo_test',
    owner_user_id: 'usr_owner',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    status: 'open',
    decision_ready: false,
    current_pr_ref: 'https://github.com/acme/repo/pull/25',
    current_branch: 'feat/test',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Case;
}

interface TestHarness {
  service: WebhookService;
  events: Array<{ type: EventType; payload: Record<string, unknown> }>;
  evidenceRegistered: CreateEvidenceInput[];
  pipelineCalls: string[];
  readonly currentCase: Case;
}

function makeHarness(initial: Case): TestHarness {
  const events: Array<{ type: EventType; payload: Record<string, unknown> }> = [];
  const evidenceRegistered: CreateEvidenceInput[] = [];
  const pipelineCalls: string[] = [];
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

  const caseService = {
    createCase: vi.fn(async () => currentCase),
  } as never;

  const evidenceService = {
    registerEvidence: vi.fn(async (input: CreateEvidenceInput) => {
      evidenceRegistered.push(input);
      return {
        evidence_id: 'evidence_test',
        case_id: input.case_id,
        type: input.type,
        source_type: input.source_type,
        artifact_ref: input.artifact_ref,
        summary: input.summary,
        machine_readable: input.machine_readable ?? false,
        validation_track: currentCase.validation_track,
        created_at: '2026-01-01T00:00:00Z',
        created_by: 'system',
      } as Evidence;
    }),
  } as never;

  const eventService = {
    emit: vi.fn(async (_caseId: string, type: EventType, payload: Record<string, unknown>) => {
      events.push({ type, payload });
      return { event_id: 'event_test', case_id: _caseId, type, actor_id: 'system', payload, created_at: '2026-01-01T00:00:00Z' };
    }),
  } as never;

  const pipelineAdapter = {
    getCase: vi.fn(async () => currentCase),
    updateCaseStatus: vi.fn(async (_id: string, status: CaseStatus) => {
      currentCase = { ...currentCase, status };
      caseForPR.value = currentCase;
      return currentCase;
    }),
    updateCase: vi.fn(async (_id: string, updates: Partial<Case>) => {
      currentCase = { ...currentCase, ...updates };
      caseForPR.value = currentCase;
      return currentCase;
    }),
    loadPreconditionContext: vi.fn(async () => {
      pipelineCalls.push('loadPreconditionContext');
      return {
        case_: currentCase,
        runs: [],
        findings: [],
        ruleResults: [],
        evidence: [],
        decisions: [],
        events: events.map((e) => ({ type: e.type })),
        actorId: 'system',
      };
    }),
    createRun: vi.fn(async () => ({ run_id: 'run_test', case_id: currentCase.case_id, run_type: 'rule_run', trigger_source: 'system', status: 'completed', input_refs: [], output_refs: [], created_at: '', updated_at: '' })),
    completeRun: vi.fn(async () => ({ run_id: 'run_test', case_id: currentCase.case_id, run_type: 'rule_run', trigger_source: 'system', status: 'completed', input_refs: [], output_refs: [], created_at: '', updated_at: '' })),
    failRun: vi.fn(async () => ({ run_id: 'run_test', case_id: currentCase.case_id, run_type: 'rule_run', trigger_source: 'system', status: 'failed', input_refs: [], output_refs: [], created_at: '', updated_at: '' })),
    emitEvent: vi.fn(async (_caseId: string, type: EventType, payload: Record<string, unknown>) => {
      events.push({ type, payload });
    }),
    getActiveRuns: vi.fn(async () => []),
    createAutoApproveDecision: vi.fn(async () => ({ decision_id: 'dec_test', case_id: currentCase.case_id, type: 'auto_approve', actor_id: 'system', rationale: 'auto', snapshot: {}, created_at: '' })),
    closeOutstandingWaiverProposals: vi.fn(async () => ({ closed: 0 })),
    getProjectLifecycleProfile: vi.fn(async () => undefined),
  } as never;

  const service = new WebhookService(caseRepo, caseService, evidenceService, eventService, pipelineAdapter);

  return {
    service,
    events,
    evidenceRegistered,
    pipelineCalls,
    get currentCase() {
      return currentCase;
    },
  };
}

function closedPayload(overrides: Partial<GitWebhookPayload> = {}): GitWebhookPayload {
  return {
    action: 'closed',
    pr_number: 25,
    pr_url: 'https://github.com/acme/repo/pull/25',
    branch: 'feat/test',
    commit_sha: 'abc123',
    repository: 'acme/repo',
    merged: false,
    ...overrides,
  };
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('WebhookService — auto-reject orphan on pr_closed', () => {
  beforeEach(() => {
    caseForPR.value = null;
    delete process.env['AUTO_REJECT_ORPHAN_ON_PR_CLOSED'];
    delete process.env['ARBITRA_AUTO_CLOSE_ON_MERGE'];
  });

  afterEach(() => {
    delete process.env['AUTO_REJECT_ORPHAN_ON_PR_CLOSED'];
    delete process.env['ARBITRA_AUTO_CLOSE_ON_MERGE'];
  });

  it('flag ON + status open: emits pr_closed + audit comment, triggers pipeline, returns pr_closed_auto_rejected', async () => {
    process.env['AUTO_REJECT_ORPHAN_ON_PR_CLOSED'] = 'true';
    const h = makeHarness(makeCase({ status: 'open' }));

    const result = await h.service.handleGitWebhook(closedPayload());
    await flushMicrotasks();

    expect(result).toEqual({ action: 'pr_closed_auto_rejected', case_id: 'case_test' });

    const types = h.events.map((e) => e.type);
    // pr_closed first, then comment_added (audit), then any pipeline-emitted
    // events (case_rejected) once the synthetic transition fires.
    expect(types[0]).toBe('pr_closed');
    expect(types).toContain('comment_added');

    const auditComment = h.events.find(
      (e) => e.type === 'comment_added'
        && String((e.payload as { body?: string }).body ?? '').startsWith('Case auto-rejected'),
    );
    expect(auditComment).toBeDefined();
    expect(String(auditComment!.payload['body'])).toContain('PR #25 closed unmerged before exploration started');

    // Pipeline triggered (which evaluates the open → rejected synthetic transition).
    expect(h.pipelineCalls).toContain('loadPreconditionContext');
  });

  it('flag OFF (default): emits pr_closed only, no audit, no pipeline trigger, returns pr_closed_event', async () => {
    const h = makeHarness(makeCase({ status: 'open' }));

    const result = await h.service.handleGitWebhook(closedPayload());
    await flushMicrotasks();

    expect(result).toEqual({ action: 'pr_closed_event', case_id: 'case_test' });
    const types = h.events.map((e) => e.type);
    expect(types).toEqual(['pr_closed']);
    expect(h.pipelineCalls).not.toContain('loadPreconditionContext');
  });

  it('flag ON but case is past open (e.g. in_build): does NOT auto-reject', async () => {
    process.env['AUTO_REJECT_ORPHAN_ON_PR_CLOSED'] = 'true';
    const h = makeHarness(makeCase({ status: 'in_build' }));

    const result = await h.service.handleGitWebhook(closedPayload());
    await flushMicrotasks();

    expect(result).toEqual({ action: 'pr_closed_event', case_id: 'case_test' });
    const types = h.events.map((e) => e.type);
    expect(types).toEqual(['pr_closed']);
    expect(h.pipelineCalls).not.toContain('loadPreconditionContext');
  });

  it('flag explicit false treated as off', async () => {
    process.env['AUTO_REJECT_ORPHAN_ON_PR_CLOSED'] = 'false';
    const h = makeHarness(makeCase({ status: 'open' }));

    const result = await h.service.handleGitWebhook(closedPayload());
    await flushMicrotasks();

    expect(result).toEqual({ action: 'pr_closed_event', case_id: 'case_test' });
  });

  it('terminal-state guard preempts everything when case is rejected', async () => {
    process.env['AUTO_REJECT_ORPHAN_ON_PR_CLOSED'] = 'true';
    const h = makeHarness(makeCase({ status: 'rejected' }));

    const result = await h.service.handleGitWebhook(closedPayload());
    await flushMicrotasks();

    expect(result.action).toBe('ignored');
    expect(h.events).toHaveLength(0);
  });
});
