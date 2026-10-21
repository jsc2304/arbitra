import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Case,
  CaseEvent,
  CreateDecisionInput,
  Decision,
  EvidencePolicyRule,
  Rule,
  RuleResult,
  RuleSet,
} from '@arbitra/shared';

// Capture the last Decision written so tests can assert on server-derived fields
// like `self_approved`. Kept module-local so each test runs independently via
// `beforeEach(vi.clearAllMocks)`.
const lastWrittenDecision: { value: Decision | null } = { value: null };

// Stub firestore collections so decision writes / finding lookups are no-ops
// Mock findings returned by `collections.findings().where(...).get()`.
// Default is an empty list so the approval guardrail does not block
// unrelated tests. Individual tests can override via `findingsQueryDocs`.
const findingsQueryDocs: { value: { data: () => unknown }[] } = { value: [] };

// Mock decisions returned by `collections.decisions().where(...).get()`.
// Used by the auto-attach manual_validation_confirmed path to detect
// existing validation decisions on the case. Default empty.
const decisionsQueryDocs: { value: { data: () => unknown }[] } = { value: [] };

// Mock events returned by `collections.caseEvents().where(...).get()`.
// Used by the auto-attach idempotency check to compute the iteration
// boundary (most recent of changes_requested / manual_verification_requested).
// Default empty -> boundary is null -> any existing manual_validation_confirmed
// counts (preserves pre-fix behavior for unrelated tests).
const eventsQueryDocs: { value: { data: () => unknown }[] } = { value: [] };

const activeRuleQueryDocs: { value: { data: () => Rule }[] } = { value: [] };
const ruleSetQueryDocs: { value: { data: () => RuleSet }[] } = { value: [] };

// Mock runs returned by `collections.runs().where(...).get()`. Used by the
// `review_not_applicable` current-iteration-completed-run guard. Default
// empty (no runs).
const runsQueryDocs: { value: { data: () => unknown }[] } = { value: [] };

// Capture all Decision writes (in order) so tests can assert that the
// auto-attached manual_validation_confirmed lands BEFORE the approve.
const writtenDecisions: { value: Decision[] } = { value: [] };

// Controls whether `collections.findings().doc(id).get()` reports the finding
// as existing (so the status/resolution update path runs) and captures the
// payload passed to `.update(...)`. Default: finding does not exist (matches
// prior behavior for unrelated tests).
const findingDocState: {
  exists: boolean;
  data: Record<string, unknown>;
  lastUpdate: Record<string, unknown> | null;
} = { exists: false, data: {}, lastUpdate: null };

// Controls `collections.projects().doc(id).get()` — used by the gate
// confirmer-role check (`DecisionService.checkConfirmerRole`). Default: no
// project (role check fails closed), matching prior behavior for unrelated
// tests. Tests that need the role check to pass set `exists: true` with a
// `reviewer_pool`/`tech_leads` containing the acting user.
const projectDocState: { exists: boolean; data: Record<string, unknown> } = {
  exists: false,
  data: {},
};

// Ground-truth store for RuleResult docs mutated by the human_confirmation
// gate flip (issue #738). Both `collections.ruleResults().doc(id).update()`
// (invoked at fake-transaction commit time — see `getDb` below) and the
// wholesale-fake `ruleRepository.updateRuleResult` (used to reproduce the
// PRE-FIX per-item loop when this file's source is git-stashed back — see the
// atomicity describe block) write into this same store, so a test can assert
// on final RuleResult state regardless of which code path is under test.
const ruleResultsStore: { value: Record<string, RuleResult> } = { value: {} };

// Records every RuleResult flip actually applied (i.e. that survived a fake
// transaction commit, or a successful `ruleRepository.updateRuleResult`
// call) — the direct replacement for asserting against
// `updateRuleResultCalls` now that the gate-flip write goes through a
// Firestore transaction instead of the repository method.
const ruleResultUpdateCalls: { value: { resultId: string; patch: Record<string, unknown> }[] } = { value: [] };

// Set to a RuleResult id to make that specific flip fail — simulates "a
// transient Firestore error on result N of M" from issue #738. Consulted by
// both the fake transaction commit (new code) and the wholesale
// `ruleRepository.updateRuleResult` fake (old code, via git stash).
const poisonResultId: { value: string | null } = { value: null };

function applyRuleResultUpdate(resultId: string, patch: Record<string, unknown>): void {
  ruleResultUpdateCalls.value.push({ resultId, patch });
  ruleResultsStore.value[resultId] = { ...ruleResultsStore.value[resultId], ...patch } as RuleResult;
}

vi.mock('../../lib/firestore.js', () => {
  const decisionsDoc = () => ({
    get: vi.fn().mockResolvedValue({ exists: false }),
    set: vi.fn(async (d: Decision) => {
      lastWrittenDecision.value = d;
      writtenDecisions.value.push(d);
    }),
    update: vi.fn().mockResolvedValue(undefined),
  });
  const otherDoc = () => ({
    get: vi.fn().mockResolvedValue({ exists: false }),
    set: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  });
  const findingDoc = () => ({
    get: vi.fn(async () => ({
      exists: findingDocState.exists,
      data: () => findingDocState.data,
    })),
    set: vi.fn().mockResolvedValue(undefined),
    update: vi.fn(async (payload: Record<string, unknown>) => {
      findingDocState.lastUpdate = payload;
    }),
  });
  const findingsCollection = () => ({
    doc: findingDoc,
    where: () => ({
      get: vi.fn(async () => ({ docs: findingsQueryDocs.value })),
    }),
  });
  const decisionsCollection = () => ({
    doc: decisionsDoc,
    where: () => ({
      get: vi.fn(async () => ({ docs: decisionsQueryDocs.value })),
    }),
  });
  const caseEventsCollection = () => ({
    doc: otherDoc,
    where: () => ({
      get: vi.fn(async () => ({ docs: eventsQueryDocs.value })),
    }),
  });
  const runsCollection = () => ({
    doc: otherDoc,
    where: () => ({
      get: vi.fn(async () => ({ docs: runsQueryDocs.value })),
    }),
  });
  const projectDoc = () => ({
    get: vi.fn(async () => ({
      exists: projectDocState.exists,
      data: () => projectDocState.data,
    })),
  });
  // `collections.ruleResults().doc(id)` — backs the human_confirmation gate
  // flip. `.update()` is the primitive both the fake transaction (below) and
  // the wholesale `ruleRepository.updateRuleResult` fake ultimately apply
  // writes through (see `applyRuleResultUpdate`), so ground truth always
  // lands in the same `ruleResultsStore`.
  const ruleResultDoc = (id: string) => ({
    __resultId: id,
    get: vi.fn(async () => ({
      exists: ruleResultsStore.value[id] !== undefined,
      data: () => ruleResultsStore.value[id],
    })),
    update: vi.fn(async (patch: Record<string, unknown>) => {
      applyRuleResultUpdate(id, patch);
    }),
  });
  const ruleResultsCollection = () => ({ doc: ruleResultDoc });
  return {
    collections: {
      decisions: decisionsCollection,
      findings: findingsCollection,
      caseEvents: caseEventsCollection,
      runs: runsCollection,
      ruleResults: ruleResultsCollection,
      projects: () => ({ doc: projectDoc }),
      rules: () => ({
        where: () => ({
          get: vi.fn(async () => ({ docs: activeRuleQueryDocs.value })),
        }),
      }),
      ruleSets: () => ({
        get: vi.fn(async () => ({ docs: ruleSetQueryDocs.value })),
      }),
      // Reviewer role so `checkWaivePermission` passes for high/critical waives.
      users: () => ({
        doc: () => ({
          get: vi.fn(async () => ({ exists: true, data: () => ({ roles: ['reviewer'] }) })),
        }),
      }),
    },
    // Minimal fake Firestore transaction: `tx.set`/`tx.update` only STAGE the
    // write (mirroring the real SDK, where nothing hits the server until
    // commit). Once the callback resolves, a single check runs across every
    // staged write before ANY of them apply — if one targets `poisonResultId`,
    // the whole commit throws and NOTHING is written (this is what "batched
    // writes / transactions commit atomically" buys us: there is no such
    // thing as "write N of M already landed" once you're inside one). Used by
    // `resolveHumanConfirmationGate` (issue #738).
    getDb: () => ({
      runTransaction: async (fn: (tx: {
        get: (ref: { get: () => unknown }) => Promise<unknown>;
        set: (ref: { set: (data: unknown) => unknown }, data: unknown) => void;
        update: (ref: { __resultId?: string; update: (patch: unknown) => unknown }, patch: unknown) => void;
      }) => Promise<void>) => {
        const pending: Array<() => Promise<unknown>> = [];
        let poisoned = false;
        const tx = {
          get: async (ref: { get: () => unknown }) => ref.get(),
          set: (ref: { set: (data: unknown) => unknown }, data: unknown) => {
            pending.push(async () => ref.set(data));
          },
          update: (ref: { __resultId?: string; update: (patch: unknown) => unknown }, patch: unknown) => {
            if (ref.__resultId !== undefined && ref.__resultId === poisonResultId.value) {
              poisoned = true;
            }
            pending.push(async () => ref.update(patch));
          },
        };
        await fn(tx);
        if (poisoned) {
          throw new Error(`Simulated transient Firestore error committing RuleResult ${poisonResultId.value}`);
        }
        for (const apply of pending) {
          await apply();
        }
      },
    }),
  };
});

vi.mock('../../lib/ids.js', () => ({
  generateId: (prefix: string) => `${prefix}_test`,
}));

// Capture the case ids passed to RunCompletionHandler.onRunCompleted so tests
// can assert the post-transition pipeline chain fires (and only fires) when a
// decision actually triggered a transition. Stubbing these two modules keeps
// the unit test off Firestore — the production code news up both classes
// internally (no DI seam) inside the `didTransition` branch of createDecision.
const onRunCompletedCalls: { value: string[] } = { value: [] };

vi.mock('../orchestration/firestore-pipeline-adapter.js', () => ({
  FirestorePipelineAdapter: vi.fn(() => ({})),
}));

vi.mock('../orchestration/pipeline.js', () => ({
  RunCompletionHandler: vi.fn(() => ({
    onRunCompleted: vi.fn(async (caseId: string) => {
      onRunCompletedCalls.value.push(caseId);
      return {};
    }),
    executeGateConfirmation: vi.fn(async () => ({})),
    executeGateRejection: vi.fn(async () => ({})),
  })),
}));

import { TransitionError } from '@arbitra/shared';
import { DecisionService } from './decision-service.js';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1', title: 'Test', description: '', source_type: 'manual',
    source_ref: '', project_id: 'p1', repository_id: 'r1', owner_user_id: 'usr_owner',
    status: 'verification_pending', validation_track: 'manual', risk_level: 'medium',
    priority: 'normal', active_rule_set_refs: [], knowledge_context_refs: [],
    decision_ready: true, created_at: '', updated_at: '',
    ...overrides,
  };
}

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    rule_id: 'rule_global',
    name: 'rule',
    category: 'code_quality_rule',
    scope: { layer: 'global', ref: 'global' },
    evaluation_mode: 'metadata_check',
    severity_if_failed: 'medium',
    config: {},
    description: '',
    rationale: '',
    status: 'active',
    version: 1,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeRuleSet(overrides: Partial<RuleSet> = {}): RuleSet {
  return {
    rule_set_id: 'ruleset_global',
    name: 'rules',
    description: '',
    rule_refs: ['rule_global'],
    status: 'active',
    version: 1,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeRuleResult(overrides: Partial<RuleResult> = {}): RuleResult {
  return {
    rule_result_id: 'rr_test',
    rule_id: 'rule_gate',
    case_id: 'case_1',
    run_id: 'run_1',
    result_status: 'blocked',
    message: 'Human confirmation required',
    evidence_refs: [],
    evaluated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeHumanConfirmationRule(overrides: Partial<Rule> = {}): Rule {
  return {
    rule_id: 'rule_gate',
    name: 'Deployment window confirmation',
    category: 'release_gate',
    scope: { layer: 'global', ref: 'global' },
    evaluation_mode: 'human_confirmation',
    severity_if_failed: 'high',
    config: {},
    description: '',
    rationale: '',
    status: 'active',
    version: 1,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeEvaluator(
  allowSelfApproval: boolean,
  policyVersion = 1,
  policyId = 'policy_test',
) {
  const rule: EvidencePolicyRule = {
    required_evidence_types: [],
    optional_evidence_types: [],
    four_eyes_required: false,
    allow_self_approval: allowSelfApproval,
  };
  return {
    getEffectivePolicyRule: vi.fn(async () => rule),
    getEffectivePolicy: vi.fn(async () => ({
      rule,
      policy_id: policyId,
      version: policyVersion,
    })),
  };
}

function makeService(
  case_: Case,
  opts: {
    allowSelfApproval?: boolean;
    evidencePolicyId?: string;
    evidencePolicyVersion?: number;
    effectiveRules?: Rule[];
    ruleSets?: RuleSet[];
    /** Rule returned by `getRuleById` — used by the human_confirmation gate path. */
    ruleById?: Rule | null;
    /** RuleResults returned by `getRuleResultsByCaseAndRule`. */
    ruleResultsByCaseAndRule?: RuleResult[];
  } = {},
) {
  const caseRepo = {
    getById: vi.fn(async () => case_),
    update: vi.fn(async (_caseId: string, updates: Partial<Case>) => ({ ...case_, ...updates })),
  } as never;
  const eventService = { emit: vi.fn(async () => ({})) } as never;
  const orchestrationService = { transition: vi.fn(async () => ({})) } as never;
  const evaluator = makeEvaluator(
    opts.allowSelfApproval ?? false,
    opts.evidencePolicyVersion ?? 1,
    opts.evidencePolicyId ?? 'policy_test',
  );
  ruleSetQueryDocs.value = (opts.ruleSets ?? []).map((ruleSet) => ({
    data: () => ruleSet,
  }));
  const updateRuleResultCalls: { resultId: string; patch: Partial<RuleResult> }[] = [];
  const ruleRepository = {
    getActiveRulesForProject: vi.fn(async () => opts.effectiveRules ?? []),
    getRuleById: vi.fn(async () => {
      if (!opts.ruleById) throw new Error('Rule not found');
      return opts.ruleById;
    }),
    getRuleResultsByCaseAndRule: vi.fn(async () => opts.ruleResultsByCaseAndRule ?? []),
    // Only reachable by the PRE-FIX per-item loop (production code no longer
    // calls this for the human_confirmation gate flip — see
    // `resolveHumanConfirmationGate`). Kept wired to the same
    // `ruleResultsStore`/`poisonResultId` the fake transaction uses so the
    // atomicity describe block's assertions hold regardless of which
    // implementation (old loop vs. new transaction) is under test.
    updateRuleResult: vi.fn(async (resultId: string, patch: Partial<RuleResult>) => {
      updateRuleResultCalls.push({ resultId, patch });
      if (resultId === poisonResultId.value) {
        throw new Error(`Simulated transient Firestore error updating RuleResult ${resultId}`);
      }
      applyRuleResultUpdate(resultId, patch);
      return ruleResultsStore.value[resultId]!;
    }),
  };
  const service = new DecisionService(
    caseRepo,
    eventService,
    orchestrationService,
    evaluator as never,
    ruleRepository as never,
  );
  return {
    service,
    caseRepo,
    eventService,
    orchestrationService,
    evaluator,
    ruleRepository,
    updateRuleResultCalls,
  };
}

beforeEach(() => {
  activeRuleQueryDocs.value = [];
  ruleSetQueryDocs.value = [];
});

describe('DecisionService.createDecision — manual_validation_confirmed transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastWrittenDecision.value = null;
    writtenDecisions.value = [];
    decisionsQueryDocs.value = [];
    eventsQueryDocs.value = [];
  });

  it('transitions verification_pending → approved when no finding_id attached', async () => {
    const { service, orchestrationService } = makeService(
      makeCase({ status: 'verification_pending' }),
    );
    const input: CreateDecisionInput = {
      case_id: 'case_1',
      type: 'manual_validation_confirmed',
      rationale: 'manually verified',
    };
    await service.createDecision(input, 'usr_reviewer');
    expect(orchestrationService.transition).toHaveBeenCalledWith(
      'case_1', 'approved', 'usr_reviewer',
    );
  });

  it('transitions verification_pending → approved even when UI attaches a finding_id', async () => {
    // Regression: a case stayed stuck because the guard skipped
    // the transition path whenever finding_id was present.
    const { service, orchestrationService } = makeService(
      makeCase({ status: 'verification_pending' }),
    );
    const input: CreateDecisionInput = {
      case_id: 'case_1',
      finding_id: 'fnd_LitDFntkPXYpfKKi',
      type: 'manual_validation_confirmed',
      rationale: 'manually verified',
    };
    await service.createDecision(input, 'usr_reviewer');
    expect(orchestrationService.transition).toHaveBeenCalledWith(
      'case_1', 'approved', 'usr_reviewer',
    );
  });

  it('does not transition on unrelated finding-level decision types', async () => {
    const { service, orchestrationService } = makeService(
      makeCase({ status: 'in_review' }),
    );
    const input: CreateDecisionInput = {
      case_id: 'case_1',
      finding_id: 'fnd_x',
      type: 'waive',
      rationale: 'not applicable',
    };
    await service.createDecision(input, 'usr_reviewer');
    expect(orchestrationService.transition).not.toHaveBeenCalled();
  });
});

describe('DecisionService.createDecision — merge_not_applicable (issue #687)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastWrittenDecision.value = null;
    writtenDecisions.value = [];
    decisionsQueryDocs.value = [];
    eventsQueryDocs.value = [];
  });

  it('recovers a case stuck in pending_merge: records the decision and transitions to done', async () => {
    const { service, orchestrationService } = makeService(
      makeCase({
        status: 'pending_merge',
        validation_track: 'direct',
        current_branch: 'n/a-ops-config',
      }),
    );
    const input: CreateDecisionInput = {
      case_id: 'case_1',
      type: 'merge_not_applicable',
      rationale: 'Implementation was ops configuration outside any repository — no repository diff, no PR will ever arrive.',
    };
    const result = await service.createDecision(input, 'usr_reviewer');

    expect(lastWrittenDecision.value?.type).toBe('merge_not_applicable');
    expect(orchestrationService.transition).toHaveBeenCalledWith(
      'case_1', 'done', 'usr_reviewer',
    );
    expect(result.transition_error).toBeUndefined();
  });

  it('does not target a transition from statuses where merge_not_applicable has no route', async () => {
    const { service, orchestrationService } = makeService(
      makeCase({ status: 'in_review' }),
    );
    const input: CreateDecisionInput = {
      case_id: 'case_1',
      type: 'merge_not_applicable',
      rationale: 'premature',
    };
    await service.createDecision(input, 'usr_reviewer');
    // Decision is persisted as an audit record but no transition is attempted.
    expect(lastWrittenDecision.value?.type).toBe('merge_not_applicable');
    expect(orchestrationService.transition).not.toHaveBeenCalled();
  });
});

describe('DecisionService.createDecision — review_not_applicable (human escape hatch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastWrittenDecision.value = null;
    writtenDecisions.value = [];
    decisionsQueryDocs.value = [];
    eventsQueryDocs.value = [];
    runsQueryDocs.value = [];
    onRunCompletedCalls.value = [];
    projectDocState.exists = false;
    projectDocState.data = {};
  });

  function makeReviewRunDoc(status: string, createdAt: string) {
    return { data: () => ({ run_type: 'review_run', status, created_at: createdAt }) };
  }

  // Covers: decision-service.ts createReviewNotApplicableDecision — the
  // happy path through decision persist + flag set + both event emissions +
  // pipeline re-evaluation. Reverting any one of those four writes breaks
  // one of the four assertions below.
  it('sets the flag, emits both events, persists the decision, and triggers transition evaluation', async () => {
    projectDocState.exists = true;
    projectDocState.data = { reviewer_pool: ['usr_reviewer'], tech_leads: [] };
    const { service, caseRepo, eventService } = makeService(
      makeCase({ status: 'in_review', owner_user_id: 'usr_owner' }),
    );
    const input: CreateDecisionInput = {
      case_id: 'case_1',
      type: 'review_not_applicable',
      rationale: 'Review run fails permanently — provider quota error, no retry can succeed.',
    };
    const result = await service.createDecision(input, 'usr_reviewer');

    expect(lastWrittenDecision.value?.type).toBe('review_not_applicable');
    expect(caseRepo.update).toHaveBeenCalledWith('case_1', { review_not_applicable: true });
    const emittedTypes = (eventService.emit as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1],
    );
    expect(emittedTypes).toContain('decision_created');
    expect(emittedTypes).toContain('review_not_applicable_marked');
    expect(onRunCompletedCalls.value).toContain('case_1');
    expect(result.transition_error).toBeUndefined();
  });

  // Covers: the `case_.status !== 'in_review'` guard. The actor carries the
  // reviewer role because the permission check runs first by design.
  it('rejects when the case is not in_review', async () => {
    projectDocState.exists = true;
    projectDocState.data = { reviewer_pool: ['usr_reviewer'], tech_leads: [] };
    const { service } = makeService(makeCase({ status: 'in_build' }));
    const input: CreateDecisionInput = {
      case_id: 'case_1',
      type: 'review_not_applicable',
      rationale: 'trying to mark not applicable too early',
    };
    await expect(service.createDecision(input, 'usr_reviewer')).rejects.toThrow(
      /not in_review/i,
    );
  });

  // Covers: the current-iteration completed-review_run guard.
  it('rejects when a completed review_run already exists for the current iteration', async () => {
    projectDocState.exists = true;
    projectDocState.data = { reviewer_pool: ['usr_reviewer'], tech_leads: [] };
    runsQueryDocs.value = [makeReviewRunDoc('completed', '2026-01-02T00:00:00Z')];
    const { service } = makeService(makeCase({ status: 'in_review' }));
    const input: CreateDecisionInput = {
      case_id: 'case_1',
      type: 'review_not_applicable',
      rationale: 'a completed review run already exists',
    };
    await expect(service.createDecision(input, 'usr_reviewer')).rejects.toThrow(
      /already has a completed review run/i,
    );
  });

  // Covers: the `case_.review_not_applicable` idempotency guard.
  it('rejects when the case is already marked review_not_applicable', async () => {
    projectDocState.exists = true;
    projectDocState.data = { reviewer_pool: ['usr_reviewer'], tech_leads: [] };
    const { service } = makeService(
      makeCase({ status: 'in_review', review_not_applicable: true }),
    );
    const input: CreateDecisionInput = {
      case_id: 'case_1',
      type: 'review_not_applicable',
      rationale: 'already flagged',
    };
    await expect(service.createDecision(input, 'usr_reviewer')).rejects.toThrow(
      /already marked review_not_applicable/i,
    );
  });

  // Covers: `checkReviewNotApplicablePermission` — a plain owner with no
  // reviewer/tech_lead/admin role must be rejected, even for their own case.
  it('rejects a plain case owner without reviewer/tech_lead/admin role', async () => {
    // No project doc (exists:false) -> no reviewer_pool/tech_leads membership.
    // Default `users` mock returns roles: ['reviewer'] (a GLOBAL role used by
    // checkWaivePermission elsewhere) — irrelevant here, since this guard
    // only recognizes global 'admin' plus project-scoped pools.
    const { service } = makeService(
      makeCase({ status: 'in_review', owner_user_id: 'usr_owner' }),
    );
    const input: CreateDecisionInput = {
      case_id: 'case_1',
      type: 'review_not_applicable',
      rationale: 'owner trying to self-file without a role',
    };
    await expect(service.createDecision(input, 'usr_owner')).rejects.toThrow(
      /reviewer, tech lead, or admin/i,
    );
  });

  // Covers: the loopback-scoping of the current-iteration guard — a
  // completed review_run from BEFORE the most recent `changes_requested`
  // must not block a fresh escape-hatch request post-loopback.
  it('does not block on a completed review_run from a previous iteration (post-loopback)', async () => {
    projectDocState.exists = true;
    projectDocState.data = { reviewer_pool: ['usr_reviewer'], tech_leads: [] };
    eventsQueryDocs.value = [
      { data: () => ({ type: 'changes_requested', created_at: '2026-01-03T00:00:00Z' }) },
    ];
    // Stale: created BEFORE the loopback boundary.
    runsQueryDocs.value = [makeReviewRunDoc('completed', '2026-01-02T00:00:00Z')];
    const { service, caseRepo } = makeService(makeCase({ status: 'in_review' }));
    const input: CreateDecisionInput = {
      case_id: 'case_1',
      type: 'review_not_applicable',
      rationale: 'post-loopback, the old completed run is stale',
    };
    const result = await service.createDecision(input, 'usr_reviewer');

    expect(lastWrittenDecision.value?.type).toBe('review_not_applicable');
    expect(caseRepo.update).toHaveBeenCalledWith('case_1', { review_not_applicable: true });
    expect(result.transition_error).toBeUndefined();
  });
});

describe('DecisionService.createDecision — allow_self_approval matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastWrittenDecision.value = null;
    writtenDecisions.value = [];
    decisionsQueryDocs.value = [];
    eventsQueryDocs.value = [];
  });

  // Gate confirmation applies regardless of risk level, so we deliberately
  // cover a low-risk case here — proving the check is driven by the policy
  // cell rather than by risk level alone.
  it('blocks owner gate_confirmed when allow_self_approval=false (low-risk case)', async () => {
    const caseWithGate = makeCase({
      status: 'in_review',
      risk_level: 'low',
      pending_gate: { gate_id: 'gate_1', target_status: 'approved', requested_at: '' } as never,
    });
    const { service } = makeService(caseWithGate, { allowSelfApproval: false });
    await expect(
      service.createDecision(
        { case_id: 'case_1', type: 'gate_confirmed', rationale: 'confirm' },
        'usr_owner',
      ),
    ).rejects.toThrow(/anti-gaming/i);
  });

  it('permits owner gate_confirmed when allow_self_approval=true (low-risk case)', async () => {
    // The anti-gaming check is what this test isolates. The role check and
    // pipeline adapter both run AFTER the decision write and are not wired
    // for this unit test — any downstream error is acceptable as long as it
    // isn't the anti-gaming rejection.
    const caseWithGate = makeCase({
      status: 'in_review',
      risk_level: 'low',
      pending_gate: { gate_id: 'gate_1', target_status: 'approved', requested_at: '' } as never,
    });
    const { service } = makeService(caseWithGate, { allowSelfApproval: true });
    try {
      await service.createDecision(
        { case_id: 'case_1', type: 'gate_confirmed', rationale: 'confirm' },
        'usr_owner',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toMatch(/anti-gaming/i);
    }
    // Decision is persisted before gate anti-gaming/role check runs.
    expect(lastWrittenDecision.value?.type).toBe('gate_confirmed');
    expect(lastWrittenDecision.value?.self_approved).toBe(true);
  });

  it('blocks owner approve on high-risk when allow_self_approval=false', async () => {
    const { service } = makeService(
      makeCase({ status: 'in_review', risk_level: 'high' }),
      { allowSelfApproval: false },
    );
    await expect(
      service.createDecision(
        { case_id: 'case_1', type: 'approve', rationale: 'looks good' },
        'usr_owner',
      ),
    ).rejects.toThrow(/Self-approval/i);
  });

  it('permits owner approve on high-risk when allow_self_approval=true and records self_approved audit', async () => {
    const { service } = makeService(
      makeCase({ status: 'in_review', risk_level: 'high' }),
      { allowSelfApproval: true },
    );
    const result = await service.createDecision(
      { case_id: 'case_1', type: 'approve', rationale: 'looks good' },
      'usr_owner',
    );
    expect(result.decision.self_approved).toBe(true);
    expect(lastWrittenDecision.value?.self_approved).toBe(true);
  });

  it('does not set self_approved when a non-owner approves under allow_self_approval=true', async () => {
    const { service } = makeService(
      makeCase({ status: 'in_review', risk_level: 'high' }),
      { allowSelfApproval: true },
    );
    const result = await service.createDecision(
      { case_id: 'case_1', type: 'approve', rationale: 'looks good' },
      'usr_reviewer',
    );
    expect(result.decision.self_approved).toBeUndefined();
    expect(lastWrittenDecision.value?.self_approved).toBeUndefined();
  });

  it('does not set self_approved for unrelated decision types even when owner acts', async () => {
    const { service } = makeService(
      makeCase({ status: 'in_review', risk_level: 'low' }),
      { allowSelfApproval: true },
    );
    const result = await service.createDecision(
      { case_id: 'case_1', type: 'request_changes', rationale: 'please fix' },
      'usr_owner',
    );
    expect(result.decision.self_approved).toBeUndefined();
  });

  it('rejects case-level approve on needs_human_decision when open high/critical findings exist', async () => {
    // Prior behavior recorded the decision and silently swallowed the
    // transition failure. Regression: the endpoint must now fail fast with
    // a structured 409 so the UI can explain why the approve was blocked.
    findingsQueryDocs.value = [
      {
        data: () => ({
          finding_id: 'fnd_open_hi',
          case_id: 'case_1',
          severity: 'high',
          status: 'open',
        }),
      },
    ];
    try {
      const { service } = makeService(
        makeCase({ status: 'needs_human_decision', owner_user_id: 'usr_other' }),
      );
      await expect(
        service.createDecision(
          { case_id: 'case_1', type: 'approve', rationale: 'looks fine to me really' },
          'usr_reviewer',
        ),
      ).rejects.toMatchObject({
        code: 'OPEN_FINDINGS_BLOCK_DECISION',
        statusCode: 409,
      });
    } finally {
      findingsQueryDocs.value = [];
    }
  });

  it.each([['accepted'], ['contested']])(
    'rejects case-level approve on needs_human_decision when blocking findings are in %s status',
    async (status) => {
      // Regression: prior guard only excluded `fixed | waived | resolved`, so
      // `accepted` / `contested` were correctly counted as blocking here. The
      // shared predicate must preserve that behavior after the refactor.
      findingsQueryDocs.value = [
        {
          data: () => ({
            finding_id: `fnd_${status}`,
            case_id: 'case_1',
            severity: 'critical',
            status,
          }),
        },
      ];
      try {
        const { service } = makeService(
          makeCase({ status: 'needs_human_decision', owner_user_id: 'usr_other' }),
        );
        await expect(
          service.createDecision(
            { case_id: 'case_1', type: 'approve', rationale: 'looks fine to me really' },
            'usr_reviewer',
          ),
        ).rejects.toMatchObject({
          code: 'OPEN_FINDINGS_BLOCK_DECISION',
          statusCode: 409,
        });
      } finally {
        findingsQueryDocs.value = [];
      }
    },
  );

  it('allows case-level approve on needs_human_decision when all blocking findings are waived', async () => {
    findingsQueryDocs.value = [
      {
        data: () => ({
          finding_id: 'fnd_waived',
          case_id: 'case_1',
          severity: 'critical',
          status: 'waived',
        }),
      },
    ];
    try {
      const { service, orchestrationService } = makeService(
        makeCase({ status: 'needs_human_decision', owner_user_id: 'usr_other' }),
      );
      await service.createDecision(
        { case_id: 'case_1', type: 'approve', rationale: 'reviewed — waived blocker, good to go' },
        'usr_reviewer',
      );
      // Transition is attempted; it may fail downstream on other preconditions,
      // but the guardrail must NOT have thrown before reaching this point.
      expect(orchestrationService.transition).toHaveBeenCalled();
    } finally {
      findingsQueryDocs.value = [];
    }
  });

  it('allows case-level approve when the only open high/critical finding is submodule-origin (#633)', async () => {
    // A `git submodule add` case may carry open high/critical findings against
    // pre-existing submodule code the approver didn't write. The guardrail
    // must not 409 on those — mirrors the relaxed all_high_critical_resolved.
    findingsQueryDocs.value = [
      {
        data: () => ({
          finding_id: 'fnd_submodule',
          case_id: 'case_1',
          severity: 'critical',
          status: 'open',
          origin: 'submodule',
        }),
      },
    ];
    try {
      const { service, orchestrationService } = makeService(
        makeCase({ status: 'needs_human_decision', owner_user_id: 'usr_other' }),
      );
      await service.createDecision(
        { case_id: 'case_1', type: 'approve', rationale: 'reviewed — submodule findings are out of scope' },
        'usr_reviewer',
      );
      expect(orchestrationService.transition).toHaveBeenCalled();
    } finally {
      findingsQueryDocs.value = [];
    }
  });

  it('returns transition_error when post-decision transition fails (no-diff stuck-in-review case)', async () => {
    // Regression: previously the transition error was logged and swallowed,
    // so the UI toasted "submitted successfully" while the case stayed in_review.
    // Now the decision is still persisted, but the structured error is
    // surfaced on the result so the UI can warn the user.
    //
    // We use verification_pending + manual_validation_confirmed because that
    // pair maps to a real `resolveTransitionTarget` (→ approved); the
    // service then calls orchestrationService.transition, which throws.
    const case_ = makeCase({
      status: 'verification_pending',
      validation_track: 'manual',
      owner_user_id: 'usr_other',
    });
    const caseRepo = { getById: vi.fn(async () => case_) } as never;
    const eventService = { emit: vi.fn(async () => ({})) } as never;
    const failingTransition = vi.fn(async () => {
      throw new Error('preconditions not met: review_run_completed');
    });
    const orchestrationService = { transition: failingTransition } as never;
    const evaluator = makeEvaluator(false);
    const service = new DecisionService(caseRepo, eventService, orchestrationService, evaluator as never);

    const result = await service.createDecision(
      { case_id: 'case_1', type: 'manual_validation_confirmed', rationale: 'verified manually' },
      'usr_reviewer',
    );

    // Decision was still persisted (audit trail preserved).
    expect(lastWrittenDecision.value?.type).toBe('manual_validation_confirmed');
    expect(result.decision.type).toBe('manual_validation_confirmed');
    // Transition error is surfaced on the result.
    expect(result.transition_error).toBeDefined();
    expect(result.transition_error?.code).toBe('TRANSITION_FAILED');
    expect(result.transition_error?.message).toMatch(/preconditions not met/i);
    expect(failingTransition).toHaveBeenCalled();
  });

  it('folds unmet precondition reasons into the transition_error message', async () => {
    // The bare "Invalid transition from X to Y" tells the user nothing about
    // how to unblock the case. A TransitionError carries the failed
    // preconditions; toTransitionError must surface their `reason` strings so
    // the courtroom toast / MCP caller sees the concrete blocker(s).
    const case_ = makeCase({
      status: 'verification_pending',
      validation_track: 'manual',
      owner_user_id: 'usr_other',
    });
    const caseRepo = { getById: vi.fn(async () => case_) } as never;
    const eventService = { emit: vi.fn(async () => ({})) } as never;
    const failingTransition = vi.fn(async () => {
      throw new TransitionError('verification_pending', 'approved', [
        { id: 'four_eyes_if_required', reason: 'Four-eyes required per evidence policy: need 2 distinct approvers, found 1' },
        { id: 'all_high_critical_resolved', reason: '2 unresolved high/critical findings' },
      ]);
    });
    const orchestrationService = { transition: failingTransition } as never;
    const evaluator = makeEvaluator(false);
    const service = new DecisionService(caseRepo, eventService, orchestrationService, evaluator as never);

    const result = await service.createDecision(
      { case_id: 'case_1', type: 'manual_validation_confirmed', rationale: 'verified manually' },
      'usr_reviewer',
    );

    expect(result.transition_error?.code).toBe('INVALID_CASE_TRANSITION');
    expect(result.transition_error?.message).toContain('Unmet preconditions:');
    expect(result.transition_error?.message).toContain('need 2 distinct approvers, found 1');
    expect(result.transition_error?.message).toContain('2 unresolved high/critical findings');
  });

  it('does not include transition_error on successful transition', async () => {
    const { service } = makeService(
      makeCase({ status: 'verification_pending', validation_track: 'manual', owner_user_id: 'usr_other' }),
    );
    const result = await service.createDecision(
      { case_id: 'case_1', type: 'manual_validation_confirmed', rationale: 'verified manually' },
      'usr_reviewer',
    );
    expect(result.transition_error).toBeUndefined();
  });

  it('auto-attaches manual_validation_confirmed BEFORE approve on manual-track cases', async () => {
    // Product call: for manual-track cases, "Approve" implies "Confirm Manual
    // Validation" + "Approve". Backend creates the validation decision first,
    // then proceeds with the approve so the transition's
    // `auto_approve_criteria_met` precondition is satisfied.
    const { service, eventService, orchestrationService } = makeService(
      makeCase({
        status: 'verification_pending',
        validation_track: 'manual',
        risk_level: 'medium',
        owner_user_id: 'usr_other',
      }),
    );
    const result = await service.createDecision(
      { case_id: 'case_1', type: 'approve', rationale: 'looks good to me, ready' },
      'usr_reviewer',
    );

    // Two decisions persisted, validation FIRST.
    expect(writtenDecisions.value).toHaveLength(2);
    expect(writtenDecisions.value[0].type).toBe('manual_validation_confirmed');
    expect(writtenDecisions.value[0].actor_id).toBe('usr_reviewer');
    expect(writtenDecisions.value[0].rationale).toMatch(/auto-attached/i);
    expect(writtenDecisions.value[1].type).toBe('approve');
    expect(writtenDecisions.value[1].actor_id).toBe('usr_reviewer');

    // Both `decision_created` events emitted.
    const emittedTypes = eventService.emit.mock.calls.map(
      (call: unknown[]) => (call[2] as { type: string }).type,
    );
    expect(emittedTypes).toContain('manual_validation_confirmed');
    expect(emittedTypes).toContain('approve');

    // Approve is what is returned to the caller (the user-facing decision).
    expect(result.decision.type).toBe('approve');
    // Transition was attempted.
    expect(orchestrationService.transition).toHaveBeenCalledWith(
      'case_1', 'approved', 'usr_reviewer',
    );
  });

  it('auto-attaches manual_validation_confirmed and transitions in_review manual-track approvals', async () => {
    // Regression: a case had both decisions persisted but stayed
    // in_review because approve did not resolve to an in_review -> approved
    // transition target.
    const { service, orchestrationService } = makeService(
      makeCase({
        status: 'in_review',
        validation_track: 'manual',
        risk_level: 'low',
        owner_user_id: 'usr_owner',
        review_not_applicable: true,
      }),
      { allowSelfApproval: true },
    );

    const result = await service.createDecision(
      { case_id: 'case_1', type: 'approve', rationale: 'manual verification complete' },
      'usr_owner',
    );

    expect(writtenDecisions.value).toHaveLength(2);
    expect(writtenDecisions.value[0].type).toBe('manual_validation_confirmed');
    expect(writtenDecisions.value[1].type).toBe('approve');
    expect(result.decision.type).toBe('approve');
    expect(orchestrationService.transition).toHaveBeenCalledWith(
      'case_1', 'approved', 'usr_owner',
    );
  });

  it('does not auto-attach when manual_validation_confirmed already exists on the case', async () => {
    // Idempotent: a prior validation decision (older flow or partial run)
    // means we must NOT double-create.
    decisionsQueryDocs.value = [
      {
        data: () => ({
          decision_id: 'decision_existing',
          case_id: 'case_1',
          type: 'manual_validation_confirmed',
          actor_id: 'usr_other',
          rationale: 'previously confirmed',
          snapshot: {},
          created_at: '2026-01-01T00:00:00Z',
        }),
      },
    ];
    const { service } = makeService(
      makeCase({
        status: 'in_review',
        validation_track: 'manual',
        risk_level: 'medium',
        owner_user_id: 'usr_other',
      }),
    );
    await service.createDecision(
      { case_id: 'case_1', type: 'approve', rationale: 'looks good to me, ready' },
      'usr_reviewer',
    );
    // Only one new decision written: the approve. No auto-attach.
    expect(writtenDecisions.value).toHaveLength(1);
    expect(writtenDecisions.value[0].type).toBe('approve');
  });

  it('AUTO-ATTACHES a fresh manual_validation_confirmed when the existing one is from a prior iteration (verification_pending re-entry)', async () => {
    // Regression for case-young-dome-2_fx: user clicked Approve at in_review,
    // auto-attach fired, case advanced to verification_pending. User clicked
    // Approve again from the verification_pending courtroom view. With the
    // old global-idempotency check the second auto-attach was SKIPPED and the
    // verification_pending precondition stayed unsatisfied, leaving the case
    // stuck. The fix: idempotency is scoped to the current iteration, so a
    // manual_validation_confirmed filed before entry to verification_pending
    // does NOT count, and a fresh one is auto-attached.
    decisionsQueryDocs.value = [
      {
        data: () => ({
          decision_id: 'decision_stale_validation',
          case_id: 'case_1',
          type: 'manual_validation_confirmed',
          actor_id: 'usr_reviewer',
          rationale: 'auto-attached at in_review (prior iteration)',
          snapshot: {},
          created_at: '2026-04-30T14:29:07Z',
        }),
      },
      {
        data: () => ({
          decision_id: 'decision_stale_approve',
          case_id: 'case_1',
          type: 'approve',
          actor_id: 'usr_reviewer',
          rationale: 'first approve at in_review',
          snapshot: {},
          created_at: '2026-04-30T14:29:07Z',
        }),
      },
    ];
    eventsQueryDocs.value = [
      {
        data: () => ({
          event_id: 'evt_advance_to_verification_pending',
          case_id: 'case_1',
          type: 'manual_verification_requested',
          actor_id: 'system',
          payload: { from_status: 'in_review', to_status: 'verification_pending' },
          created_at: '2026-04-30T14:29:09Z',
        }),
      },
    ];
    const { service, orchestrationService } = makeService(
      makeCase({
        status: 'verification_pending',
        validation_track: 'manual',
        risk_level: 'medium',
        owner_user_id: 'usr_other',
      }),
    );
    await service.createDecision(
      { case_id: 'case_1', type: 'approve', rationale: 'confirmed manual validation' },
      'usr_reviewer',
    );
    // Two NEW decisions written: a fresh manual_validation_confirmed, then approve.
    expect(writtenDecisions.value).toHaveLength(2);
    expect(writtenDecisions.value[0].type).toBe('manual_validation_confirmed');
    expect(writtenDecisions.value[1].type).toBe('approve');
    expect(orchestrationService.transition).toHaveBeenCalledWith(
      'case_1', 'approved', 'usr_reviewer',
    );
  });

  it('does NOT auto-attach a duplicate when the existing manual_validation_confirmed is in the current iteration (post-boundary)', async () => {
    // Idempotency still applies once we are inside the current iteration.
    // Boundary fired at T0; validation decision filed at T1 (after T0).
    // A second approve at T2 must not produce a third manual_validation_confirmed.
    decisionsQueryDocs.value = [
      {
        data: () => ({
          decision_id: 'decision_current_validation',
          case_id: 'case_1',
          type: 'manual_validation_confirmed',
          actor_id: 'usr_reviewer',
          rationale: 'auto-attached after entry',
          snapshot: {},
          created_at: '2026-04-30T14:30:00Z', // after boundary
        }),
      },
    ];
    eventsQueryDocs.value = [
      {
        data: () => ({
          event_id: 'evt_enter_verification_pending',
          case_id: 'case_1',
          type: 'manual_verification_requested',
          actor_id: 'system',
          payload: { from_status: 'in_review', to_status: 'verification_pending' },
          created_at: '2026-04-30T14:29:00Z',
        }),
      },
    ];
    const { service } = makeService(
      makeCase({
        status: 'verification_pending',
        validation_track: 'manual',
        risk_level: 'medium',
        owner_user_id: 'usr_other',
      }),
    );
    await service.createDecision(
      { case_id: 'case_1', type: 'approve', rationale: 'second approve same iteration' },
      'usr_reviewer',
    );
    // Only the approve was written; no fresh validation decision.
    expect(writtenDecisions.value).toHaveLength(1);
    expect(writtenDecisions.value[0].type).toBe('approve');
  });

  it('does not auto-attach on direct-track cases', async () => {
    const { service } = makeService(
      makeCase({
        status: 'in_review',
        validation_track: 'direct',
        risk_level: 'medium',
        owner_user_id: 'usr_other',
      }),
    );
    await service.createDecision(
      { case_id: 'case_1', type: 'approve', rationale: 'looks good to me, ready' },
      'usr_reviewer',
    );
    expect(writtenDecisions.value).toHaveLength(1);
    expect(writtenDecisions.value[0].type).toBe('approve');
  });

  it('still allows direct API calls with type=manual_validation_confirmed', async () => {
    // The auto-attach is approve-only sugar. Direct callers (MCP, scripts)
    // creating a manual_validation_confirmed decision must keep working.
    const { service } = makeService(
      makeCase({ status: 'verification_pending', validation_track: 'manual', owner_user_id: 'usr_other' }),
    );
    const result = await service.createDecision(
      { case_id: 'case_1', type: 'manual_validation_confirmed', rationale: 'verified manually' },
      'usr_reviewer',
    );
    expect(writtenDecisions.value).toHaveLength(1);
    expect(writtenDecisions.value[0].type).toBe('manual_validation_confirmed');
    expect(result.decision.type).toBe('manual_validation_confirmed');
  });

  it('resolves allow_self_approval via the completeness evaluator (DIRECT/medium cell)', async () => {
    // Proves the decision service consults the resolver for each case — if the
    // lookup ever regressed to a hardcoded default, this test catches it.
    const { service, evaluator } = makeService(
      makeCase({ status: 'in_review', risk_level: 'medium', validation_track: 'direct' }),
      { allowSelfApproval: true },
    );
    await service.createDecision(
      { case_id: 'case_1', type: 'approve', rationale: 'ok' },
      'usr_owner',
    );
    expect(evaluator.getEffectivePolicy).toHaveBeenCalledTimes(1);
    const arg = evaluator.getEffectivePolicy.mock.calls[0][0];
    expect(arg.validation_track).toBe('direct');
    expect(arg.risk_level).toBe('medium');
  });

  it('records effective rule-set versions and the resolved evidence-policy identity', async () => {
    const globalOverridden = makeRule({
      rule_id: 'rule_global_overridden',
      name: 'same-rule',
    });
    const projectOverride = makeRule({
      rule_id: 'rule_project_override',
      name: 'same-rule',
      scope: { layer: 'project', ref: 'p1' },
    });
    const globalEffective = makeRule({
      rule_id: 'rule_global_effective',
      name: 'global-only',
    });
    const { service, ruleRepository } = makeService(
      makeCase({
        status: 'in_review',
        validation_track: 'direct',
        owner_user_id: 'usr_other',
        active_rule_set_refs: [],
        knowledge_context_refs: ['knowledge_1'],
      }),
      {
        evidencePolicyId: 'policy_governance',
        evidencePolicyVersion: 7,
        effectiveRules: [globalOverridden, projectOverride, globalEffective],
        ruleSets: [
          makeRuleSet({
            rule_set_id: 'ruleset_project',
            project_id: 'p1',
            rule_refs: ['rule_project_override'],
            version: 3,
          }),
          makeRuleSet({
            rule_set_id: 'ruleset_global',
            rule_refs: ['rule_global_effective'],
            version: 11,
          }),
          makeRuleSet({
            rule_set_id: 'ruleset_overridden_only',
            rule_refs: ['rule_global_overridden'],
            version: 5,
          }),
        ],
      },
    );

    const result = await service.createDecision(
      { case_id: 'case_1', type: 'approve', rationale: 'all governance checks passed' },
      'usr_reviewer',
    );

    expect(result.decision.snapshot).toEqual({
      active_rule_set_versions: {
        ruleset_project: 3,
        ruleset_global: 11,
      },
      evidence_policy_id: 'policy_governance',
      evidence_policy_version: 7,
      knowledge_asset_refs: ['knowledge_1'],
      snapshot_fidelity: 'exact',
    });
    expect(ruleRepository.getActiveRulesForProject).toHaveBeenCalledWith('p1');
  });
});

describe('DecisionService.createDecision — terminal case guard (issue #752)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastWrittenDecision.value = null;
    writtenDecisions.value = [];
    findingDocState.exists = false;
    findingDocState.data = {};
    findingDocState.lastUpdate = null;
  });

  it.each(['done', 'rejected'] as const)(
    'rejects a client-submitted decision when the case status is %s',
    async (status) => {
      // A finding is attached so we can prove the guard fires BEFORE the
      // finding-status side effect (`approve` -> `resolved`) runs.
      findingDocState.exists = true;
      findingDocState.data = { finding_id: 'fnd_terminal', case_id: 'case_1', status: 'open' };
      const { service } = makeService(makeCase({ status }));

      await expect(
        service.createDecision(
          {
            case_id: 'case_1',
            type: 'approve',
            finding_id: 'fnd_terminal',
            rationale: 'attempting to approve a case that already closed',
          },
          'usr_reviewer',
        ),
      ).rejects.toMatchObject({
        code: 'TERMINAL_CASE_BLOCKS_DECISION',
        statusCode: 409,
      });

      // No decision persisted, and the referenced finding's status/fields
      // were never touched — the guard must fail BEFORE any write.
      expect(lastWrittenDecision.value).toBeNull();
      expect(findingDocState.lastUpdate).toBeNull();
    },
  );
});

describe('DecisionService.createDecision — human_confirmation gate resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastWrittenDecision.value = null;
    writtenDecisions.value = [];
    decisionsQueryDocs.value = [];
    eventsQueryDocs.value = [];
    onRunCompletedCalls.value = [];
    projectDocState.exists = false;
    projectDocState.data = {};
    ruleResultsStore.value = {};
    ruleResultUpdateCalls.value = [];
    poisonResultId.value = null;
  });

  it('gate_confirmed flips exactly the matching blocked human_confirmation result to pass; unrelated results untouched', async () => {
    projectDocState.exists = true;
    projectDocState.data = { reviewer_pool: ['usr_reviewer'] };

    const blocked = makeRuleResult({ rule_result_id: 'rr_blocked', result_status: 'blocked' });
    const alreadyPassed = makeRuleResult({ rule_result_id: 'rr_passed', result_status: 'pass' });
    ruleResultsStore.value = { rr_blocked: blocked, rr_passed: alreadyPassed };

    const { service, eventService } = makeService(
      makeCase({ status: 'in_review', owner_user_id: 'usr_owner' }),
      {
        ruleById: makeHumanConfirmationRule(),
        ruleResultsByCaseAndRule: [blocked, alreadyPassed],
      },
    );

    const input: CreateDecisionInput = {
      case_id: 'case_1',
      type: 'gate_confirmed',
      rule_id: 'rule_gate',
      rationale: 'Deployment window confirmed by ops',
    };
    await service.createDecision(input, 'usr_reviewer');

    // Only the blocked result is flipped — the already-`pass` result for the
    // same rule is left alone.
    expect(ruleResultUpdateCalls.value).toHaveLength(1);
    expect(ruleResultUpdateCalls.value[0]?.resultId).toBe('rr_blocked');
    expect(ruleResultUpdateCalls.value[0]?.patch['result_status']).toBe('pass');
    expect(ruleResultsStore.value['rr_blocked']?.result_status).toBe('pass');
    expect(ruleResultsStore.value['rr_passed']?.result_status).toBe('pass'); // unchanged, was already pass

    // The Decision documenting the flip landed in the same commit.
    expect(lastWrittenDecision.value?.type).toBe('gate_confirmed');
    expect(lastWrittenDecision.value?.rule_id).toBe('rule_gate');

    expect(eventService.emit).toHaveBeenCalledWith(
      'case_1',
      'gate_confirmed',
      expect.objectContaining({
        gate_kind: 'human_confirmation_rule',
        rule_id: 'rule_gate',
        rule_result_ids: ['rr_blocked'],
      }),
      'usr_reviewer',
    );
  });

  it('gate_rejected leaves the rule result blocked and records the rejection reason', async () => {
    projectDocState.exists = true;
    projectDocState.data = { reviewer_pool: ['usr_reviewer'] };

    const blocked = makeRuleResult({ rule_result_id: 'rr_blocked', result_status: 'blocked' });
    ruleResultsStore.value = { rr_blocked: blocked };

    const { service, eventService } = makeService(
      makeCase({ status: 'in_review', owner_user_id: 'usr_owner' }),
      {
        ruleById: makeHumanConfirmationRule(),
        ruleResultsByCaseAndRule: [blocked],
      },
    );

    const input: CreateDecisionInput = {
      case_id: 'case_1',
      type: 'gate_rejected',
      rule_id: 'rule_gate',
      rationale: 'Deployment window is closed — reject',
    };
    await service.createDecision(input, 'usr_reviewer');

    // The result stays blocked — `result_status` is never part of the patch —
    // only the message records the rejection reason.
    expect(ruleResultUpdateCalls.value).toHaveLength(1);
    expect(ruleResultUpdateCalls.value[0]?.resultId).toBe('rr_blocked');
    expect(ruleResultUpdateCalls.value[0]?.patch['result_status']).toBeUndefined();
    expect(ruleResultUpdateCalls.value[0]?.patch['message']).toMatch(/Deployment window is closed/);
    expect(ruleResultsStore.value['rr_blocked']?.result_status).toBe('blocked');

    expect(eventService.emit).toHaveBeenCalledWith(
      'case_1',
      'gate_rejected',
      expect.objectContaining({
        gate_kind: 'human_confirmation_rule',
        rule_id: 'rule_gate',
        rule_result_ids: ['rr_blocked'],
        rejected: true,
      }),
      'usr_reviewer',
    );
  });

  it('chains the pipeline (onRunCompleted) after gate_confirmed so preconditions get re-evaluated', async () => {
    projectDocState.exists = true;
    projectDocState.data = { reviewer_pool: ['usr_reviewer'] };
    // Ground truth the in-transaction re-read checks (issue #738
    // TOCTOU fix) — must agree with `ruleResultsByCaseAndRule` below.
    ruleResultsStore.value = { rr_test: makeRuleResult() };

    const { service } = makeService(
      makeCase({ status: 'in_review', owner_user_id: 'usr_owner' }),
      {
        ruleById: makeHumanConfirmationRule(),
        ruleResultsByCaseAndRule: [makeRuleResult()],
      },
    );

    await service.createDecision(
      { case_id: 'case_1', type: 'gate_confirmed', rule_id: 'rule_gate', rationale: 'confirmed' },
      'usr_reviewer',
    );

    expect(onRunCompletedCalls.value).toContain('case_1');
  });

  it('does not chain the pipeline on gate_rejected (rule stays blocked, nothing to re-evaluate)', async () => {
    projectDocState.exists = true;
    projectDocState.data = { reviewer_pool: ['usr_reviewer'] };
    // Ground truth the in-transaction re-read checks (issue #738
    // TOCTOU fix) — must agree with `ruleResultsByCaseAndRule` below.
    ruleResultsStore.value = { rr_test: makeRuleResult() };

    const { service } = makeService(
      makeCase({ status: 'in_review', owner_user_id: 'usr_owner' }),
      {
        ruleById: makeHumanConfirmationRule(),
        ruleResultsByCaseAndRule: [makeRuleResult()],
      },
    );

    await service.createDecision(
      { case_id: 'case_1', type: 'gate_rejected', rule_id: 'rule_gate', rationale: 'rejected' },
      'usr_reviewer',
    );

    expect(onRunCompletedCalls.value).not.toContain('case_1');
  });

  it('rejects a gate_confirmed rule_id that is not a human_confirmation rule', async () => {
    projectDocState.exists = true;
    projectDocState.data = { reviewer_pool: ['usr_reviewer'] };

    const { service } = makeService(
      makeCase({ status: 'in_review', owner_user_id: 'usr_owner' }),
      {
        ruleById: makeHumanConfirmationRule({ evaluation_mode: 'metadata_check' }),
        ruleResultsByCaseAndRule: [makeRuleResult()],
      },
    );

    await expect(
      service.createDecision(
        { case_id: 'case_1', type: 'gate_confirmed', rule_id: 'rule_gate', rationale: 'confirmed' },
        'usr_reviewer',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_GATE_RULE' });
  });

  it('rejects gate_confirmed when no blocked result exists for the rule', async () => {
    projectDocState.exists = true;
    projectDocState.data = { reviewer_pool: ['usr_reviewer'] };

    const { service } = makeService(
      makeCase({ status: 'in_review', owner_user_id: 'usr_owner' }),
      {
        ruleById: makeHumanConfirmationRule(),
        ruleResultsByCaseAndRule: [makeRuleResult({ result_status: 'pass' })],
      },
    );

    await expect(
      service.createDecision(
        { case_id: 'case_1', type: 'gate_confirmed', rule_id: 'rule_gate', rationale: 'confirmed' },
        'usr_reviewer',
      ),
    ).rejects.toMatchObject({ code: 'NO_BLOCKED_RULE_RESULT' });
  });

  it('applies the same owner self-approval anti-gaming rule as the lifecycle gate path', async () => {
    const { service } = makeService(
      makeCase({ status: 'in_review', owner_user_id: 'usr_owner' }),
      {
        allowSelfApproval: false,
        ruleById: makeHumanConfirmationRule(),
        ruleResultsByCaseAndRule: [makeRuleResult()],
      },
    );

    await expect(
      service.createDecision(
        { case_id: 'case_1', type: 'gate_confirmed', rule_id: 'rule_gate', rationale: 'confirmed' },
        'usr_owner',
      ),
    ).rejects.toThrow(/anti-gaming/i);
  });

  describe('atomicity of the multi-result flip (issue #738)', () => {
    it('a transient failure flipping one blocked result leaves NEITHER result flipped and NO orphan Decision', async () => {
      projectDocState.exists = true;
      projectDocState.data = { reviewer_pool: ['usr_reviewer'] };

      // Two blocked results for the same rule — the flip must cover both.
      const blockedA = makeRuleResult({ rule_result_id: 'rr_a', result_status: 'blocked' });
      const blockedB = makeRuleResult({ rule_result_id: 'rr_b', result_status: 'blocked' });
      ruleResultsStore.value = { rr_a: blockedA, rr_b: blockedB };

      const { service } = makeService(
        makeCase({ status: 'in_review', owner_user_id: 'usr_owner' }),
        {
          ruleById: makeHumanConfirmationRule(),
          ruleResultsByCaseAndRule: [blockedA, blockedB],
        },
      );

      // Simulate "a transient Firestore error on result N of M" (issue #738):
      // the second blocked result's write fails.
      poisonResultId.value = 'rr_b';

      await expect(
        service.createDecision(
          { case_id: 'case_1', type: 'gate_confirmed', rule_id: 'rule_gate', rationale: 'confirmed' },
          'usr_reviewer',
        ),
      ).rejects.toThrow(/transient Firestore error/);

      // Atomicity: rr_a must NOT be left flipped just because it was ordered
      // before the failing rr_b — either both flip or neither does. Against
      // the pre-fix per-item loop (git-stash decision-service.ts to verify)
      // rr_a DOES flip here, and the Decision below IS written, because the
      // loop already committed rr_a and the generic decision-persist ran
      // before the loop even started.
      expect(ruleResultsStore.value['rr_a']?.result_status).toBe('blocked');
      expect(ruleResultsStore.value['rr_b']?.result_status).toBe('blocked');

      // No orphan Decision documenting a flip that didn't (fully) happen.
      expect(lastWrittenDecision.value).toBeNull();
    });
  });

  describe('concurrent gate resolution / TOCTOU (issue #738)', () => {
    it('aborts with no Decision and no duplicate flip when a concurrent call already resolved every blocked result', async () => {
      projectDocState.exists = true;
      projectDocState.data = { reviewer_pool: ['usr_reviewer'] };

      const blocked = makeRuleResult({ rule_result_id: 'rr_blocked', result_status: 'blocked' });
      // `ruleResultsByCaseAndRule` below is the STALE read (mirrors the
      // plain, non-transactional query `resolveHumanConfirmationGate` uses
      // to build its candidate list) — it still reports `blocked`.
      ruleResultsStore.value = { rr_blocked: blocked };

      const { service, eventService } = makeService(
        makeCase({ status: 'in_review', owner_user_id: 'usr_owner' }),
        {
          ruleById: makeHumanConfirmationRule(),
          ruleResultsByCaseAndRule: [blocked],
        },
      );

      // Simulate a concurrent winner: by the time THIS call's transaction
      // runs, another `gate_confirmed` call has already committed its own
      // transaction flipping the same RuleResult to `pass`.
      ruleResultsStore.value['rr_blocked'] = {
        ...blocked,
        result_status: 'pass',
        message: 'Confirmed by usr_other: already resolved',
      };

      await expect(
        service.createDecision(
          { case_id: 'case_1', type: 'gate_confirmed', rule_id: 'rule_gate', rationale: 'confirmed' },
          'usr_reviewer',
        ),
      ).rejects.toThrow(/No blocked human_confirmation rule result/);

      // Pre-fix (blind `tx.update` by id, no `tx.get` re-check inside the
      // transaction — git-stash decision-service.ts to verify): this call
      // would silently overwrite the winner's message and commit a SECOND
      // Decision plus a duplicate `gate_confirmed` event for a gate someone
      // else already resolved — the "duplicate audit rows" from issue #738.
      expect(ruleResultsStore.value['rr_blocked']?.message).toBe(
        'Confirmed by usr_other: already resolved',
      );
      expect(lastWrittenDecision.value).toBeNull();
      expect(eventService.emit).not.toHaveBeenCalledWith(
        'case_1',
        'gate_confirmed',
        expect.anything(),
        expect.anything(),
      );
    });

    it('flips only the results still blocked when some — but not all — were already resolved concurrently', async () => {
      projectDocState.exists = true;
      projectDocState.data = { reviewer_pool: ['usr_reviewer'] };

      const blockedA = makeRuleResult({ rule_result_id: 'rr_a', result_status: 'blocked' });
      const blockedB = makeRuleResult({ rule_result_id: 'rr_b', result_status: 'blocked' });
      ruleResultsStore.value = { rr_a: blockedA, rr_b: blockedB };

      const { service } = makeService(
        makeCase({ status: 'in_review', owner_user_id: 'usr_owner' }),
        {
          ruleById: makeHumanConfirmationRule(),
          ruleResultsByCaseAndRule: [blockedA, blockedB],
        },
      );

      // rr_a already resolved by a concurrent winner; rr_b is still genuinely
      // blocked.
      ruleResultsStore.value['rr_a'] = {
        ...blockedA,
        result_status: 'pass',
        message: 'Confirmed by usr_other: already resolved',
      };

      await service.createDecision(
        { case_id: 'case_1', type: 'gate_confirmed', rule_id: 'rule_gate', rationale: 'confirmed' },
        'usr_reviewer',
      );

      // rr_a's concurrent resolution is left untouched...
      expect(ruleResultsStore.value['rr_a']?.message).toBe(
        'Confirmed by usr_other: already resolved',
      );
      // ...while rr_b is still flipped by this call.
      expect(ruleResultsStore.value['rr_b']?.result_status).toBe('pass');
      expect(ruleResultsStore.value['rr_b']?.message).toMatch(/^Confirmed by usr_reviewer:/);
      expect(lastWrittenDecision.value?.type).toBe('gate_confirmed');
    });
  });
});

describe('DecisionService.createDecision — actor_metadata persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastWrittenDecision.value = null;
    writtenDecisions.value = [];
    decisionsQueryDocs.value = [];
    eventsQueryDocs.value = [];
  });

  it('persists user-supplied actor_metadata on a direct-track decision', async () => {
    const { service, eventService } = makeService(
      makeCase({ status: 'in_review', validation_track: 'direct', owner_user_id: 'usr_other' }),
    );
    const input: CreateDecisionInput = {
      case_id: 'case_1',
      type: 'approve',
      rationale: 'all green',
      actor_metadata: {
        client_name: 'cursor',
        client_version: '0.42.1',
        model: 'claude-opus-4-7',
      },
    };
    const result = await service.createDecision(input, 'usr_reviewer');
    expect(result.decision.actor_metadata).toEqual({
      client_name: 'cursor',
      client_version: '0.42.1',
      model: 'claude-opus-4-7',
    });
    expect(writtenDecisions.value).toHaveLength(1);
    expect(writtenDecisions.value[0].actor_metadata?.client_name).toBe('cursor');
    // Timeline parity: the decision_created event payload must mirror the
    // decision document so the case Timeline tab (which renders from raw
    // CaseEvent.payload) shows the same IDE-client badge as the courtroom +
    // activity feed. See follow-up #93 / PR #496.
    const decisionCreated = eventService.emit.mock.calls.find(
      (c: [unknown, string, Record<string, unknown>, unknown]) => c[1] === 'decision_created',
    );
    expect(decisionCreated).toBeDefined();
    expect(decisionCreated![2].actor_metadata).toEqual({
      client_name: 'cursor',
      client_version: '0.42.1',
      model: 'claude-opus-4-7',
    });
  });

  it('inherits actor_metadata onto the auto-attached manual_validation_confirmed', async () => {
    // The user clicked one button — both audit rows should carry the same
    // client signature so the courtroom doesn't show "Cursor approved" but
    // "human confirmed validation".
    const { service, eventService } = makeService(
      makeCase({
        status: 'verification_pending',
        validation_track: 'manual',
        risk_level: 'medium',
        owner_user_id: 'usr_other',
      }),
    );
    await service.createDecision(
      {
        case_id: 'case_1',
        type: 'approve',
        rationale: 'manual track approve via MCP',
        actor_metadata: { client_name: 'claude-code', model: 'claude-opus-4-7' },
      },
      'usr_reviewer',
    );

    expect(writtenDecisions.value).toHaveLength(2);
    expect(writtenDecisions.value[0].type).toBe('manual_validation_confirmed');
    expect(writtenDecisions.value[0].actor_metadata).toEqual({
      client_name: 'claude-code',
      model: 'claude-opus-4-7',
    });
    expect(writtenDecisions.value[1].type).toBe('approve');
    expect(writtenDecisions.value[1].actor_metadata).toEqual({
      client_name: 'claude-code',
      model: 'claude-opus-4-7',
    });
    // Both decision_created events must carry the same actor_metadata so the
    // case timeline shows the IDE-client badge on both rows of the
    // auto-attached pair (manual_validation_confirmed + approve).
    const decisionCreatedCalls = eventService.emit.mock.calls.filter(
      (c: [unknown, string, Record<string, unknown>, unknown]) => c[1] === 'decision_created',
    );
    expect(decisionCreatedCalls).toHaveLength(2);
    expect(decisionCreatedCalls[0][2].actor_metadata).toEqual({
      client_name: 'claude-code',
      model: 'claude-opus-4-7',
    });
    expect(decisionCreatedCalls[1][2].actor_metadata).toEqual({
      client_name: 'claude-code',
      model: 'claude-opus-4-7',
    });
  });

  it('omits actor_metadata when not supplied (back-compat for existing callers)', async () => {
    const { service, eventService } = makeService(
      makeCase({ status: 'in_review', validation_track: 'direct', owner_user_id: 'usr_other' }),
    );
    const result = await service.createDecision(
      { case_id: 'case_1', type: 'approve', rationale: 'ok' },
      'usr_reviewer',
    );
    expect(result.decision.actor_metadata).toBeUndefined();
    expect(writtenDecisions.value[0].actor_metadata).toBeUndefined();
    // The persisted document must not carry an explicit `undefined` either —
    // matches the conditional-spread pattern used for `self_approved` / agent_name.
    expect('actor_metadata' in writtenDecisions.value[0]).toBe(false);
    // Same conditional-spread guarantee on the emitted event payload: when no
    // actor_metadata was supplied, the key must not appear at all (so old
    // events stay clean and timeline rendering falls through to human/system).
    const decisionCreated = eventService.emit.mock.calls.find(
      (c: [unknown, string, Record<string, unknown>, unknown]) => c[1] === 'decision_created',
    );
    expect(decisionCreated).toBeDefined();
    expect('actor_metadata' in decisionCreated![2]).toBe(false);
  });
});

describe('DecisionService.createDecision — pipeline chain after transition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastWrittenDecision.value = null;
    writtenDecisions.value = [];
    decisionsQueryDocs.value = [];
    eventsQueryDocs.value = [];
    onRunCompletedCalls.value = [];
  });

  it('chains RunCompletionHandler.onRunCompleted exactly once with the case_id when a decision triggers a transition', async () => {
    // Regression: a manual-track approve that lands a case in `approved` used to
    // stall there even though the lifecycle preset has
    // `approved_to_pending_merge: 'auto'`. The fix chains the pipeline after a
    // successful transition so further auto-transitions fire in the same request.
    const { service, orchestrationService } = makeService(
      makeCase({
        status: 'verification_pending',
        validation_track: 'manual',
        risk_level: 'medium',
        owner_user_id: 'usr_other',
      }),
    );
    await service.createDecision(
      { case_id: 'case_1', type: 'manual_validation_confirmed', rationale: 'verified manually' },
      'usr_reviewer',
    );
    // Precondition: the transition actually fired (didTransition === true).
    expect(orchestrationService.transition).toHaveBeenCalledWith(
      'case_1', 'approved', 'usr_reviewer',
    );
    // The chain ran exactly once, scoped to this case.
    expect(onRunCompletedCalls.value).toEqual(['case_1']);
  });

  it('does NOT chain onRunCompleted when no transition happens', async () => {
    // Negative case: a finding-level `waive` on an in_review case maps to no
    // transition target, so didTransition stays false and the pipeline chain
    // must not fire. (Mirrors the existing "does not transition on unrelated
    // finding-level decision types" assertion.)
    const { service, orchestrationService } = makeService(
      makeCase({ status: 'in_review', owner_user_id: 'usr_other' }),
    );
    await service.createDecision(
      { case_id: 'case_1', finding_id: 'fnd_x', type: 'waive', rationale: 'not applicable' },
      'usr_reviewer',
    );
    expect(orchestrationService.transition).not.toHaveBeenCalled();
    expect(onRunCompletedCalls.value).toEqual([]);
  });

  it('does NOT chain onRunCompleted when a request_changes decision transitions the case to in_build', async () => {
    // Mirrors the /transition route's in_build carve-out: a request_changes on an
    // in_review case resolves to an in_build transition (see resolveTransitionTarget),
    // after which the agent is about to implement code, commit, push, and create a
    // PR. The pipeline must NOT advance until the agent posts a build_run.
    const { service, orchestrationService } = makeService(
      makeCase({ status: 'in_review', owner_user_id: 'usr_other' }),
    );
    await service.createDecision(
      { case_id: 'case_1', type: 'request_changes', rationale: 'please fix' },
      'usr_reviewer',
    );
    // Precondition: the transition to in_build actually fired.
    expect(orchestrationService.transition).toHaveBeenCalledWith(
      'case_1', 'in_build', 'usr_reviewer',
    );
    // But the pipeline chain was skipped because the target was in_build.
    expect(onRunCompletedCalls.value).toEqual([]);
  });

  it('does NOT chain onRunCompleted when the transition is attempted but blocked by preconditions', async () => {
    // didTransition only flips true on a SUCCESSFUL transition. When
    // orchestrationService.transition throws (preconditions not met), the
    // decision is still persisted but the pipeline chain must NOT run.
    const case_ = makeCase({
      status: 'verification_pending',
      validation_track: 'manual',
      owner_user_id: 'usr_other',
    });
    const caseRepo = { getById: vi.fn(async () => case_) } as never;
    const eventService = { emit: vi.fn(async () => ({})) } as never;
    const orchestrationService = {
      transition: vi.fn(async () => {
        throw new Error('preconditions not met: review_run_completed');
      }),
    } as never;
    const evaluator = makeEvaluator(false);
    const service = new DecisionService(caseRepo, eventService, orchestrationService, evaluator as never);

    const result = await service.createDecision(
      { case_id: 'case_1', type: 'manual_validation_confirmed', rationale: 'verified manually' },
      'usr_reviewer',
    );
    // Decision persisted, transition error surfaced, but no chain.
    expect(result.decision.type).toBe('manual_validation_confirmed');
    expect(result.transition_error).toBeDefined();
    expect(onRunCompletedCalls.value).toEqual([]);
  });
});

describe('DecisionService.createDecision — propose_waiver + finding resolution metadata (arbitra-mcp#34)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastWrittenDecision.value = null;
    writtenDecisions.value = [];
    findingsQueryDocs.value = [];
    decisionsQueryDocs.value = [];
    eventsQueryDocs.value = [];
    findingDocState.exists = true;
    findingDocState.data = {
      finding_id: 'fnd_x',
      case_id: 'case_1',
      severity: 'high',
      status: 'open',
    };
    findingDocState.lastUpdate = null;
    onRunCompletedCalls.value = [];
  });

  it('propose_waiver sets finding status to the non-terminal waiver_proposed', async () => {
    const { service } = makeService(
      makeCase({ status: 'needs_human_decision', owner_user_id: 'usr_other' }),
    );
    await service.createDecision(
      {
        case_id: 'case_1',
        finding_id: 'fnd_x',
        type: 'propose_waiver',
        rationale: 'false positive — hallucinated platform API signature',
      },
      'usr_agent',
    );
    expect(findingDocState.lastUpdate).toMatchObject({ status: 'waiver_proposed' });
  });

  it('propose_waiver writes resolution, severity_contested, and knowledge_asset_ref onto the finding', async () => {
    const { service } = makeService(
      makeCase({ status: 'needs_human_decision', owner_user_id: 'usr_other' }),
    );
    await service.createDecision(
      {
        case_id: 'case_1',
        finding_id: 'fnd_x',
        type: 'propose_waiver',
        rationale: 'verified against production usage',
        resolution: 'false positive — API verified against the vendor API',
        severity_contested: true,
        knowledge_asset_ref: 'know_precedent_test',
      },
      'usr_agent',
    );
    expect(findingDocState.lastUpdate).toMatchObject({
      status: 'waiver_proposed',
      resolution: 'false positive — API verified against the vendor API',
      severity_contested: true,
      knowledge_asset_ref: 'know_precedent_test',
    });
  });

  it('propose_waiver does NOT auto-advance the case out of needs_human_decision', async () => {
    // Human-in-the-loop: a proposed waiver leaves the finding still-blocking,
    // so the service must not even attempt the needs_human_decision → approved
    // transition for a propose_waiver decision.
    const { service, orchestrationService } = makeService(
      makeCase({ status: 'needs_human_decision', owner_user_id: 'usr_other' }),
    );
    await service.createDecision(
      {
        case_id: 'case_1',
        finding_id: 'fnd_x',
        type: 'propose_waiver',
        rationale: 'proposing waiver',
      },
      'usr_agent',
    );
    expect(orchestrationService.transition).not.toHaveBeenCalled();
    expect(onRunCompletedCalls.value).toEqual([]);
  });

  it('a human waive still resolves the finding to waived and can carry resolution text', async () => {
    // Confirms the terminal path is unchanged: a reviewer waive maps to the
    // resolved `waived` status (not waiver_proposed) and still records resolution.
    const { service } = makeService(
      makeCase({ status: 'in_review', owner_user_id: 'usr_other' }),
    );
    await service.createDecision(
      {
        case_id: 'case_1',
        finding_id: 'fnd_x',
        type: 'waive',
        rationale: 'confirmed the agent proposal',
        resolution: 'confirmed false positive',
      },
      'usr_reviewer',
    );
    expect(findingDocState.lastUpdate).toMatchObject({
      status: 'waived',
      resolution: 'confirmed false positive',
    });
  });
});
