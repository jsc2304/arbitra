import { describe, expect, it } from 'vitest';
import { classifyPolicyCell, mergeEvidencePolicyRules, isPolicyCellAuthored } from './evidence-policy-rules.js';
import type { EvidencePolicyRule, EvidencePolicyRulesMap } from '../types/evidence.js';

function rule(overrides: Partial<EvidencePolicyRule> = {}): EvidencePolicyRule {
  return {
    required_evidence_types: [],
    optional_evidence_types: [],
    four_eyes_required: false,
    allow_self_approval: false,
    ...overrides,
  };
}

describe('classifyPolicyCell', () => {
  it('classifies an absent cell as inherits_defaults', () => {
    expect(classifyPolicyCell(undefined)).toBe('inherits_defaults');
  });

  it('classifies an empty cell with no requires_no_evidence flag as inherits_defaults (legacy read decision)', () => {
    expect(classifyPolicyCell(rule())).toBe('inherits_defaults');
  });

  it('classifies an empty cell with requires_no_evidence: true as requires_nothing', () => {
    expect(classifyPolicyCell(rule({ requires_no_evidence: true }))).toBe('requires_nothing');
  });

  it('classifies a cell with a non-empty required list as custom', () => {
    expect(classifyPolicyCell(rule({ required_evidence_types: ['ci_result'] }))).toBe('custom');
  });
});

describe('isPolicyCellAuthored', () => {
  it('is false for an absent cell and a legacy empty cell', () => {
    expect(isPolicyCellAuthored(undefined)).toBe(false);
    expect(isPolicyCellAuthored(rule())).toBe(false);
  });

  it('is true for an explicit requires-nothing cell and a custom cell', () => {
    expect(isPolicyCellAuthored(rule({ requires_no_evidence: true }))).toBe(true);
    expect(isPolicyCellAuthored(rule({ required_evidence_types: ['ci_result'] }))).toBe(true);
  });
});

describe('mergeEvidencePolicyRules', () => {
  it('preserves risk keys the incoming map does not mention', () => {
    const current: EvidencePolicyRulesMap = {
      low: { direct: rule({ required_evidence_types: ['ci_result'] }) },
      medium: { direct: rule({ required_evidence_types: ['ci_result', 'unit_test_result'] }) },
    };
    const incoming: EvidencePolicyRulesMap = {
      high: { direct: rule({ required_evidence_types: ['runtime_log'], four_eyes_required: true }) },
    };

    const merged = mergeEvidencePolicyRules(current, incoming);

    expect(merged.low).toEqual(current.low);
    expect(merged.medium).toEqual(current.medium);
    expect(merged.high).toEqual(incoming.high);
  });

  it('replaces a whole cell the incoming map does mention (cell is atomic)', () => {
    const current: EvidencePolicyRulesMap = {
      low: {
        direct: rule({ required_evidence_types: ['ci_result'] }),
        manual: rule({ required_evidence_types: ['manual_confirmation'] }),
      },
    };
    const incoming: EvidencePolicyRulesMap = {
      low: { direct: rule({ required_evidence_types: ['lint_result'] }) },
    };

    const merged = mergeEvidencePolicyRules(current, incoming);

    expect(merged.low?.direct).toEqual(incoming.low?.direct);
    // `manual` wasn't mentioned in the incoming `low` bucket — it survives.
    expect(merged.low?.manual).toEqual(current.low?.manual);
  });
});
