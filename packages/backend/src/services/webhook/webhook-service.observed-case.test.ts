/**
 * End-to-end coverage for the Observed Case lifecycle's merge-closes-the-case
 * edge (issue #986): a PR merge on a case_type: 'observed' case at `in_build`
 * auto-closes to `done` via the SAME webhook auto-close-on-merge code path as
 * every other case type (`webhook-service.close-on-merge.test.ts`) — the only
 * thing that differs is which TRANSITION_MATRIX entry the real
 * `RunCompletionHandler` + real `preconditions.ts` resolve, because
 * `case_type: 'observed'` is now in `SCOPED_CASE_TYPES`.
 *
 * Harness is a trimmed copy of `webhook-service.close-on-merge.test.ts`'s —
 * see that file for the fuller rationale of each stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case, EventType, CreateEvidenceInput } from '@arbitra/shared';
import type { GitWebhookPayload } from './webhook-service.js';

const caseForPR: { value: Case | null } = { value: null };

vi.mock('../../lib/firestore.js', () => {
  const casesMock = () => ({
    where: () => ({
      limit: () => ({
        get: vi.fn().mockImplementation(async () => {
          if (caseForPR.value === null) return { empty: true, docs: [] };
          return { empty: false, docs: [{ data: () => caseForPR.value }] };
        }),
      }),
    }),
  });
  return {
    collections: {
      cases: casesMock,
      activeCases: casesMock,
      evidencePolicies: () => {
        const whereNode = { get: vi.fn().mockResolvedValue({ empty: true, docs: [] }) };
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
    title: 'Observed: feat/test',
    description: 'Auto-created from agent activity',
    source_type: 'git',
    source_ref: 'feat/test',
    project_id: 'proj_test',
    repository_id: 'repo_test',
    owner_user_id: 'system:observed-case',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    case_type: 'observed',
    status: 'in_build',
    decision_ready: false,
    current_pr_ref: 'https://github.com/acme/repo/pull/42',
    current_branch: 'feat/test',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Case;
}

function makeHarness(initial: Case) {
  const events: Array<{ type: EventType; payload: Record<string, unknown> }> = [];
  const evidenceRegistered: CreateEvidenceInput[] = [];
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
      };
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
      // The real `pr_merged` precondition checks ctx.events for a `pr_merged`
      // event type — mirror emissions so it evaluates for real, exactly like
      // it would in production.
      events: events.map((e) => ({ type: e.type })),
      actorId: 'system',
    })),
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
    get currentCase() {
      return currentCase;
    },
  };
}

function mergePayload(overrides: Partial<GitWebhookPayload> = {}): GitWebhookPayload {
  return {
    action: 'closed',
    pr_number: 42,
    pr_url: 'https://github.com/acme/repo/pull/42',
    branch: 'feat/test',
    commit_sha: 'abc123',
    repository: 'acme/repo',
    merged: true,
    ...overrides,
  };
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('WebhookService — Observed Case merge closes the case (#986)', () => {
  beforeEach(() => {
    caseForPR.value = null;
    delete process.env['ARBITRA_AUTO_CLOSE_ON_MERGE'];
  });

  afterEach(() => {
    delete process.env['ARBITRA_AUTO_CLOSE_ON_MERGE'];
  });

  it('an in_build Observed Case auto-closes to done on PR merge via the observed-scoped transition', async () => {
    // Reverting the `case_types: ['observed']` in_build→done matrix entry
    // (status-transitions.ts) — or reverting 'observed' out of
    // `SCOPED_CASE_TYPES` — removes the only route this case has to `done`
    // and this assertion on `h.currentCase.status` fails (status stays
    // `in_build`; only `pr_merged`/`case_auto_closed_on_merge` events land).
    const h = makeHarness(makeObservedCase());

    const result = await h.service.handleGitWebhook(mergePayload());
    await flushMicrotasks();

    expect(result).toEqual({ action: 'pr_merged_event', case_id: 'case_test' });

    const types = h.events.map((e) => e.type);
    expect(types).toContain('pr_merged');
    expect(types).toContain('case_auto_closed_on_merge');
    expect(types).toContain('case_completed');
    expect(h.currentCase.status).toBe('done');
  });

  it('an in_build Observed Case with the flag disabled emits pr_merged but does not auto-close', async () => {
    process.env['ARBITRA_AUTO_CLOSE_ON_MERGE'] = 'false';
    const h = makeHarness(makeObservedCase());

    await h.service.handleGitWebhook(mergePayload());
    await flushMicrotasks();

    expect(h.events.map((e) => e.type)).toEqual(['pr_merged']);
    expect(h.currentCase.status).toBe('in_build');
  });

  it('an already-done Observed Case ignores a second merge webhook (terminal guard)', async () => {
    const h = makeHarness(makeObservedCase({ status: 'done' }));

    const result = await h.service.handleGitWebhook(mergePayload());
    await flushMicrotasks();

    expect(result.action).toBe('ignored');
    expect(h.events).toHaveLength(0);
  });

  // Issue #996: the claim transaction that creates an Observed Case commits
  // its `status: 'open'` write, then the `open → in_build` auto-transition
  // runs as a separate step — if that call fails or the process dies in
  // between, the case is stuck at `open`. Before this fix, a PR merging
  // while stuck read `open` as a gated/unexplored source status and recorded
  // `pr_merged_anomaly` instead of closing the case, silently (Observed
  // Cases have no human queue to surface the anomaly to).
  it('a merge on an Observed Case stuck at open (post-commit transition never landed) repairs and closes it, instead of recording an anomaly', async () => {
    const h = makeHarness(makeObservedCase({ status: 'open' }));

    const result = await h.service.handleGitWebhook(mergePayload());
    await flushMicrotasks();

    expect(result.action).not.toBe('pr_merged_anomaly');
    expect(result).toEqual({ action: 'pr_merged_event', case_id: 'case_test' });

    const types = h.events.map((e) => e.type);
    expect(types).not.toContain('case_anomaly_merge_on_gated_status');
    expect(types).toContain('pr_merged');
    expect(types).toContain('case_auto_closed_on_merge');
    expect(h.currentCase.status).toBe('done');
  });
});
