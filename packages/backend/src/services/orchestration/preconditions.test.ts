import { describe, it, expect, vi } from 'vitest';
import { createPreconditionEvaluator, type PreconditionContext } from './preconditions.js';
import type { Case, Decision, CaseEvent, DecisionSnapshot, Run, Finding, RuleResult, Evidence } from '@arbitra/shared';

// preconditions.ts pulls in CompletenessEvaluator → Firestore. The narrow mock below
// only stubs the evidencePolicies collection because the fixtures in this file don't
// trigger any other Firestore calls. If a future test exercises a precondition that
// reads other collections, extend this mock.
// The resolver uses a single deterministic chain: where('project_id','==',...).get().
vi.mock('../../lib/firestore.js', () => {
  const whereNode = { get: vi.fn().mockResolvedValue({ empty: true, docs: [] }) };
  return {
    collections: {
      evidencePolicies: () => ({
        where: () => whereNode,
      }),
    },
  };
});

const snapshot: DecisionSnapshot = {
  active_rule_set_versions: {},
  evidence_policy_version: 1,
  knowledge_asset_refs: [],
};

// Default commit both `makeCase()` and a default `makeRun(..., 'review_run')`
// carry (issue #1054): every pre-existing test in this file constructs a
// case and a review_run independently via these two helpers and neither
// mentioned commit identity before this field existed, so they must agree
// by default or every one of them would need an explicit override just to
// keep testing what it always tested. Tests that care about a MISMATCH
// override one side explicitly (see the "commit binding" describe block
// below).
const DEFAULT_HEAD_SHA = 'sha_default_head';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Test',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'p1',
    repository_id: 'r1',
    owner_user_id: 'usr_owner',
    status: 'in_review',
    validation_track: 'manual',
    risk_level: 'high',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    current_head_sha: DEFAULT_HEAD_SHA,
    ...overrides,
  };
}

function makeDecision(
  actorId: string,
  createdAt: string,
  type: Decision['type'] = 'approve',
): Decision {
  return {
    decision_id: `dec_${actorId}_${createdAt}_${type}`,
    case_id: 'case_1',
    type,
    actor_id: actorId,
    rationale: 'looks good',
    snapshot,
    created_at: createdAt,
  };
}

function makeRun(createdAt: string, type: Run['run_type'] = 'review_run', overrides: Partial<Run> = {}): Run {
  return {
    run_id: `run_${createdAt}_${type}`,
    case_id: 'case_1',
    run_type: type,
    trigger_source: 'system',
    status: 'completed',
    input_refs: [],
    output_refs: [],
    created_at: createdAt,
    updated_at: createdAt,
    // Matches `makeCase()`'s default `current_head_sha` so every existing
    // review_run fixture in this file satisfies the commit-match gate
    // exactly as it did before that gate existed (issue #1054). Only
    // `review_run` gets a default here — the field is meaningless for other
    // run types and stamping it there would be misleading.
    ...(type === 'review_run' ? { reviewed_head_sha: DEFAULT_HEAD_SHA } : {}),
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: `find_${Math.random().toString(36).slice(2)}`,
    case_id: 'case_1',
    category: 'bug',
    severity: 'high',
    confidence: 0.9,
    status: 'open',
    title: 'Test finding',
    description: 'desc',
    origin_type: 'reviewer',
    source_refs: [],
    evidence_refs: [],
    rule_refs: [],
    created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function makeRuleResult(overrides: Partial<RuleResult> = {}): RuleResult {
  return {
    rule_result_id: `rr_${Math.random().toString(36).slice(2)}`,
    rule_id: 'rule_gate',
    case_id: 'case_1',
    run_id: 'run_1',
    result_status: 'blocked',
    message: 'Human confirmation required',
    evidence_refs: [],
    evaluated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function makeChangesRequestedEvent(createdAt: string): CaseEvent {
  return {
    event_id: `evt_${createdAt}`,
    case_id: 'case_1',
    type: 'changes_requested',
    payload: {},
    actor_id: 'usr_pm',
    created_at: createdAt,
  };
}

function makeManualVerificationRequestedEvent(createdAt: string): CaseEvent {
  return {
    event_id: `evt_mvr_${createdAt}`,
    case_id: 'case_1',
    type: 'manual_verification_requested',
    payload: { from_status: 'in_review', to_status: 'verification_pending' },
    actor_id: 'system',
    created_at: createdAt,
  };
}

function makeContext(overrides: Partial<PreconditionContext>): PreconditionContext {
  return {
    case_: makeCase(),
    runs: [],
    findings: [],
    ruleResults: [],
    evidence: [],
    decisions: [],
    events: [],
    actorId: 'usr_test',
    ...overrides,
  };
}

describe('preconditions.four_eyes_if_required', () => {
  it('is satisfied for low risk regardless of decisions', async () => {
    const ctx = makeContext({
      case_: makeCase({ risk_level: 'low' }),
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('four_eyes_if_required');
    expect(result.satisfied).toBe(true);
  });

  it('is satisfied for high risk with two distinct non-owner approvers', async () => {
    const ctx = makeContext({
      decisions: [
        makeDecision('usr_reviewer1', '2026-01-02T00:00:00Z'),
        makeDecision('usr_reviewer2', '2026-01-02T00:01:00Z'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('four_eyes_if_required');
    expect(result.satisfied).toBe(true);
  });

  it('does NOT count stale approvals from before a request_changes loopback (BUG-1)', async () => {
    // Scenario: case was approved twice (T0, T1), PM requested changes (T2),
    // owner pushed a fix and one new approver signed off (T3).
    // Without loopback filtering, the two stale approvals from T0/T1 would
    // still satisfy four-eyes, bypassing the requirement that the post-loopback
    // iteration must independently get two distinct approvers.
    const ctx = makeContext({
      decisions: [
        makeDecision('usr_reviewer1', '2026-01-01T10:00:00Z'), // stale
        makeDecision('usr_reviewer2', '2026-01-01T11:00:00Z'), // stale
        makeDecision('usr_reviewer1', '2026-01-02T10:00:00Z'), // current iteration: only 1
      ],
      events: [
        makeChangesRequestedEvent('2026-01-02T00:00:00Z'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('four_eyes_if_required');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/distinct approvers/i);
  });

  it('is satisfied after a loopback when two new distinct approvers sign off', async () => {
    const ctx = makeContext({
      decisions: [
        makeDecision('usr_reviewer1', '2026-01-01T10:00:00Z'), // stale, ignored
        makeDecision('usr_reviewer1', '2026-01-02T10:00:00Z'), // current
        makeDecision('usr_reviewer2', '2026-01-02T11:00:00Z'), // current
      ],
      events: [
        makeChangesRequestedEvent('2026-01-02T00:00:00Z'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('four_eyes_if_required');
    expect(result.satisfied).toBe(true);
  });

  it('still counts approves filed BEFORE manual_verification_requested (cross-phase four-eyes)', async () => {
    // Regression guard for PR #487: phase-scoped attestation boundary must
    // NOT bleed into four-eyes counting. Reviewer A approves at
    // needs_human_decision; case auto-advances to verification_pending; reviewer
    // B approves there. Both should count toward four-eyes — the phase boundary
    // is only meaningful for `manual_validation_confirmed`, not for distinct-
    // approver counting.
    const ctx = makeContext({
      decisions: [
        makeDecision('usr_reviewer1', '2026-04-30T10:00:00Z'), // pre-phase entry
        makeDecision('usr_reviewer2', '2026-04-30T12:00:00Z'), // post-phase entry
      ],
      events: [
        makeManualVerificationRequestedEvent('2026-04-30T11:00:00Z'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('four_eyes_if_required');
    expect(result.satisfied).toBe(true);
  });
});

describe('preconditions.four_eyes_if_required — multiple loopbacks (#209)', () => {
  // `loopbackScopedDecisions` picks the LATEST `changes_requested` event via
  // `reduce` and counts only decisions strictly after it. With two loopbacks
  // interleaved with approvals, only decisions after the SECOND (most recent)
  // loopback may satisfy four-eyes.

  it('counts only decisions after the MOST RECENT of two loopbacks (one distinct approver → not satisfied)', async () => {
    // Timeline:
    //   T0  approve  reviewer1   (iteration 1)
    //   L1  changes_requested
    //   T1  approve  reviewer1   (iteration 2)
    //   T2  approve  reviewer2   (iteration 2 — would be 2 distinct here)
    //   L2  changes_requested    (most recent loopback / boundary)
    //   T3  approve  reviewer1   (iteration 3 — ONLY this one counts)
    // After L2 there is a single distinct approver, so four-eyes must fail —
    // even though iteration 2 had two distinct approvers, those are now stale.
    const ctx = makeContext({
      decisions: [
        makeDecision('usr_reviewer1', '2026-01-01T10:00:00Z'), // iter 1, stale
        makeDecision('usr_reviewer1', '2026-01-02T10:00:00Z'), // iter 2, stale
        makeDecision('usr_reviewer2', '2026-01-02T11:00:00Z'), // iter 2, stale
        makeDecision('usr_reviewer1', '2026-01-03T10:00:00Z'), // iter 3, current — only this counts
      ],
      events: [
        makeChangesRequestedEvent('2026-01-02T00:00:00Z'), // L1
        makeChangesRequestedEvent('2026-01-03T00:00:00Z'), // L2 (most recent boundary)
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('four_eyes_if_required');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/distinct approvers/i);
  });

  it('is satisfied when two distinct approvers sign off AFTER the most recent of two loopbacks', async () => {
    const ctx = makeContext({
      decisions: [
        makeDecision('usr_reviewer1', '2026-01-01T10:00:00Z'), // iter 1, stale
        makeDecision('usr_reviewer2', '2026-01-02T11:00:00Z'), // iter 2, stale
        makeDecision('usr_reviewer1', '2026-01-03T10:00:00Z'), // iter 3, current
        makeDecision('usr_reviewer2', '2026-01-03T11:00:00Z'), // iter 3, current — 2 distinct
      ],
      events: [
        makeChangesRequestedEvent('2026-01-02T00:00:00Z'), // L1
        makeChangesRequestedEvent('2026-01-03T00:00:00Z'), // L2 (most recent boundary)
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('four_eyes_if_required');
    expect(result.satisfied).toBe(true);
  });

  it('ignores loopback ordering in the events array — reduce picks by created_at, not position', async () => {
    // Same scenario as the "not satisfied" case above, but the two
    // changes_requested events are provided out of chronological order to
    // prove the `reduce` selects the latest by `created_at`, not by array
    // index. Boundary is still L2 (2026-01-03), so only the single iter-3
    // approver counts.
    const ctx = makeContext({
      decisions: [
        makeDecision('usr_reviewer1', '2026-01-02T10:00:00Z'), // iter 2, stale
        makeDecision('usr_reviewer2', '2026-01-02T11:00:00Z'), // iter 2, stale
        makeDecision('usr_reviewer1', '2026-01-03T10:00:00Z'), // iter 3, current — only this counts
      ],
      events: [
        makeChangesRequestedEvent('2026-01-03T00:00:00Z'), // L2 listed FIRST
        makeChangesRequestedEvent('2026-01-02T00:00:00Z'), // L1 listed SECOND
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('four_eyes_if_required');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/distinct approvers/i);
  });
});

describe('preconditions.four_eyes_if_required — boundary timestamp (#209)', () => {
  // `loopbackScopedDecisions` filters with strict `>` (preconditions.ts):
  //   ctx.decisions.filter((d) => d.created_at > latest.created_at)
  // A decision whose `created_at` exactly equals the loopback's `created_at`
  // is therefore EXCLUDED from the new iteration. This guards the intent:
  // a decision filed at the same instant as (or before) the loopback is
  // considered part of the OLD iteration and must not count.

  const LOOPBACK_AT = '2026-01-02T00:00:00Z';

  it('does NOT count a decision whose timestamp exactly equals the loopback (strict >)', async () => {
    // Two distinct approvers, but BOTH are at-or-before the boundary:
    //   reviewer1 strictly before the loopback (stale),
    //   reviewer2 exactly AT the loopback (excluded by strict >).
    // Net current-iteration approvers = 0 → four-eyes must fail.
    const ctx = makeContext({
      decisions: [
        makeDecision('usr_reviewer1', '2026-01-01T23:59:59Z'), // before boundary, stale
        makeDecision('usr_reviewer2', LOOPBACK_AT),            // == boundary, excluded
      ],
      events: [
        makeChangesRequestedEvent(LOOPBACK_AT),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('four_eyes_if_required');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/distinct approvers/i);
  });

  it('counts a decision one tick AFTER the loopback but excludes the equal-timestamp one', async () => {
    // reviewer1 exactly AT the loopback (excluded), reviewer2 one second after
    // (counted). Only ONE distinct approver survives the boundary → still fails,
    // proving the equal-timestamp decision did not silently make up the second
    // approver.
    const ctx = makeContext({
      decisions: [
        makeDecision('usr_reviewer1', LOOPBACK_AT),            // == boundary, excluded
        makeDecision('usr_reviewer2', '2026-01-02T00:00:01Z'), // strictly after, counted
      ],
      events: [
        makeChangesRequestedEvent(LOOPBACK_AT),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('four_eyes_if_required');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/distinct approvers/i);
  });
});

describe('preconditions.four_eyes_if_required — manual_validation_confirmed + approve mix (#209)', () => {
  // `checkFourEyes` accepts BOTH `approve` and `manual_validation_confirmed` as
  // approver-producing decisions (four-eyes-checker.ts). The precondition
  // wrapper is exercised today only with `approve`; these tests cover the mixed
  // path so a regression that drops `manual_validation_confirmed` from the
  // approver set would be caught.

  it('is satisfied when one approve + one manual_validation_confirmed come from two distinct non-owner actors', async () => {
    const ctx = makeContext({
      decisions: [
        makeDecision('usr_reviewer1', '2026-01-02T10:00:00Z', 'approve'),
        makeDecision('usr_reviewer2', '2026-01-02T10:05:00Z', 'manual_validation_confirmed'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('four_eyes_if_required');
    expect(result.satisfied).toBe(true);
  });

  it('is NOT satisfied when both decisions (approve + manual_validation_confirmed) come from the SAME actor', async () => {
    // Same actor filing both an approve and a manual-validation attestation is
    // still a single distinct approver — four-eyes must not be fooled into
    // counting the two decision types as two people.
    const ctx = makeContext({
      decisions: [
        makeDecision('usr_reviewer1', '2026-01-02T10:00:00Z', 'approve'),
        makeDecision('usr_reviewer1', '2026-01-02T10:05:00Z', 'manual_validation_confirmed'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('four_eyes_if_required');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/distinct approvers/i);
  });

  it('rejects two manual_validation_confirmed approvers when both are the case owner (allow_self_approval=false)', async () => {
    // Default high-risk policy is four_eyes_required + allow_self_approval=false.
    // A lone owner attestation, even repeated as a different decision type, must
    // not satisfy the non-owner requirement. Here the owner files one approve and
    // one manual_validation_confirmed, plus a single distinct non-owner is still
    // absent → fails on the distinct-count check (only one unique approver).
    const ctx = makeContext({
      decisions: [
        makeDecision('usr_owner', '2026-01-02T10:00:00Z', 'approve'),
        makeDecision('usr_owner', '2026-01-02T10:05:00Z', 'manual_validation_confirmed'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('four_eyes_if_required');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/distinct approvers/i);
  });

  it('is satisfied with owner (manual_validation_confirmed) + one distinct non-owner (approve) — positive control', async () => {
    // Positive control anchoring the negatives above: the owner's attestation
    // DOES count as one of the two distinct approvers, and the non-owner
    // reviewer satisfies the allow_self_approval=false requirement that at least
    // one approver differ from the owner. Mixed decision types both contribute.
    const ctx = makeContext({
      decisions: [
        makeDecision('usr_owner', '2026-01-02T10:00:00Z', 'manual_validation_confirmed'),
        makeDecision('usr_reviewer1', '2026-01-02T10:05:00Z', 'approve'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('four_eyes_if_required');
    // 2 distinct approvers (owner + reviewer1) AND at least one non-owner → satisfied.
    expect(result.satisfied).toBe(true);
  });
});

describe('preconditions.auto_approve_criteria_met (manual track loopback)', () => {
  it('does NOT count stale manual_validation_confirmed from before a loopback', async () => {
    // Manual track case auto-approved once via verification_pending, then PM
    // requested changes. A new review_run completes; without loopback filtering
    // the stale manual_validation_confirmed would still satisfy auto-approve.
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'manual', risk_level: 'low' }),
      runs: [
        makeRun('2026-01-02T09:00:00Z', 'review_run'), // current iteration review
      ],
      decisions: [
        makeDecision('usr_validator', '2026-01-01T10:00:00Z', 'manual_validation_confirmed'), // stale
      ],
      events: [
        makeChangesRequestedEvent('2026-01-02T00:00:00Z'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/manual validation/i);
  });

  it('is satisfied when manual_validation_confirmed is in the current iteration', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'manual', risk_level: 'low' }),
      runs: [
        makeRun('2026-01-02T09:00:00Z', 'review_run'),
      ],
      decisions: [
        makeDecision('usr_validator', '2026-01-01T10:00:00Z', 'manual_validation_confirmed'), // stale
        makeDecision('usr_validator', '2026-01-02T10:00:00Z', 'manual_validation_confirmed'), // current
      ],
      events: [
        makeChangesRequestedEvent('2026-01-02T00:00:00Z'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(true);
  });
});

describe('preconditions.manual_validation_confirmed (verification_pending boundary)', () => {
  it('does NOT count a manual_validation_confirmed filed BEFORE entry to verification_pending', async () => {
    // Regression for case-young-dome-2_fx: validation decision was filed
    // at in_review; case advanced to verification_pending; the gate must
    // reject the stale validation since the user could not have intended
    // it as the verification_pending attestation.
    const ctx = makeContext({
      case_: makeCase({ status: 'verification_pending', validation_track: 'manual', risk_level: 'low' }),
      decisions: [
        makeDecision('usr_reviewer', '2026-04-30T14:29:07Z', 'manual_validation_confirmed'),
      ],
      events: [
        makeManualVerificationRequestedEvent('2026-04-30T14:29:09Z'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('manual_validation_confirmed');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/manual validation/i);
  });

  it('IS satisfied when manual_validation_confirmed is filed AFTER entry to verification_pending', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'verification_pending', validation_track: 'manual', risk_level: 'low' }),
      decisions: [
        makeDecision('usr_reviewer', '2026-04-30T14:29:07Z', 'manual_validation_confirmed'), // stale
        makeDecision('usr_reviewer', '2026-04-30T14:29:11Z', 'manual_validation_confirmed'), // current
      ],
      events: [
        makeManualVerificationRequestedEvent('2026-04-30T14:29:09Z'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('manual_validation_confirmed');
    expect(result.satisfied).toBe(true);
  });

  it('uses the most recent boundary when both changes_requested and verification_pending entry have fired', async () => {
    // case enters verification_pending (T1), changes are requested back to in_build (T2),
    // case re-enters verification_pending (T3). Only validations after T3 count.
    const ctx = makeContext({
      case_: makeCase({ status: 'verification_pending', validation_track: 'manual', risk_level: 'low' }),
      decisions: [
        makeDecision('usr_v', '2026-04-30T11:00:00Z', 'manual_validation_confirmed'), // before T1, stale
        makeDecision('usr_v', '2026-04-30T11:30:00Z', 'manual_validation_confirmed'), // after T1 but before changes_requested, stale
        makeDecision('usr_v', '2026-04-30T13:30:00Z', 'manual_validation_confirmed'), // after changes_requested but before re-entry, stale
      ],
      events: [
        makeManualVerificationRequestedEvent('2026-04-30T11:15:00Z'), // T1
        makeChangesRequestedEvent('2026-04-30T12:00:00Z'),             // T2
        makeManualVerificationRequestedEvent('2026-04-30T14:00:00Z'),  // T3 (most recent boundary)
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('manual_validation_confirmed');
    expect(result.satisfied).toBe(false);
  });
});

describe('preconditions.human_review_documented_manual_pending (loopback)', () => {
  it('does NOT count stale review decisions from before a loopback', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'manual', risk_level: 'high' }),
      decisions: [
        makeDecision('usr_reviewer1', '2026-01-01T10:00:00Z', 'approve'), // stale
      ],
      events: [
        makeChangesRequestedEvent('2026-01-02T00:00:00Z'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('human_review_documented_manual_pending');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/no human review decision/i);
  });

  it('is satisfied with a current-iteration review decision', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'manual', risk_level: 'high' }),
      decisions: [
        makeDecision('usr_reviewer1', '2026-01-01T10:00:00Z', 'approve'), // stale
        makeDecision('usr_reviewer2', '2026-01-02T10:00:00Z', 'approve'), // current
      ],
      events: [
        makeChangesRequestedEvent('2026-01-02T00:00:00Z'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('human_review_documented_manual_pending');
    expect(result.satisfied).toBe(true);
  });
});

describe('preconditions.human_review_documented_manual_pending (high/critical gate)', () => {
  // Manual-track cases could reach `approved` with
  // open high/critical findings via needs_human_decision -> verification_pending
  // -> approved, because this precondition only checked that SOME review
  // decision existed (any `approve`/`request_changes`), never finding severity.
  // A finding-level `approve` on an unrelated finding was enough to open the
  // detour. These tests pin the fix: an open author-blocking high/critical
  // finding blocks this precondition regardless of what decisions exist.

  it('is NOT satisfied when an open author-blocking high/critical finding exists, even with a documented review decision', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'manual', risk_level: 'high' }),
      findings: [makeFinding({ severity: 'high', status: 'open' })],
      decisions: [
        makeDecision('usr_reviewer1', '2026-01-02T10:00:00Z', 'approve'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('human_review_documented_manual_pending');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/open high\/critical findings/i);
  });

  it('is NOT satisfied when a finding-level approve exists for an UNRELATED finding while another high/critical finding stays open', async () => {
    // Exploit scenario: create_decision(approve, finding_id=<any>)
    // then transition_case(verification_pending) — the finding-level approve
    // must not stand in for resolving the (different) open high/critical finding.
    const blockingFinding = makeFinding({
      finding_id: 'find_blocking',
      severity: 'critical',
      status: 'open',
    });
    const unrelatedFinding = makeFinding({
      finding_id: 'find_unrelated',
      severity: 'low',
      status: 'open',
    });
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'manual', risk_level: 'critical' }),
      findings: [blockingFinding, unrelatedFinding],
      decisions: [
        {
          decision_id: 'dec_finding_approve',
          case_id: 'case_1',
          type: 'approve',
          finding_id: 'find_unrelated',
          actor_id: 'usr_reviewer1',
          rationale: 'this specific finding is fine',
          snapshot,
          created_at: '2026-01-02T10:00:00Z',
        },
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('human_review_documented_manual_pending');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/open high\/critical findings/i);
  });

  it('IS satisfied once the high/critical finding is resolved (fixed) and a review decision is documented', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'manual', risk_level: 'high' }),
      findings: [makeFinding({ severity: 'high', status: 'fixed' })],
      decisions: [
        makeDecision('usr_reviewer1', '2026-01-02T10:00:00Z', 'approve'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('human_review_documented_manual_pending');
    expect(result.satisfied).toBe(true);
  });

  it('IS satisfied when the only high/critical finding is submodule-origin (not author-blocking)', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'manual', risk_level: 'high' }),
      findings: [makeFinding({ severity: 'critical', status: 'open', origin: 'submodule' })],
      decisions: [
        makeDecision('usr_reviewer1', '2026-01-02T10:00:00Z', 'approve'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('human_review_documented_manual_pending');
    expect(result.satisfied).toBe(true);
  });
});

describe('preconditions.all_steps_completed (loopback)', () => {
  it('does NOT count a stale approve decision from before a loopback', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'approved' }),
      decisions: [
        makeDecision('usr_reviewer', '2026-01-01T10:00:00Z', 'approve'), // stale
      ],
      events: [
        makeChangesRequestedEvent('2026-01-02T00:00:00Z'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('all_steps_completed');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/no approval decision/i);
  });

  it('is satisfied by a manual_validation_confirmed decision alone (manual track)', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'approved', validation_track: 'manual' }),
      decisions: [
        makeDecision('usr_reviewer', '2026-01-02T10:00:00Z', 'manual_validation_confirmed'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('all_steps_completed');
    expect(result.satisfied).toBe(true);
  });
});

describe('preconditions.auto_approve_criteria_met (risk gate)', () => {
  it('rejects high risk cases even when all other criteria are met', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'high' }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
      findings: [],
      ruleResults: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/high\/critical/i);
  });

  it('rejects critical risk cases even when all other criteria are met', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'critical' }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
      findings: [],
      ruleResults: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/high\/critical/i);
  });

  it('still allows low risk auto-approval (regression check)', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'low' }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
      findings: [],
      ruleResults: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(true);
  });

  it('still rejects a high-risk case escalated from Observed (issue #987 regression)', async () => {
    // Escalation flips `case_type` away from 'observed' but never bypasses
    // the risk gate — this precondition only ever reads `risk_level`, so an
    // escalated case must be blocked exactly like a manually created
    // high-risk case. Reverting the risk check in `auto_approve_criteria_met`
    // (or scoping it to skip non-'observed'-origin cases) would let this
    // pass.
    const ctx = makeContext({
      case_: makeCase({
        validation_track: 'direct',
        risk_level: 'high',
        case_type: 'bugfix', // post-escalation case_type (was 'observed')
      }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
      findings: [],
      ruleResults: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/high\/critical/i);
  });
});

describe('preconditions.auto_approve_criteria_met (human_confirmation gate deadlock)', () => {
  it('is NOT satisfied while a human_confirmation RuleResult is blocked', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'low' }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
      findings: [],
      ruleResults: [makeRuleResult({ result_status: 'blocked' })],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/rule results not passing/i);
  });

  it('is satisfied once the gate_confirmed resolution flips the RuleResult to pass', async () => {
    // Mirrors what DecisionService.resolveHumanConfirmationGate does to the
    // RuleResult on gate_confirmed (see decision-service.ts) — same case,
    // same rule, only the terminal status differs.
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'low' }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
      findings: [],
      ruleResults: [makeRuleResult({ result_status: 'pass' })],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(true);
  });

  it('gate_rejected keeps the RuleResult blocked and the precondition stays unsatisfied', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'low' }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
      findings: [],
      ruleResults: [
        makeRuleResult({ result_status: 'blocked', message: 'Rejected by usr_reviewer: not ready' }),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(false);
  });
});

describe('preconditions.review_run_completed (review_not_applicable bypass)', () => {
  it('is NOT satisfied without a review_run when review_not_applicable is unset', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'in_review' }),
      runs: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/review/i);
  });

  it('is satisfied without a review_run when review_not_applicable=true', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'in_review', review_not_applicable: true }),
      runs: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(true);
  });
});

describe('preconditions.auto_approve_criteria_met (review_not_applicable bypass)', () => {
  it('is satisfied for low-risk direct track without review_run when review_not_applicable=true', async () => {
    const ctx = makeContext({
      case_: makeCase({
        validation_track: 'direct',
        risk_level: 'low',
        review_not_applicable: true,
      }),
      runs: [],
      findings: [],
      ruleResults: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(true);
    // Surface the bypass as the final reason so telemetry / phase rendering
    // can distinguish true-because-bypassed from true-because-all-criteria-met.
    expect(result.reason).toBe('review_not_applicable');
  });

  it('returns no reason when satisfied through a real review_run (not bypassed)', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'low' }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
      findings: [],
      ruleResults: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  // Regression for #632: a stale `review_not_applicable`
  // flag must NOT win over a real completed current-iteration review_run. When
  // both coexist, satisfaction comes from the real review, so the reason must
  // be the normal-approval reason — NOT the bypass reason.
  it('does NOT tag review_not_applicable when a completed review_run also exists (stale-flag race)', async () => {
    const ctx = makeContext({
      case_: makeCase({
        validation_track: 'direct',
        risk_level: 'low',
        review_not_applicable: true,
      }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
      findings: [],
      ruleResults: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(true);
    expect(result.reason).not.toBe('review_not_applicable');
    expect(result.reason).toBeUndefined();
  });

  it('still rejects high-risk cases even when review_not_applicable=true (risk gate wins)', async () => {
    const ctx = makeContext({
      case_: makeCase({
        validation_track: 'direct',
        risk_level: 'high',
        review_not_applicable: true,
      }),
      runs: [],
      findings: [],
      ruleResults: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/high\/critical/i);
  });
});

// ---------------------------------------------------------------------------
// Commit binding (issue #1054)
// ---------------------------------------------------------------------------
//
// A completed review_run used to satisfy both gates purely by existing
// within the current iteration (since the last changes_requested), with no
// check on WHICH commit it reviewed. That let a trivial commit get a
// genuine, clean review, followed by the real change being pushed before
// approval — the review still counted. `reviewRunCoversCurrentHead` closes
// this by requiring the completed run's `reviewed_head_sha` to equal
// `Case.current_head_sha`.
//
// This block tests the PR-BEARING case (`current_pr_ref` set on every fixture
// below): issue #1054 gap 1 found the ORIGINAL fail-closed choice here was justified only for a case
// that has a PR — a PR is the only thing a GitHub commit status is ever
// published against, so only there does "blocking costs nothing, the case
// could never reach a green check anyway" hold. The security property this
// block proves — a PR-bearing case must still fail closed on a missing/
// mismatched head — MUST NOT be weakened; see the separate "no PR reference"
// describe blocks below for the class this fix widens instead.

describe('preconditions.review_run_completed — commit binding (issue #1054)', () => {
  it('is NOT satisfied when the only completed review reviewed a DIFFERENT commit than current_head_sha', async () => {
    const ctx = makeContext({
      case_: makeCase({ current_pr_ref: 'https://github.com/acme/demo/pull/42', current_head_sha: 'sha_real_change' }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run', { reviewed_head_sha: 'sha_trivial_commit' })],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/does not cover the current commit/i);
  });

  it('IS satisfied when the completed review reviewed the SAME commit as current_head_sha', async () => {
    const ctx = makeContext({
      case_: makeCase({ current_pr_ref: 'https://github.com/acme/demo/pull/42', current_head_sha: 'sha_match' }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run', { reviewed_head_sha: 'sha_match' })],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(true);
  });

  it('is NOT satisfied when case_.current_head_sha is undefined, even if the review run carries a commit (fail-closed, PR-bearing case)', async () => {
    const ctx = makeContext({
      case_: makeCase({ current_pr_ref: 'https://github.com/acme/demo/pull/42', current_head_sha: undefined }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run', { reviewed_head_sha: 'sha_whatever' })],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(false);
  });

  it('is NOT satisfied when the completed review run carries no reviewed_head_sha at all (legacy pre-#1054 run, fail-closed)', async () => {
    const ctx = makeContext({
      case_: makeCase({ current_pr_ref: 'https://github.com/acme/demo/pull/42', current_head_sha: 'sha_current' }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run', { reviewed_head_sha: undefined })],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(false);
    // A `completed` review_run DOES exist (just an unstamped legacy one), so
    // this is the "stale review" branch, not the "no review at all" one —
    // it must not report the no-review message or fall through to the
    // no-diff auto-heal.
    expect(result.reason).toMatch(/does not cover the current commit/i);
  });

  it('does NOT fall through to the no-diff auto-heal when a completed-but-stale review exists (mismatch is not "no review ran")', async () => {
    const onAutoHeal = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      case_: makeCase({ current_pr_ref: 'https://github.com/acme/demo/pull/42', current_head_sha: 'sha_real_change' }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run', { reviewed_head_sha: 'sha_trivial_commit' })],
      events: [
        {
          event_id: 'evt_pipe',
          case_id: 'case_1',
          type: 'comment_added',
          payload: { comment_type: 'system', body: 'Auto-review could not start after 3 attempts: foo' },
          actor_id: 'system:pipeline',
          created_at: '2026-01-02T10:00:00Z',
        },
      ],
      onAutoHealReviewNotApplicable: onAutoHeal,
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(false);
    expect(onAutoHeal).not.toHaveBeenCalled();
  });
});

describe('preconditions.auto_approve_criteria_met — commit binding (issue #1054)', () => {
  it('is NOT satisfied when the only completed review reviewed a DIFFERENT commit than current_head_sha', async () => {
    const ctx = makeContext({
      case_: makeCase({ current_pr_ref: 'https://github.com/acme/demo/pull/42', validation_track: 'direct', risk_level: 'low', current_head_sha: 'sha_real_change' }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run', { reviewed_head_sha: 'sha_trivial_commit' })],
      findings: [],
      ruleResults: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/does not cover the current commit/i);
  });

  it('IS satisfied when the completed review reviewed the SAME commit as current_head_sha', async () => {
    const ctx = makeContext({
      case_: makeCase({ current_pr_ref: 'https://github.com/acme/demo/pull/42', validation_track: 'direct', risk_level: 'low', current_head_sha: 'sha_match' }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run', { reviewed_head_sha: 'sha_match' })],
      findings: [],
      ruleResults: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(true);
  });

  it('is NOT satisfied when case_.current_head_sha is undefined, even if the review run carries a commit (fail-closed, PR-bearing case)', async () => {
    const ctx = makeContext({
      case_: makeCase({ current_pr_ref: 'https://github.com/acme/demo/pull/42', validation_track: 'direct', risk_level: 'low', current_head_sha: undefined }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run', { reviewed_head_sha: 'sha_whatever' })],
      findings: [],
      ruleResults: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Commit binding — NO PR reference (issue #1054 gap 1)
// ---------------------------------------------------------------------------
//
// A case with no `current_pr_ref` never publishes a GitHub commit status
// (`publishCaseCommitStatus`, commit-status-service.ts, returns
// `{ published: false, reason: 'no_pr_ref' }`), so the "blocking costs
// nothing — the case could never reach a green check anyway" argument that
// justifies failing closed for a PR-bearing case (the describe blocks above)
// does not apply here. Combined with `review_not_applicable` refusing once
// ANY completed review run exists for the current iteration
// (`decision-service.ts`'s `REVIEW_NOT_APPLICABLE_RUN_EXISTS`), the
// PR-bearing fail-closed semantics would strand such a case in `in_review`
// permanently, with no self-service recovery. `completedReviewSatisfiesCommitBinding`
// falls back to the pre-#1054 "any completed review_run this iteration"
// semantics for this class instead.
describe('preconditions.review_run_completed — no PR reference (issue #1054 gap 1)', () => {
  it('IS satisfied by any completed review_run when the case has no current_pr_ref and no current_head_sha', async () => {
    // Revert line to make this fail: `completedReviewSatisfiesCommitBinding`'s
    // `if (!caseHasPrReference(case_)) return true;` removed (or the call
    // sites reverted to call `reviewRunCoversCurrentHead` directly).
    const ctx = makeContext({
      case_: makeCase({ current_pr_ref: undefined, current_head_sha: undefined }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run', { reviewed_head_sha: undefined })],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(true);
  });

  it('IS satisfied when the case has a branch (no PR) and the completed review reviewed a commit the case never observed', async () => {
    // The realistic path: DiffResolver's branch-compare strategy (issue
    // #1054) reviews a `current_branch`-only case with no PR ref at all;
    // `reviewed_head_sha` need not match `current_head_sha` (which may be
    // unset, or stale) for the no-PR fallback to apply.
    const ctx = makeContext({
      case_: makeCase({ current_pr_ref: undefined, current_branch: 'work/instance-config', current_head_sha: undefined }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run', { reviewed_head_sha: 'sha_from_branch_compare' })],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(true);
  });
});

describe('preconditions.auto_approve_criteria_met — no PR reference (issue #1054 gap 1)', () => {
  it('treats the review-run sub-clause as satisfied by any completed review_run when the case has no current_pr_ref and no current_head_sha', async () => {
    const ctx = makeContext({
      case_: makeCase({
        current_pr_ref: undefined,
        current_head_sha: undefined,
        validation_track: 'direct',
        risk_level: 'low',
      }),
      runs: [makeRun('2026-01-02T09:00:00Z', 'review_run', { reviewed_head_sha: undefined })],
      findings: [],
      ruleResults: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    // Not the `review_not_applicable` bypass reason — a real completed
    // review satisfies the sub-clause directly via the no-PR fallback.
    expect(result).toEqual({ satisfied: true });
  });
});

describe('preconditions.track_is_direct_and_high_critical_risk', () => {
  it('is satisfied for Direct Track high risk', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'high' }),
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('track_is_direct_and_high_critical_risk');
    expect(result.satisfied).toBe(true);
  });

  it('is satisfied for Direct Track critical risk', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'critical' }),
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('track_is_direct_and_high_critical_risk');
    expect(result.satisfied).toBe(true);
  });

  it('rejects Manual Track even at high risk', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'manual', risk_level: 'high' }),
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('track_is_direct_and_high_critical_risk');
    expect(result.satisfied).toBe(false);
  });

  it('rejects Direct Track low risk', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'low' }),
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('track_is_direct_and_high_critical_risk');
    expect(result.satisfied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// review_not_applicable auto-heal
// ---------------------------------------------------------------------------
//
// Regression coverage for cases that hit retry-exhaustion before PR #454
// shipped: they have a `system:pipeline` "Auto-review could not start" /
// "Auto-review skipped" comment but no `review_not_applicable` flag, so the
// `review_run_completed` precondition would block approval forever. The
// evaluator now detects the comment, treats the precondition as satisfied,
// and lazily persists the flag via an injected callback.

function makePipelineComment(body: string, createdAt = '2026-01-02T10:00:00Z'): CaseEvent {
  return {
    event_id: `evt_pipe_${createdAt}`,
    case_id: 'case_1',
    type: 'comment_added',
    payload: { comment_type: 'system', body },
    actor_id: 'system:pipeline',
    created_at: createdAt,
  };
}

describe('preconditions.review_run_completed auto-heal', () => {
  it('heals on "Auto-review could not start" pipeline comment and fires the persist callback', async () => {
    const onAutoHeal = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      case_: makeCase({ risk_level: 'low' }),
      events: [
        makePipelineComment(
          'Auto-review could not start after 3 attempts: Diff could not be fetched from GitHub (PR: none, branch: main)…',
        ),
      ],
      onAutoHealReviewNotApplicable: onAutoHeal,
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(true);
    expect(result.reason).toBe('review_not_applicable_auto_healed');
    expect(onAutoHeal).toHaveBeenCalledTimes(1);
    expect(onAutoHeal).toHaveBeenCalledWith('case_1');
  });

  it('heals on "Auto-review skipped: no PR or branch attached" pipeline comment', async () => {
    const onAutoHeal = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      case_: makeCase({ risk_level: 'low' }),
      events: [
        makePipelineComment(
          'Auto-review skipped: no PR or branch attached to this case. Attach a PR/branch or use a manual decision.',
        ),
      ],
      onAutoHealReviewNotApplicable: onAutoHeal,
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(true);
    expect(result.reason).toBe('review_not_applicable_auto_healed');
    expect(onAutoHeal).toHaveBeenCalledTimes(1);
  });

  it('does NOT heal on unrelated pipeline comments (e.g. "Run ID: …")', async () => {
    const onAutoHeal = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      events: [makePipelineComment('Run ID: run_abc completed in 4.2s')],
      onAutoHealReviewNotApplicable: onAutoHeal,
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(false);
    expect(onAutoHeal).not.toHaveBeenCalled();
  });

  it('does NOT heal when the matching comment is from a non-pipeline actor', async () => {
    const onAutoHeal = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      events: [
        {
          event_id: 'evt_user',
          case_id: 'case_1',
          type: 'comment_added',
          payload: {
            comment_type: 'user',
            body: 'Auto-review could not start after 3 attempts: Diff could not be fetched from GitHub',
          },
          actor_id: 'usr_someone',
          created_at: '2026-01-02T10:00:00Z',
        },
      ],
      onAutoHealReviewNotApplicable: onAutoHeal,
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(false);
    expect(onAutoHeal).not.toHaveBeenCalled();
  });

  it('flag-already-set short-circuit wins over auto-heal (returns "review_not_applicable", not auto_healed)', async () => {
    const onAutoHeal = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      case_: makeCase({ review_not_applicable: true }),
      events: [
        makePipelineComment('Auto-review could not start after 3 attempts: foo'),
      ],
      onAutoHealReviewNotApplicable: onAutoHeal,
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(true);
    expect(result.reason).toBe('review_not_applicable');
    expect(onAutoHeal).not.toHaveBeenCalled();
  });

  it('still satisfied via auto-heal even if the persist callback throws (fail-soft)', async () => {
    const onAutoHeal = vi.fn().mockRejectedValue(new Error('Firestore down'));
    const ctx = makeContext({
      case_: makeCase({ risk_level: 'low' }),
      events: [makePipelineComment('Auto-review could not start after 3 attempts: foo')],
      onAutoHealReviewNotApplicable: onAutoHeal,
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(true);
    expect(result.reason).toBe('review_not_applicable_auto_healed');
    expect(onAutoHeal).toHaveBeenCalledTimes(1);
  });

  it('heals without a callback wired (caller may opt out of side effects)', async () => {
    const ctx = makeContext({
      case_: makeCase({ risk_level: 'low' }),
      events: [makePipelineComment('Auto-review could not start after 3 attempts: foo')],
      // no onAutoHealReviewNotApplicable
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('review_run_completed');
    expect(result.satisfied).toBe(true);
    expect(result.reason).toBe('review_not_applicable_auto_healed');
  });
});

describe('preconditions.auto_approve_criteria_met auto-heal mirror', () => {
  it('heals the missing-review sub-clause via pipeline comment for low/medium risk', async () => {
    const onAutoHeal = vi.fn().mockResolvedValue(undefined);
    // Low risk, direct track, no review_run, no findings, no rule failures.
    // Without the heal this would fail on "No completed LLM review run".
    const ctx = makeContext({
      case_: makeCase({
        risk_level: 'low',
        validation_track: 'direct',
      }),
      events: [
        makePipelineComment('Auto-review could not start after 3 attempts: foo'),
      ],
      onAutoHealReviewNotApplicable: onAutoHeal,
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(true);
    expect(onAutoHeal).toHaveBeenCalledTimes(1);
  });

  it('does NOT heal high-risk gate (still blocks before review-run sub-clause)', async () => {
    const onAutoHeal = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      case_: makeCase({
        risk_level: 'high',
        validation_track: 'direct',
      }),
      events: [
        makePipelineComment('Auto-review could not start after 3 attempts: foo'),
      ],
      onAutoHealReviewNotApplicable: onAutoHeal,
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/high\/critical/i);
    expect(onAutoHeal).not.toHaveBeenCalled();
  });

  it('still blocks when no review_run AND no pipeline-failure comment exists', async () => {
    const ctx = makeContext({
      case_: makeCase({
        risk_level: 'low',
        validation_track: 'direct',
      }),
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/no completed llm review run/i);
  });
});

describe('preconditions.pr_closed_before_exploration', () => {
  function makePrClosedEvent(createdAt: string): CaseEvent {
    return {
      event_id: `evt_pr_closed_${createdAt}`,
      case_id: 'case_1',
      type: 'pr_closed',
      payload: {},
      actor_id: 'system',
      created_at: createdAt,
    };
  }

  function makeExplorationRequestedEvent(createdAt: string): CaseEvent {
    return {
      event_id: `evt_exploration_requested_${createdAt}`,
      case_id: 'case_1',
      type: 'exploration_requested',
      payload: {},
      actor_id: 'system',
      created_at: createdAt,
    };
  }

  it('is satisfied when case is open and a pr_closed event exists with no exploration', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'open' }),
      events: [makePrClosedEvent('2026-04-30T10:00:00Z')],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('pr_closed_before_exploration');
    expect(result.satisfied).toBe(true);
  });

  it('is NOT satisfied when case is past open status', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'in_build' }),
      events: [makePrClosedEvent('2026-04-30T10:00:00Z')],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('pr_closed_before_exploration');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/not in open/i);
  });

  it('is NOT satisfied when no pr_closed event exists', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'open' }),
      events: [],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('pr_closed_before_exploration');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/no pr_closed/i);
  });

  it('is NOT satisfied once exploration has been requested', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'open' }),
      events: [
        makeExplorationRequestedEvent('2026-04-30T09:00:00Z'),
        makePrClosedEvent('2026-04-30T10:00:00Z'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('pr_closed_before_exploration');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/exploration already started/i);
  });
});

// ---------------------------------------------------------------------------
// Finding-origin gate awareness (issue #633).
// Submodule/vendored-origin high/critical findings must NOT auto-block or
// auto-escalate. Authored findings must still gate exactly as before.
// ---------------------------------------------------------------------------
describe('preconditions: finding origin gate awareness (#633)', () => {
  describe('has_high_critical_findings (escalation trigger)', () => {
    it('does NOT escalate on submodule-only high/critical findings', async () => {
      const ctx = makeContext({
        findings: [
          makeFinding({ severity: 'critical', origin: 'submodule' }),
          makeFinding({ severity: 'high', origin: 'submodule' }),
        ],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('has_high_critical_findings');
      expect(result.satisfied).toBe(false); // no escalation
    });

    it('does NOT escalate on vendored-only high/critical findings', async () => {
      const ctx = makeContext({
        findings: [makeFinding({ severity: 'high', origin: 'vendored' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('has_high_critical_findings');
      expect(result.satisfied).toBe(false);
    });

    it('STILL escalates on an authored high/critical finding (regression guard)', async () => {
      const ctx = makeContext({
        findings: [makeFinding({ severity: 'high', origin: 'authored' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('has_high_critical_findings');
      expect(result.satisfied).toBe(true);
    });

    it('STILL escalates on a finding with no origin (back-compat = authored)', async () => {
      const ctx = makeContext({
        findings: [makeFinding({ severity: 'critical' })], // origin omitted
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('has_high_critical_findings');
      expect(result.satisfied).toBe(true);
    });

    it('escalates when mixed: authored finding present alongside submodule findings', async () => {
      const ctx = makeContext({
        findings: [
          makeFinding({ severity: 'high', origin: 'submodule' }),
          makeFinding({ severity: 'high', origin: 'authored' }),
        ],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('has_high_critical_findings');
      expect(result.satisfied).toBe(true);
    });
  });

  describe('auto_approve_criteria_met', () => {
    const lowRiskCase = () =>
      makeCase({ validation_track: 'direct', risk_level: 'low' });

    it('auto-approve NOT blocked by submodule-only high/critical findings', async () => {
      const ctx = makeContext({
        case_: lowRiskCase(),
        runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
        findings: [makeFinding({ severity: 'critical', origin: 'submodule' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('auto_approve_criteria_met');
      expect(result.satisfied).toBe(true);
    });

    it('auto-approve NOT blocked by vendored-only high/critical findings (#645)', async () => {
      const ctx = makeContext({
        case_: lowRiskCase(),
        runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
        findings: [makeFinding({ severity: 'critical', origin: 'vendored' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('auto_approve_criteria_met');
      expect(result.satisfied).toBe(true);
    });

    it('auto-approve STILL blocked by an authored high/critical finding (regression guard)', async () => {
      const ctx = makeContext({
        case_: lowRiskCase(),
        runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
        findings: [makeFinding({ severity: 'high', origin: 'authored' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('auto_approve_criteria_met');
      expect(result.satisfied).toBe(false);
      expect(result.reason).toMatch(/high\/critical/i);
    });

    it('auto-approve blocked when mixed (authored finding present)', async () => {
      const ctx = makeContext({
        case_: lowRiskCase(),
        runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
        findings: [
          makeFinding({ severity: 'high', origin: 'submodule' }),
          makeFinding({ severity: 'high', origin: 'authored' }),
        ],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('auto_approve_criteria_met');
      expect(result.satisfied).toBe(false);
      expect(result.reason).toMatch(/high\/critical/i);
    });

    // Rule-layer conflicts were detected then discarded — the
    // `rule_override_conflict` gate below was permanently vacuous (0
    // creation sites repo-wide). Now that `RuleService` persists the finding,
    // this branch is reachable for the first time.
    it('auto-approve blocked by an unconfirmed rule_override_conflict finding', async () => {
      const ctx = makeContext({
        case_: lowRiskCase(),
        runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
        findings: [makeFinding({
          category: 'rule_override_conflict',
          severity: 'low',
          status: 'open',
          rule_refs: ['rule_global_1', 'rule_project_1'],
        })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('auto_approve_criteria_met');
      expect(result.satisfied).toBe(false);
      expect(result.reason).toMatch(/override conflict/i);
    });

    it('auto-approve NOT blocked once the rule_override_conflict finding is resolved', async () => {
      const ctx = makeContext({
        case_: lowRiskCase(),
        runs: [makeRun('2026-01-02T09:00:00Z', 'review_run')],
        findings: [makeFinding({
          category: 'rule_override_conflict',
          severity: 'low',
          status: 'resolved',
          rule_refs: ['rule_global_1', 'rule_project_1'],
        })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('auto_approve_criteria_met');
      expect(result.satisfied).toBe(true);
    });
  });

  describe('all_high_critical_resolved (needs_human_decision → approved)', () => {
    it('is satisfied when only submodule high/critical findings are unresolved', async () => {
      const ctx = makeContext({
        findings: [makeFinding({ severity: 'critical', status: 'open', origin: 'submodule' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('all_high_critical_resolved');
      expect(result.satisfied).toBe(true);
    });

    it('is satisfied when only vendored high/critical findings are unresolved (#645)', async () => {
      const ctx = makeContext({
        findings: [makeFinding({ severity: 'critical', status: 'open', origin: 'vendored' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('all_high_critical_resolved');
      expect(result.satisfied).toBe(true);
    });

    it('is NOT satisfied when an authored high/critical finding is unresolved (regression guard)', async () => {
      const ctx = makeContext({
        findings: [makeFinding({ severity: 'high', status: 'open', origin: 'authored' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('all_high_critical_resolved');
      expect(result.satisfied).toBe(false);
      expect(result.reason).toMatch(/unresolved high\/critical/i);
    });
  });

  describe('track_is_manual_and_no_high_critical', () => {
    it('routes to verification_pending when only submodule high/critical findings exist', async () => {
      const ctx = makeContext({
        case_: makeCase({ validation_track: 'manual' }),
        findings: [makeFinding({ severity: 'high', origin: 'submodule' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('track_is_manual_and_no_high_critical');
      expect(result.satisfied).toBe(true);
    });

    it('is blocked by an authored high/critical finding (regression guard)', async () => {
      const ctx = makeContext({
        case_: makeCase({ validation_track: 'manual' }),
        findings: [makeFinding({ severity: 'high', origin: 'authored' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('track_is_manual_and_no_high_critical');
      expect(result.satisfied).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// #648 — the auto-approve / escalation / manual-track gates must filter
// authored high/critical findings by the shared `isBlockingFindingStatus`
// (open | accepted | contested), NOT a bare `status === 'open'`. A bare
// `=== 'open'` let a `contested` (and latently `accepted`) authored
// high/critical finding silently drop out of the gate, so the case
// auto-approved with an unadjudicated disputed finding.
//
// Exploit loop being closed:
//   open authored high → escalate → human files finding-level `reject`
//   (status → `contested`) → request_changes loops to in_build → agent
//   re-pushes → clean re-review (no NEW authored high/critical) →
//   auto_approve_criteria_met used to filter `=== 'open'` → the still-
//   `contested` finding was NOT counted → case auto-approved.
//
// These cases assert the three newly-aligned clauses now behave identically
// to `all_high_critical_resolved` for the same finding sets.
// ---------------------------------------------------------------------------
describe('preconditions: blocking-status alignment on authored high/critical (#648)', () => {
  const lowRiskCase = () =>
    makeCase({ validation_track: 'direct', risk_level: 'low' });
  const completedReview = () => [makeRun('2026-01-02T09:00:00Z', 'review_run')];

  // The non-`open` blocking statuses that the bare `=== 'open'` check missed.
  // `contested` is the live exploit path; `accepted` is latent (not currently
  // writable via any route) but must also block per `isBlockingFindingStatus`.
  const blockingNonOpen: ReadonlyArray<'contested' | 'accepted'> = [
    'contested',
    'accepted',
  ];
  // Resolved statuses that must NOT block — guards against over-blocking.
  const resolvedStatuses: ReadonlyArray<'resolved' | 'fixed' | 'waived'> = [
    'resolved',
    'fixed',
    'waived',
  ];

  describe.each(blockingNonOpen)('authored high finding with status %s', (status) => {
    it('does NOT auto-approve (auto_approve_criteria_met unsatisfied)', async () => {
      const ctx = makeContext({
        case_: lowRiskCase(),
        runs: completedReview(),
        findings: [makeFinding({ severity: 'high', status, origin: 'authored' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('auto_approve_criteria_met');
      expect(result.satisfied).toBe(false);
      expect(result.reason).toMatch(/high\/critical/i);
    });

    it('still triggers escalation (has_high_critical_findings satisfied)', async () => {
      const ctx = makeContext({
        findings: [makeFinding({ severity: 'high', status, origin: 'authored' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('has_high_critical_findings');
      expect(result.satisfied).toBe(true);
    });

    it('blocks the manual-track gate (track_is_manual_and_no_high_critical unsatisfied)', async () => {
      const ctx = makeContext({
        case_: makeCase({ validation_track: 'manual' }),
        findings: [makeFinding({ severity: 'high', status, origin: 'authored' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('track_is_manual_and_no_high_critical');
      expect(result.satisfied).toBe(false);
    });

    it('behaves identically to all_high_critical_resolved (which already blocks)', async () => {
      const ctx = makeContext({
        findings: [makeFinding({ severity: 'high', status, origin: 'authored' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('all_high_critical_resolved');
      expect(result.satisfied).toBe(false);
      expect(result.reason).toMatch(/unresolved high\/critical/i);
    });
  });

  it('full exploit loop: clean re-review still does NOT auto-approve while a contested authored high finding survives', async () => {
    // open authored high finding, escalated, rejected (now contested), then a
    // request_changes loopback and a fresh clean review_run after the loopback.
    const ctx = makeContext({
      case_: lowRiskCase(),
      // Review run AFTER the changes_requested loopback — the "clean re-review".
      runs: [makeRun('2026-01-04T09:00:00Z', 'review_run')],
      events: [makeChangesRequestedEvent('2026-01-03T00:00:00Z')],
      // The disputed finding adjudication left it `contested`, not resolved.
      findings: [
        makeFinding({
          severity: 'high',
          status: 'contested',
          origin: 'authored',
          created_at: '2026-01-02T00:00:00Z',
        }),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('auto_approve_criteria_met');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/high\/critical/i);
  });

  describe('regression guards — must still hold', () => {
    it('authored OPEN high/critical still blocks auto-approve (unchanged)', async () => {
      const ctx = makeContext({
        case_: lowRiskCase(),
        runs: completedReview(),
        findings: [makeFinding({ severity: 'critical', status: 'open', origin: 'authored' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('auto_approve_criteria_met');
      expect(result.satisfied).toBe(false);
    });

    describe.each(resolvedStatuses)('authored high finding with resolved status %s', (status) => {
      it('does NOT block auto-approve (no over-blocking)', async () => {
        const ctx = makeContext({
          case_: lowRiskCase(),
          runs: completedReview(),
          findings: [makeFinding({ severity: 'high', status, origin: 'authored' })],
        });
        const evaluator = createPreconditionEvaluator(ctx);
        const result = await evaluator.evaluate('auto_approve_criteria_met');
        expect(result.satisfied).toBe(true);
      });

      it('does NOT trigger escalation (has_high_critical_findings unsatisfied)', async () => {
        const ctx = makeContext({
          findings: [makeFinding({ severity: 'high', status, origin: 'authored' })],
        });
        const evaluator = createPreconditionEvaluator(ctx);
        const result = await evaluator.evaluate('has_high_critical_findings');
        expect(result.satisfied).toBe(false);
      });

      it('is satisfied by all_high_critical_resolved (parity)', async () => {
        const ctx = makeContext({
          findings: [makeFinding({ severity: 'high', status, origin: 'authored' })],
        });
        const evaluator = createPreconditionEvaluator(ctx);
        const result = await evaluator.evaluate('all_high_critical_resolved');
        expect(result.satisfied).toBe(true);
      });
    });

    it('a CONTESTED submodule-origin high finding still does NOT block (origin filter intact)', async () => {
      const ctx = makeContext({
        case_: lowRiskCase(),
        runs: completedReview(),
        findings: [makeFinding({ severity: 'high', status: 'contested', origin: 'submodule' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('auto_approve_criteria_met');
      expect(result.satisfied).toBe(true);
    });

    it('a CONTESTED vendored-origin high finding still does NOT escalate (origin filter intact)', async () => {
      const ctx = makeContext({
        findings: [makeFinding({ severity: 'high', status: 'contested', origin: 'vendored' })],
      });
      const evaluator = createPreconditionEvaluator(ctx);
      const result = await evaluator.evaluate('has_high_critical_findings');
      expect(result.satisfied).toBe(false);
    });
  });
});

describe('preconditions.merge_not_applicable (issue #687)', () => {
  it('is NOT satisfied without a merge_not_applicable decision', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'pending_merge' }),
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('merge_not_applicable');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/no merge_not_applicable decision/i);
  });

  it('is satisfied by a recorded merge_not_applicable decision when the case has no PR ref', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'pending_merge', current_branch: 'n/a-ops-config' }),
      decisions: [makeDecision('usr_reviewer1', '2026-01-02T00:00:00Z', 'merge_not_applicable')],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('merge_not_applicable');
    expect(result.satisfied).toBe(true);
  });

  it('hard-fails for cases WITH a PR reference even when a decision exists (pr_merged gate not weakened)', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'pending_merge', current_pr_ref: 'org/repo#42' }),
      decisions: [makeDecision('usr_reviewer1', '2026-01-02T00:00:00Z', 'merge_not_applicable')],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('merge_not_applicable');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/pr_merged gate applies/i);
  });

  it('does NOT count a stale decision from before a request_changes loopback', async () => {
    // After a loopback the new iteration may well produce a PR — the old
    // attestation that "no merge applies" no longer holds.
    const ctx = makeContext({
      case_: makeCase({ status: 'pending_merge' }),
      decisions: [makeDecision('usr_reviewer1', '2026-01-01T00:00:00Z', 'merge_not_applicable')],
      events: [makeChangesRequestedEvent('2026-01-02T00:00:00Z')],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('merge_not_applicable');
    expect(result.satisfied).toBe(false);
  });

  it('counts a fresh decision recorded after the most recent loopback', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'pending_merge' }),
      decisions: [makeDecision('usr_reviewer1', '2026-01-03T00:00:00Z', 'merge_not_applicable')],
      events: [makeChangesRequestedEvent('2026-01-02T00:00:00Z')],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('merge_not_applicable');
    expect(result.satisfied).toBe(true);
  });

  it('does NOT count a stale SYSTEM-attached decision once a branch has been recorded (crash window)', async () => {
    // The auto-attach asserts "no PR ref AND no branch". If the transition
    // crashed after the attach and a branch arrived later, the stale system
    // decision must not satisfy the gate — the PR may still arrive via
    // webhook branch-matching.
    const ctx = makeContext({
      case_: makeCase({ status: 'approved', current_branch: 'feature/late-branch' }),
      decisions: [makeDecision('system:pipeline', '2026-01-02T00:00:00Z', 'merge_not_applicable')],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('merge_not_applicable');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/stale/i);
  });

  it('a HUMAN decision stays branch-tolerant — sentinel-branch recovery path intact', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'pending_merge', current_branch: 'n/a-ops-config' }),
      decisions: [makeDecision('usr_reviewer1', '2026-01-02T00:00:00Z', 'merge_not_applicable')],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('merge_not_applicable');
    expect(result.satisfied).toBe(true);
  });

  it('a later HUMAN decision rescues a case with a stale SYSTEM decision', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'pending_merge', current_branch: 'n/a-sentinel' }),
      decisions: [
        makeDecision('system:pipeline', '2026-01-02T00:00:00Z', 'merge_not_applicable'),
        makeDecision('usr_reviewer1', '2026-01-03T00:00:00Z', 'merge_not_applicable'),
      ],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('merge_not_applicable');
    expect(result.satisfied).toBe(true);
  });

  it('a SYSTEM decision with no branch and no PR ref still satisfies (normal auto-skip)', async () => {
    const ctx = makeContext({
      case_: makeCase({ status: 'approved' }),
      decisions: [makeDecision('system:pipeline', '2026-01-02T00:00:00Z', 'merge_not_applicable')],
    });
    const evaluator = createPreconditionEvaluator(ctx);
    const result = await evaluator.evaluate('merge_not_applicable');
    expect(result.satisfied).toBe(true);
  });
});

describe('preconditions — refuted findings do not gate', () => {
  it('a refuted high finding does NOT trigger has_high_critical_findings', async () => {
    const ctx = makeContext({
      findings: [makeFinding({ severity: 'high', origin: 'authored', verification_status: 'refuted' })],
    });
    const result = await createPreconditionEvaluator(ctx).evaluate('has_high_critical_findings');
    expect(result.satisfied).toBe(false);
  });

  it('a confirmed high finding still triggers has_high_critical_findings', async () => {
    const ctx = makeContext({
      findings: [makeFinding({ severity: 'high', origin: 'authored', verification_status: 'confirmed' })],
    });
    const result = await createPreconditionEvaluator(ctx).evaluate('has_high_critical_findings');
    expect(result.satisfied).toBe(true);
  });

  it('an unverified high finding still triggers has_high_critical_findings', async () => {
    const ctx = makeContext({
      findings: [makeFinding({ severity: 'high', origin: 'authored', verification_status: 'unverified' })],
    });
    const result = await createPreconditionEvaluator(ctx).evaluate('has_high_critical_findings');
    expect(result.satisfied).toBe(true);
  });

  it('a refuted high finding does NOT block all_high_critical_resolved', async () => {
    const ctx = makeContext({
      findings: [makeFinding({ severity: 'high', status: 'open', origin: 'authored', verification_status: 'refuted' })],
    });
    const result = await createPreconditionEvaluator(ctx).evaluate('all_high_critical_resolved');
    expect(result.satisfied).toBe(true);
  });

  it('a confirmed open high finding still blocks all_high_critical_resolved', async () => {
    const ctx = makeContext({
      findings: [makeFinding({ severity: 'high', status: 'open', origin: 'authored', verification_status: 'confirmed' })],
    });
    const result = await createPreconditionEvaluator(ctx).evaluate('all_high_critical_resolved');
    expect(result.satisfied).toBe(false);
  });

  it('a refuted high finding does NOT block manual-track routing to verification_pending', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'manual' }),
      findings: [makeFinding({ severity: 'high', status: 'open', origin: 'authored', verification_status: 'refuted' })],
    });
    const result = await createPreconditionEvaluator(ctx).evaluate('track_is_manual_and_no_high_critical');
    expect(result.satisfied).toBe(true);
  });
});

describe('assistant lifecycle preconditions', () => {
  function makeAssistantCase(
    waitReason?: NonNullable<Case['assistant_context']>['wait_reason'],
  ): Case {
    return makeCase({
      case_type: 'assistant_task',
      assistant_context: {
        channel: 'google_chat',
        space_name: 'spaces/AAA',
        thread_name: 'spaces/AAA/threads/BBB',
        source_message_name: 'spaces/AAA/messages/CCC',
        chat_user_name: 'users/123',
        conversation_visibility: 'direct',
        task_kind: 'answer_question',
        risk_level: 'low',
        policy_version: 'assistant-policy:v1',
        prompt_version: 'assistant-system:v1',
        ...(waitReason !== undefined ? { wait_reason: waitReason } : {}),
      },
    });
  }

  function makeAssistantEvent(
    type: CaseEvent['type'],
    createdAt: string,
    payload: Record<string, unknown> = {},
  ): CaseEvent {
    return {
      event_id: `evt_${type}_${createdAt}`,
      case_id: 'case_1',
      type,
      payload,
      actor_id: 'system:assistant',
      created_at: createdAt,
    };
  }

  function makeAssistantResultEvidence(
    runId?: string,
    artifactRef = 'artifacts/task-result.json',
  ): Evidence {
    return {
      evidence_id: `ev_result_${runId ?? 'unlinked'}`,
      case_id: 'case_1',
      ...(runId !== undefined ? { run_id: runId } : {}),
      type: 'task_result',
      source_type: 'automated',
      artifact_ref: artifactRef,
      machine_readable: true,
      validation_track: 'direct',
      created_at: '2026-08-03T10:02:00Z',
      created_by: 'system:assistant',
    };
  }

  describe('assistant_run_claimed', () => {
    it('is satisfied when an assistant_task_run is running', async () => {
      const ctx = makeContext({
        case_: makeAssistantCase(),
        runs: [
          { ...makeRun('2026-08-03T10:00:00Z', 'assistant_task_run'), status: 'running' },
        ],
      });

      const result = await createPreconditionEvaluator(ctx).evaluate('assistant_run_claimed');

      expect(result.satisfied).toBe(true);
    });

    it('is not satisfied by pending or completed assistant runs', async () => {
      const ctx = makeContext({
        case_: makeAssistantCase(),
        runs: [
          { ...makeRun('2026-08-03T10:00:00Z', 'assistant_task_run'), status: 'pending' },
          makeRun('2026-08-03T10:01:00Z', 'assistant_task_run'),
        ],
      });

      const result = await createPreconditionEvaluator(ctx).evaluate('assistant_run_claimed');

      expect(result.satisfied).toBe(false);
    });
  });

  describe('assistant_terminal_failure_documented', () => {
    function makeTerminalCase(waitRunId?: string): Case {
      const case_ = makeAssistantCase('failed_permanently');
      return {
        ...case_,
        assistant_context: {
          ...case_.assistant_context!,
          ...(waitRunId !== undefined ? { wait_run_id: waitRunId, wait_attempt: 1 } : {}),
        },
      };
    }

    function makeFailedAssistantRun(runId: string, createdAt: string): Run {
      return {
        ...makeRun(createdAt, 'assistant_task_run'),
        run_id: runId,
        status: 'failed',
        error_message: 'Assistant attempt stopped by the max_steps bound',
      };
    }

    const abandonedEvent = (runId: string, createdAt = '2026-08-03T10:01:00Z') =>
      makeAssistantEvent('assistant_task_abandoned', createdAt, { run_id: runId });

    it('is satisfied by the verdict, the failed run it names, and its event', async () => {
      const ctx = makeContext({
        case_: makeTerminalCase('run_a1'),
        runs: [makeFailedAssistantRun('run_a1', '2026-08-03T10:00:00Z')],
        events: [abandonedEvent('run_a1')],
      });

      const result = await createPreconditionEvaluator(ctx).evaluate(
        'assistant_terminal_failure_documented',
      );

      expect(result.satisfied).toBe(true);
    });

    it('is not satisfied without the event that documents the run', async () => {
      const ctx = makeContext({
        case_: makeTerminalCase('run_a1'),
        runs: [makeFailedAssistantRun('run_a1', '2026-08-03T10:00:00Z')],
        events: [abandonedEvent('run_a0')],
      });

      const result = await createPreconditionEvaluator(ctx).evaluate(
        'assistant_terminal_failure_documented',
      );

      expect(result.satisfied).toBe(false);
    });

    it('is not satisfied when a newer attempt superseded the verdict', async () => {
      const ctx = makeContext({
        case_: makeTerminalCase('run_a1'),
        runs: [
          makeFailedAssistantRun('run_a1', '2026-08-03T10:00:00Z'),
          { ...makeRun('2026-08-03T10:05:00Z', 'assistant_task_run'), run_id: 'run_a2', status: 'running' as const },
        ],
        events: [abandonedEvent('run_a1')],
      });

      const result = await createPreconditionEvaluator(ctx).evaluate(
        'assistant_terminal_failure_documented',
      );

      expect(result.satisfied).toBe(false);
    });

    it('is not satisfied when the run it names is no longer failed', async () => {
      const ctx = makeContext({
        case_: makeTerminalCase('run_a1'),
        runs: [{ ...makeFailedAssistantRun('run_a1', '2026-08-03T10:00:00Z'), status: 'completed' as const }],
        events: [abandonedEvent('run_a1')],
      });

      const result = await createPreconditionEvaluator(ctx).evaluate(
        'assistant_terminal_failure_documented',
      );

      expect(result.satisfied).toBe(false);
    });

    it('is not satisfied by a non-terminal wait reason', async () => {
      const ctx = makeContext({
        case_: makeAssistantCase('retry_exhausted'),
        runs: [makeFailedAssistantRun('run_a1', '2026-08-03T10:00:00Z')],
        events: [abandonedEvent('run_a1')],
      });

      const result = await createPreconditionEvaluator(ctx).evaluate(
        'assistant_terminal_failure_documented',
      );

      expect(result.satisfied).toBe(false);
    });
  });

  describe('assistant_result_evidence_present', () => {
    it('is unsatisfied when linked result evidence exists but the latest run is still running', async () => {
      const run = {
        ...makeRun('2026-08-03T10:00:00Z', 'assistant_task_run'),
        status: 'running' as const,
      };
      const ctx = makeContext({
        case_: makeAssistantCase(),
        runs: [run],
        evidence: [makeAssistantResultEvidence(run.run_id)],
      });

      const result = await createPreconditionEvaluator(ctx).evaluate('assistant_result_evidence_present');

      expect(result.satisfied).toBe(false);
    });

    it.each(['failed', 'cancelled'] as const)(
      'is unsatisfied when linked result evidence exists but the latest run is %s',
      async (status) => {
        const run = {
          ...makeRun('2026-08-03T10:00:00Z', 'assistant_task_run'),
          status,
        };
        const ctx = makeContext({
          case_: makeAssistantCase(),
          runs: [run],
          evidence: [makeAssistantResultEvidence(run.run_id)],
        });

        const result = await createPreconditionEvaluator(ctx).evaluate('assistant_result_evidence_present');

        expect(result.satisfied).toBe(false);
      },
    );

    it('is unsatisfied when result evidence has no run_id', async () => {
      const run = makeRun('2026-08-03T10:00:00Z', 'assistant_task_run');
      const ctx = makeContext({
        case_: makeAssistantCase(),
        runs: [run],
        evidence: [makeAssistantResultEvidence()],
      });

      const result = await createPreconditionEvaluator(ctx).evaluate('assistant_result_evidence_present');

      expect(result.satisfied).toBe(false);
    });

    it('is unsatisfied when evidence is linked to an older run while a newer run is active', async () => {
      const olderRun = makeRun('2026-08-03T10:00:00Z', 'assistant_task_run');
      const newerRun = {
        ...makeRun('2026-08-03T10:01:00Z', 'assistant_task_run'),
        status: 'running' as const,
      };
      const ctx = makeContext({
        case_: makeAssistantCase(),
        runs: [newerRun, olderRun],
        evidence: [makeAssistantResultEvidence(olderRun.run_id)],
      });

      const result = await createPreconditionEvaluator(ctx).evaluate('assistant_result_evidence_present');

      expect(result.satisfied).toBe(false);
    });

    it('is unsatisfied when matching result evidence has a blank artifact_ref', async () => {
      const run = makeRun('2026-08-03T10:00:00Z', 'assistant_task_run');
      const ctx = makeContext({
        case_: makeAssistantCase(),
        runs: [run],
        evidence: [makeAssistantResultEvidence(run.run_id, '   ')],
      });

      const result = await createPreconditionEvaluator(ctx).evaluate('assistant_result_evidence_present');

      expect(result.satisfied).toBe(false);
    });

    it('is satisfied by result evidence linked to the latest completed run', async () => {
      const olderRun = makeRun('2026-08-03T10:00:00Z', 'assistant_task_run');
      const latestRun = makeRun('2026-08-03T10:01:00Z', 'assistant_task_run');
      const ctx = makeContext({
        case_: makeAssistantCase(),
        runs: [latestRun, olderRun],
        evidence: [makeAssistantResultEvidence(latestRun.run_id)],
      });

      const result = await createPreconditionEvaluator(ctx).evaluate('assistant_result_evidence_present');

      expect(result.satisfied).toBe(true);
    });
  });

  describe('assistant_no_active_run', () => {
    it('is satisfied when all runs are terminal', async () => {
      const ctx = makeContext({
        case_: makeAssistantCase(),
        runs: [
          makeRun('2026-08-03T10:00:00Z', 'assistant_task_run'),
          { ...makeRun('2026-08-03T10:01:00Z', 'assistant_action_run'), status: 'failed' },
        ],
      });

      const result = await createPreconditionEvaluator(ctx).evaluate('assistant_no_active_run');

      expect(result.satisfied).toBe(true);
    });

    it('is not satisfied when any run is pending or running', async () => {
      const ctx = makeContext({
        case_: makeAssistantCase(),
        runs: [
          { ...makeRun('2026-08-03T10:00:00Z', 'assistant_action_run'), status: 'running' },
        ],
      });

      const result = await createPreconditionEvaluator(ctx).evaluate('assistant_no_active_run');

      expect(result.satisfied).toBe(false);
    });
  });
});

describe('observed_case_signal_present', () => {
  it('is satisfied for an observed-type case', async () => {
    const ctx = makeContext({ case_: makeCase({ case_type: 'observed' }) });

    const result = await createPreconditionEvaluator(ctx).evaluate('observed_case_signal_present');

    expect(result.satisfied).toBe(true);
  });

  it('is not satisfied for a case of any other type', async () => {
    // Reverting the `ctx.case_.case_type !== 'observed'` check in
    // preconditions.ts (returning satisfied unconditionally) would make this
    // assertion fail — an engineering case would also satisfy the gate.
    const ctx = makeContext({ case_: makeCase({ case_type: 'ticket_implementation' }) });

    const result = await createPreconditionEvaluator(ctx).evaluate('observed_case_signal_present');

    expect(result.satisfied).toBe(false);
  });
});

describe('preconditions.all_steps_completed_or_not_high_critical_risk (issue #1000)', () => {
  // Gates the four unscoped `in_build|in_validation|in_review|approved →
  // done` auto-close-on-merge shortcuts (AND-combined with `pr_merged`) so a
  // merged PR cannot bypass evidence/review/approval for an escalated or
  // otherwise high/critical-risk case. Each test below states which of the
  // gate's two branches (risk level, or completed steps) it actually varies,
  // and pins the OTHER branch so the case is not satisfying the gate through
  // it by accident.

  it('is satisfied for low risk with no approval decision (varies: risk level low, not on direct track either — proves the gate does not fall back to track_is_direct_and_high_critical_risk validation_track===direct restriction)', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'manual', risk_level: 'low' }),
      decisions: [],
    });
    const result = await createPreconditionEvaluator(ctx).evaluate(
      'all_steps_completed_or_not_high_critical_risk',
    );
    expect(result.satisfied).toBe(true);
  });

  it('is satisfied for medium risk with no approval decision (varies: risk level medium)', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'medium' }),
      decisions: [],
    });
    const result = await createPreconditionEvaluator(ctx).evaluate(
      'all_steps_completed_or_not_high_critical_risk',
    );
    expect(result.satisfied).toBe(true);
  });

  it('is NOT satisfied for high risk with no approval decision (varies: completed-steps branch — pins risk to high so only all_steps_completed can save it, and it can not)', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'high' }),
      decisions: [],
    });
    const result = await createPreconditionEvaluator(ctx).evaluate(
      'all_steps_completed_or_not_high_critical_risk',
    );
    expect(result.satisfied).toBe(false);
  });

  it('is NOT satisfied for critical risk with no approval decision (varies: risk level critical, confirming the inverse-polarity check covers BOTH high and critical like track_is_direct_and_high_critical_risk does)', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'critical' }),
      decisions: [],
    });
    const result = await createPreconditionEvaluator(ctx).evaluate(
      'all_steps_completed_or_not_high_critical_risk',
    );
    expect(result.satisfied).toBe(false);
  });

  it('IS satisfied for high risk once an approval decision is documented (varies: completed-steps branch flips to true — same risk level as the failing case above)', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'high' }),
      decisions: [makeDecision('usr_reviewer', '2026-01-02T10:00:00Z', 'approve')],
    });
    const result = await createPreconditionEvaluator(ctx).evaluate(
      'all_steps_completed_or_not_high_critical_risk',
    );
    expect(result.satisfied).toBe(true);
  });

  it('is NOT satisfied for a Manual Track high-risk case with no approval decision — proves the gate does NOT carry track_is_direct_and_high_critical_risk validation_track===direct restriction (an escalated case can be on any track)', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'manual', risk_level: 'critical' }),
      decisions: [],
    });
    const result = await createPreconditionEvaluator(ctx).evaluate(
      'all_steps_completed_or_not_high_critical_risk',
    );
    expect(result.satisfied).toBe(false);
  });

  it('IS satisfied for a Manual Track high-risk case once all_steps_completed holds (manual_validation_confirmed counts, same as all_steps_completed itself)', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'manual', risk_level: 'critical' }),
      decisions: [makeDecision('usr_reviewer', '2026-01-02T10:00:00Z', 'manual_validation_confirmed')],
    });
    const result = await createPreconditionEvaluator(ctx).evaluate(
      'all_steps_completed_or_not_high_critical_risk',
    );
    expect(result.satisfied).toBe(true);
  });

  it('does NOT count a stale approve decision from before a loopback, for a high-risk case (mirrors the all_steps_completed loopback test above — proves the gate reuses that exact logic, not a copy)', async () => {
    const ctx = makeContext({
      case_: makeCase({ validation_track: 'direct', risk_level: 'high' }),
      decisions: [
        makeDecision('usr_reviewer', '2026-01-01T10:00:00Z', 'approve'), // stale
      ],
      events: [makeChangesRequestedEvent('2026-01-02T00:00:00Z')],
    });
    const result = await createPreconditionEvaluator(ctx).evaluate(
      'all_steps_completed_or_not_high_critical_risk',
    );
    expect(result.satisfied).toBe(false);
  });
});
