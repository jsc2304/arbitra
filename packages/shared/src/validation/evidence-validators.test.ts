import { describe, expect, it } from 'vitest';
import { evidencePolicyRuleSchema } from './evidence-validators.js';

function baseRule(overrides: Record<string, unknown> = {}) {
  return {
    required_evidence_types: [],
    optional_evidence_types: [],
    four_eyes_required: false,
    allow_self_approval: false,
    ...overrides,
  };
}

describe('evidencePolicyRuleSchema — requires_no_evidence write boundary', () => {
  it('rejects an empty required_evidence_types with no requires_no_evidence flag', () => {
    const result = evidencePolicyRuleSchema.safeParse(baseRule());
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('required_evidence_types');
    }
  });

  it('accepts an empty required_evidence_types when requires_no_evidence is true', () => {
    const result = evidencePolicyRuleSchema.safeParse(
      baseRule({ requires_no_evidence: true }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects requires_no_evidence: true together with a non-empty required_evidence_types (contradiction)', () => {
    const result = evidencePolicyRuleSchema.safeParse(
      baseRule({ required_evidence_types: ['ci_result'], requires_no_evidence: true }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('requires_no_evidence');
    }
  });

  it('accepts a normal non-empty required list with no flag (unchanged behavior)', () => {
    const result = evidencePolicyRuleSchema.safeParse(
      baseRule({ required_evidence_types: ['ci_result'] }),
    );
    expect(result.success).toBe(true);
  });
});
