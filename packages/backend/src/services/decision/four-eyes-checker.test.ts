import { describe, it, expect } from 'vitest';
import { checkFourEyes, type FourEyesPolicy } from './four-eyes-checker.js';
import type { Case, Decision, DecisionSnapshot } from '@arbitra/shared';

const snapshot: DecisionSnapshot = {
  active_rule_set_versions: {},
  evidence_policy_version: 1,
  knowledge_asset_refs: [],
};

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1', title: 'Test', description: '', source_type: 'manual',
    source_ref: '', project_id: 'p1', repository_id: 'r1', owner_user_id: 'usr_owner',
    status: 'verification_pending', validation_track: 'manual', risk_level: 'high',
    priority: 'normal', active_rule_set_refs: [], knowledge_context_refs: [],
    decision_ready: true, created_at: '', updated_at: '',
    ...overrides,
  };
}

function makeDecision(type: 'approve' | 'manual_validation_confirmed', actorId: string): Decision {
  return {
    decision_id: `dec_${actorId}`, case_id: 'case_1', type, actor_id: actorId,
    rationale: 'test', snapshot,
    created_at: '',
  };
}

// Policies matching the defaults shipped for the two common presets.
const STRICT: FourEyesPolicy = { four_eyes_required: true, allow_self_approval: false };
const RELAXED_OFF: FourEyesPolicy = { four_eyes_required: false, allow_self_approval: true };
const REQUIRED_SELF_OK: FourEyesPolicy = { four_eyes_required: true, allow_self_approval: true };

describe('checkFourEyes', () => {
  it('is satisfied when policy does not require four-eyes (low risk preset)', () => {
    const result = checkFourEyes(makeCase({ risk_level: 'low' }), [], RELAXED_OFF);
    expect(result.required).toBe(false);
    expect(result.satisfied).toBe(true);
  });

  it('is satisfied when policy does not require four-eyes even for high risk', () => {
    // Real-world scenario: a project has four-eyes disabled
    // for every (risk, track) cell. High-risk case with only owner approval must
    // still satisfy the gate.
    const decisions = [makeDecision('approve', 'usr_owner')];
    const result = checkFourEyes(makeCase({ risk_level: 'high' }), decisions, RELAXED_OFF);
    expect(result.required).toBe(false);
    expect(result.satisfied).toBe(true);
    expect(result.approverIds).toEqual(['usr_owner']);
  });

  it('requires four-eyes when policy says so (high risk, strict)', () => {
    const result = checkFourEyes(makeCase({ risk_level: 'high' }), [], STRICT);
    expect(result.required).toBe(true);
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/evidence policy/i);
  });

  it('requires four-eyes when policy says so (critical risk, strict)', () => {
    const result = checkFourEyes(makeCase({ risk_level: 'critical' }), [], STRICT);
    expect(result.required).toBe(true);
    expect(result.satisfied).toBe(false);
  });

  it('is not satisfied with only one approver under strict policy', () => {
    const decisions = [makeDecision('approve', 'usr_reviewer1')];
    const result = checkFourEyes(makeCase(), decisions, STRICT);
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/distinct approvers/i);
  });

  it('is satisfied with two distinct non-owner approvers under strict policy', () => {
    const decisions = [
      makeDecision('approve', 'usr_reviewer1'),
      makeDecision('manual_validation_confirmed', 'usr_reviewer2'),
    ];
    const result = checkFourEyes(makeCase(), decisions, STRICT);
    expect(result.satisfied).toBe(true);
    expect(result.approverIds).toHaveLength(2);
  });

  it('does not count same person twice', () => {
    const decisions = [
      makeDecision('approve', 'usr_reviewer1'),
      makeDecision('manual_validation_confirmed', 'usr_reviewer1'),
    ];
    const result = checkFourEyes(makeCase(), decisions, STRICT);
    expect(result.satisfied).toBe(false);
  });

  // Strict: owner cannot be the only kind of approver even if the count reaches 2.
  it('fails under strict policy when 2 decisions both come from the owner', () => {
    const decisions = [
      makeDecision('approve', 'usr_owner'),
      makeDecision('manual_validation_confirmed', 'usr_owner'),
    ];
    const result = checkFourEyes(makeCase(), decisions, STRICT);
    // dedup collapses to 1 approver — distinct-count check fires first
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/distinct approvers/i);
  });

  // four_eyes_required + allow_self_approval: owner counts but we still need 2 DISTINCT approvers.
  it('is satisfied with owner + reviewer under required+self_ok policy', () => {
    const decisions = [
      makeDecision('approve', 'usr_owner'),
      makeDecision('approve', 'usr_reviewer1'),
    ];
    const result = checkFourEyes(makeCase(), decisions, REQUIRED_SELF_OK);
    expect(result.satisfied).toBe(true);
    expect(result.approverIds).toHaveLength(2);
  });

  it('fails under required+self_ok when both decisions are the owner (still needs 2 distinct)', () => {
    const decisions = [
      makeDecision('approve', 'usr_owner'),
      makeDecision('manual_validation_confirmed', 'usr_owner'),
    ];
    const result = checkFourEyes(makeCase(), decisions, REQUIRED_SELF_OK);
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/distinct approvers/i);
    expect(result.reason).not.toMatch(/allow_self_approval=false/);
  });

  // Independence check preserved from the pre-fix era, now expressed via the
  // explicit strict policy. Even with the owner being the sole approver, the
  // distinct-count check blocks satisfaction.
  it('fails under strict policy when owner is the sole approver', () => {
    const case_ = makeCase({ risk_level: 'high' });
    const decisions = [makeDecision('approve', 'usr_owner')];
    const result = checkFourEyes(case_, decisions, STRICT);
    expect(result.required).toBe(true);
    expect(result.satisfied).toBe(false);
  });
});
