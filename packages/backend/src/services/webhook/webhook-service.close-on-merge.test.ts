import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Case,
  CaseStatus,
  Decision,
  Evidence,
  EventType,
  CreateEvidenceInput,
} from '@arbitra/shared';
import type { GitWebhookPayload } from './webhook-service.js';

// ── Firestore stub (cases lookup by pr_url / branch; evidencePolicies for completeness) ──

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
    evidencePolicies: () => {
      // Resolver uses a single deterministic chain: where('project_id','==',...).get().
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

// ── Test helpers ───────────────────────────────────────────────────────

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_test',
    title: 'Test case',
    description: 'Auto-created from PR',
    source_type: 'git',
    source_ref: 'https://github.com/acme/repo/pull/42',
    project_id: 'proj_test',
    repository_id: 'repo_test',
    owner_user_id: 'usr_owner',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    status: 'in_validation',
    decision_ready: false,
    current_pr_ref: 'https://github.com/acme/repo/pull/42',
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
  readonly currentCase: Case;
}

function makeHarness(initial: Case, decisions: Decision[] = []): TestHarness {
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
    loadPreconditionContext: vi.fn(async () => ({
      case_: currentCase,
      runs: [],
      findings: [],
      ruleResults: [],
      evidence: [],
      decisions,
      // The pr_merged precondition checks ctx.events for an event of type 'pr_merged'.
      // Mirror emissions so the pipeline's precondition evaluator sees them.
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

// Wait for fire-and-forget pipeline side-effects to complete.
async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('WebhookService — close-on-merge auto-transition', () => {
  beforeEach(() => {
    caseForPR.value = null;
    delete process.env['ARBITRA_AUTO_CLOSE_ON_MERGE'];
  });

  afterEach(() => {
    delete process.env['ARBITRA_AUTO_CLOSE_ON_MERGE'];
  });

  describe.each<CaseStatus>(['in_build', 'in_validation', 'in_review', 'approved'])(
    'eligible source status: %s',
    (sourceStatus) => {
      it(`auto-closes case to done, emits pr_merged + case_auto_closed_on_merge, registers synthetic evidence, adds audit comment`, async () => {
        const h = makeHarness(makeCase({ status: sourceStatus }));

        const result = await h.service.handleGitWebhook(mergePayload());
        await flushMicrotasks();

        expect(result).toEqual({ action: 'pr_merged_event', case_id: 'case_test' });

        const types = h.events.map((e) => e.type);
        expect(types).toContain('pr_merged');
        expect(types).toContain('case_auto_closed_on_merge');
        expect(types).toContain('case_completed');
        expect(types).toContain('comment_added');

        expect(h.evidenceRegistered).toHaveLength(1);
        expect(h.evidenceRegistered[0]).toMatchObject({
          case_id: 'case_test',
          type: 'pr_merged',
          source_type: 'webhook',
          machine_readable: true,
        });
        expect(h.evidenceRegistered[0]?.summary).toContain('https://github.com/acme/repo/pull/42');

        expect(h.currentCase.status).toBe('done');
      });
    },
  );

  // ── Issue #1000: escalated/high-risk case — the gate must ALSO stop the
  // webhook's own eligible-branch side effects, not just the transition.
  // Driven through the real `handleGitWebhook` seam (not the precondition
  // function in isolation) because that is the only way to catch the
  // false "Case auto-closed on PR merge" audit comment:
  // an in-process precondition unit test cannot see whether the webhook
  // wrote that comment before finding out the transition would not fire.
  describe.each<CaseStatus>(['in_build', 'in_validation', 'in_review', 'approved'])(
    'escalated/high-risk source status: %s, no approval decision documented',
    (sourceStatus) => {
      it('does NOT auto-close, does NOT write the false "auto-closed" comment or synthetic evidence, records the gated-merge anomaly instead, and still records pr_merged for later', async () => {
        const h = makeHarness(makeCase({ status: sourceStatus, risk_level: 'high', case_type: 'other' }));

        const result = await h.service.handleGitWebhook(mergePayload());
        await flushMicrotasks();

        // Revert line 623-ish (`if (!gate.satisfied)` branch removed / gate
        // always treated as satisfied) and this fails: the case would jump
        // to `done` and `action` would read `pr_merged_event` instead.
        expect(result).toEqual({ action: 'pr_merged_gated', case_id: 'case_test' });
        expect(h.currentCase.status).toBe(sourceStatus);

        const types = h.events.map((e) => e.type);
        expect(types).not.toContain('case_completed');
        expect(types).not.toContain('case_auto_closed_on_merge');

        // The audit trail must not lie: no comment claiming closure, and no
        // synthetic pr_merged evidence backing a completeness score for a
        // case that did not actually complete.
        const autoCloseComment = h.events.find(
          (e) =>
            e.type === 'comment_added' &&
            typeof e.payload['body'] === 'string' &&
            (e.payload['body'] as string).includes('Case auto-closed on PR merge'),
        );
        expect(autoCloseComment).toBeUndefined();
        expect(h.evidenceRegistered).toHaveLength(0);

        // Instead: the same anomaly signal a human-gated source status gets —
        // the frontend already renders this generically off `source_status`.
        const anomaly = h.events.find((e) => e.type === 'case_anomaly_merge_on_gated_status');
        expect(anomaly).toBeDefined();
        expect(anomaly?.payload).toMatchObject({
          source_status: sourceStatus,
          reason: expect.stringContaining('high-risk'),
        });

        // `pr_merged` still stands — the PR-merged webhook fires once and
        // will not come again; without this event a case that later
        // completes its steps and reaches `pending_merge` would be stuck
        // there forever waiting for a merge signal that already happened.
        expect(types).toContain('pr_merged');
      });
    },
  );

  it('escalated/high-risk case DOES still auto-close once an approval decision is documented — the gate blocks unmet evidence, not risk level itself', async () => {
    const h = makeHarness(
      makeCase({ status: 'in_review', risk_level: 'critical', case_type: 'other' }),
      [
        {
          decision_id: 'dec_1',
          case_id: 'case_test',
          type: 'approve',
          actor_id: 'usr_reviewer',
          rationale: 'looks good',
          snapshot: { active_rule_set_versions: {}, evidence_policy_version: 1, knowledge_asset_refs: [] },
          created_at: '2026-01-02T10:00:00Z',
        },
      ],
    );

    const result = await h.service.handleGitWebhook(mergePayload());
    await flushMicrotasks();

    // Revert the polarity (drop the risk-level check, or restore the
    // `validation_track === 'direct'` restriction from
    // `track_is_direct_and_high_critical_risk`) and this either still passes
    // vacuously or starts failing for the wrong reason — this test's partner
    // above (no decision documented) is what actually pins the polarity;
    // this one proves the gate is not simply "never close a high-risk case".
    expect(result).toEqual({ action: 'pr_merged_event', case_id: 'case_test' });
    expect(h.currentCase.status).toBe('done');

    const types = h.events.map((e) => e.type);
    expect(types).toContain('case_auto_closed_on_merge');
    expect(types).toContain('comment_added');
    expect(h.evidenceRegistered).toHaveLength(1);
  });

  it('merged=false (closed without merge): emits pr_closed only, case unchanged', async () => {
    const h = makeHarness(makeCase({ status: 'in_validation' }));

    const result = await h.service.handleGitWebhook(mergePayload({ merged: false }));
    await flushMicrotasks();

    expect(result).toEqual({ action: 'pr_closed_event', case_id: 'case_test' });
    const types = h.events.map((e) => e.type);
    expect(types).toEqual(['pr_closed']);
    expect(h.evidenceRegistered).toHaveLength(0);
    expect(h.currentCase.status).toBe('in_validation');
  });

  it('case already done: terminal-state guard returns ignored action, no mutations', async () => {
    const h = makeHarness(makeCase({ status: 'done' }));

    const result = await h.service.handleGitWebhook(mergePayload());
    await flushMicrotasks();

    expect(result.action).toBe('ignored');
    expect(result.reason).toContain('terminal');
    expect(h.events).toHaveLength(0);
    expect(h.evidenceRegistered).toHaveLength(0);
  });

  describe.each<CaseStatus>(['verification_pending', 'needs_human_decision', 'open'])(
    'anomaly source status: %s',
    (sourceStatus) => {
      it('emits case_anomaly_merge_on_gated_status, does NOT auto-close, status unchanged', async () => {
        const h = makeHarness(makeCase({ status: sourceStatus }));

        const result = await h.service.handleGitWebhook(mergePayload());
        await flushMicrotasks();

        expect(result).toEqual({
          action: 'pr_merged_anomaly',
          case_id: 'case_test',
          reason: expect.stringContaining(sourceStatus),
        });

        const types = h.events.map((e) => e.type);
        expect(types).toContain('case_anomaly_merge_on_gated_status');
        // `pr_merged` must NOT be emitted on the anomaly path — otherwise the
        // pipeline precondition would fire and silently advance the case,
        // masking the very anomaly we want to surface to the operator.
        expect(types).not.toContain('pr_merged');
        expect(types).not.toContain('case_auto_closed_on_merge');
        expect(types).not.toContain('case_completed');

        expect(h.evidenceRegistered).toHaveLength(0);
        expect(h.currentCase.status).toBe(sourceStatus);

        const anomaly = h.events.find((e) => e.type === 'case_anomaly_merge_on_gated_status');
        expect(anomaly?.payload).toMatchObject({
          pr_url: 'https://github.com/acme/repo/pull/42',
          pr_number: 42,
          branch: 'feat/test',
          commit_sha: 'abc123',
          source_status: sourceStatus,
          reason: expect.stringContaining('gated'),
        });
        expect(typeof anomaly?.payload['merged_at']).toBe('string');
      });
    },
  );

  it('no case found for PR URL: returns ignored', async () => {
    caseForPR.value = null;
    const service = new WebhookService(
      { getById: vi.fn(), update: vi.fn() } as never,
      { createCase: vi.fn() } as never,
      { registerEvidence: vi.fn() } as never,
      { emit: vi.fn() } as never,
    );

    const result = await service.handleGitWebhook(mergePayload());
    expect(result).toEqual({ action: 'ignored' });
  });

  it('feature flag OFF: eligible status does NOT auto-close, only pr_merged event emitted, no synthetic evidence', async () => {
    process.env['ARBITRA_AUTO_CLOSE_ON_MERGE'] = 'false';
    const h = makeHarness(makeCase({ status: 'in_validation' }));

    const result = await h.service.handleGitWebhook(mergePayload());
    await flushMicrotasks();

    expect(result).toEqual({ action: 'pr_merged_event', case_id: 'case_test' });
    const types = h.events.map((e) => e.type);
    expect(types).toContain('pr_merged');
    expect(types).not.toContain('case_auto_closed_on_merge');
    expect(types).not.toContain('case_completed');
    expect(types).not.toContain('comment_added');
    expect(h.evidenceRegistered).toHaveLength(0);
    expect(h.currentCase.status).toBe('in_validation');
  });
});
