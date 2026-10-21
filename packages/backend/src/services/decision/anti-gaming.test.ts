import { describe, it, expect } from 'vitest';
import { checkSelfApprovalProhibition, shouldCreateRiskDowngradeAudit } from './anti-gaming.js';
import type { Case } from '@arbitra/shared';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1', title: 'Test', description: '', source_type: 'manual',
    source_ref: '', project_id: 'p1', repository_id: 'r1', owner_user_id: 'usr_owner',
    status: 'in_review', validation_track: 'direct', risk_level: 'medium',
    priority: 'normal', active_rule_set_refs: [], knowledge_context_refs: [],
    decision_ready: true, created_at: '', updated_at: '',
    ...overrides,
  };
}

describe('checkSelfApprovalProhibition', () => {
  it('should throw when owner tries to approve high-risk case', () => {
    expect(() => {
      checkSelfApprovalProhibition(makeCase({ risk_level: 'high' }), 'usr_owner', 'approve');
    }).toThrow('Self-approval');
  });

  it('should throw when owner tries to approve critical-risk case', () => {
    expect(() => {
      checkSelfApprovalProhibition(makeCase({ risk_level: 'critical' }), 'usr_owner', 'approve');
    }).toThrow('Self-approval');
  });

  it('should allow self-approval for low-risk case', () => {
    expect(() => {
      checkSelfApprovalProhibition(makeCase({ risk_level: 'low' }), 'usr_owner', 'approve');
    }).not.toThrow();
  });

  it('should allow self-approval for medium-risk case', () => {
    expect(() => {
      checkSelfApprovalProhibition(makeCase({ risk_level: 'medium' }), 'usr_owner', 'approve');
    }).not.toThrow();
  });

  it('should allow different user to approve high-risk case', () => {
    expect(() => {
      checkSelfApprovalProhibition(makeCase({ risk_level: 'high' }), 'usr_reviewer', 'approve');
    }).not.toThrow();
  });

  it('should allow auto_approve regardless of actor', () => {
    expect(() => {
      checkSelfApprovalProhibition(makeCase(), 'usr_owner', 'auto_approve');
    }).not.toThrow();
  });

  it('should not check for non-approve decisions', () => {
    expect(() => {
      checkSelfApprovalProhibition(makeCase({ risk_level: 'high' }), 'usr_owner', 'request_changes');
    }).not.toThrow();
  });

  // ── allow_self_approval opt-out (per evidence-policy cell) ────────
  it('should block owner-approve on high-risk when allowSelfApproval=false (default)', () => {
    expect(() => {
      checkSelfApprovalProhibition(
        makeCase({ risk_level: 'high' }),
        'usr_owner',
        'approve',
        false,
      );
    }).toThrow('Self-approval');
  });

  it('should allow owner-approve on high-risk when allowSelfApproval=true', () => {
    expect(() => {
      checkSelfApprovalProhibition(
        makeCase({ risk_level: 'high' }),
        'usr_owner',
        'approve',
        true,
      );
    }).not.toThrow();
  });

  it('should allow owner-approve on critical-risk when allowSelfApproval=true', () => {
    expect(() => {
      checkSelfApprovalProhibition(
        makeCase({ risk_level: 'critical' }),
        'usr_owner',
        'approve',
        true,
      );
    }).not.toThrow();
  });

  it('should not affect non-owner approvals regardless of allowSelfApproval flag', () => {
    expect(() => {
      checkSelfApprovalProhibition(
        makeCase({ risk_level: 'high' }),
        'usr_reviewer',
        'approve',
        false,
      );
    }).not.toThrow();
  });
});

describe('shouldCreateRiskDowngradeAudit', () => {
  it('should flag high → low downgrade', () => {
    expect(shouldCreateRiskDowngradeAudit('high', 'low')).toBe(true);
  });

  it('should flag critical → medium downgrade', () => {
    expect(shouldCreateRiskDowngradeAudit('critical', 'medium')).toBe(true);
  });

  it('should NOT flag low → medium upgrade', () => {
    expect(shouldCreateRiskDowngradeAudit('low', 'medium')).toBe(false);
  });

  it('should NOT flag medium → low (not from high/critical)', () => {
    expect(shouldCreateRiskDowngradeAudit('medium', 'low')).toBe(false);
  });

  it('should NOT flag high → critical (upgrade)', () => {
    expect(shouldCreateRiskDowngradeAudit('high', 'critical')).toBe(false);
  });
});
