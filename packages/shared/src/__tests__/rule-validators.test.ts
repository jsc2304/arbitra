import { describe, it, expect } from 'vitest';
import { createRuleSchema, updateRuleSchema } from '../validation/rule-validators.js';

const validRule = {
  name: 'No console.log in production code',
  category: 'code_quality_rule',
  evaluation_mode: 'diff_pattern' as const,
  severity_if_failed: 'medium' as const,
  scope: { layer: 'global' as const, ref: 'global' },
  description: 'Flags console.log statements left in shipped code.',
  rationale: 'Console statements leak in production builds.',
};

describe('createRuleSchema', () => {
  it('accepts a valid global-scope rule', () => {
    const result = createRuleSchema.safeParse(validRule);
    expect(result.success).toBe(true);
  });

  it('accepts a valid project-scope rule with scope.ref', () => {
    const result = createRuleSchema.safeParse({
      ...validRule,
      scope: { layer: 'project', ref: 'proj_1' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects when name is missing', () => {
    const { name, ...rest } = validRule;
    expect(createRuleSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects when category is missing', () => {
    const { category, ...rest } = validRule;
    expect(createRuleSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects when evaluation_mode is missing', () => {
    const { evaluation_mode, ...rest } = validRule;
    expect(createRuleSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects invalid evaluation_mode', () => {
    const result = createRuleSchema.safeParse({ ...validRule, evaluation_mode: 'vibes_check' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid evaluation_mode values', () => {
    for (const mode of ['metadata_check', 'diff_pattern', 'evidence_check', 'llm_evaluation', 'human_confirmation']) {
      const result = createRuleSchema.safeParse({ ...validRule, evaluation_mode: mode });
      expect(result.success, `evaluation_mode "${mode}" should be valid`).toBe(true);
    }
  });

  it('rejects invalid severity_if_failed', () => {
    const result = createRuleSchema.safeParse({ ...validRule, severity_if_failed: 'extreme' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid severity_if_failed values', () => {
    for (const sev of ['low', 'medium', 'high', 'critical']) {
      const result = createRuleSchema.safeParse({ ...validRule, severity_if_failed: sev });
      expect(result.success, `severity_if_failed "${sev}" should be valid`).toBe(true);
    }
  });

  it('rejects invalid scope.layer', () => {
    const result = createRuleSchema.safeParse({ ...validRule, scope: { layer: 'org', ref: 'x' } });
    expect(result.success).toBe(false);
  });

  it('rejects a project-scope rule missing scope.ref', () => {
    const result = createRuleSchema.safeParse({ ...validRule, scope: { layer: 'project' } });
    expect(result.success).toBe(false);
  });

  it('rejects a project-scope rule with an empty scope.ref', () => {
    const result = createRuleSchema.safeParse({ ...validRule, scope: { layer: 'project', ref: '' } });
    expect(result.success).toBe(false);
  });

  it('accepts a global-scope rule with no scope.ref', () => {
    const result = createRuleSchema.safeParse({ ...validRule, scope: { layer: 'global' } });
    expect(result.success).toBe(true);
  });

  it('rejects when description is missing', () => {
    const { description, ...rest } = validRule;
    expect(createRuleSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects when rationale is missing', () => {
    const { rationale, ...rest } = validRule;
    expect(createRuleSchema.safeParse(rest).success).toBe(false);
  });

  it('accepts an optional config object', () => {
    const result = createRuleSchema.safeParse({ ...validRule, config: { pattern: 'console\\.log' } });
    expect(result.success).toBe(true);
  });

  it('accepts an arbitrary category string (permissive, not enum-gated)', () => {
    const result = createRuleSchema.safeParse({ ...validRule, category: 'my_custom_category' });
    expect(result.success).toBe(true);
  });
});

describe('updateRuleSchema', () => {
  it('accepts an empty object (no fields to update)', () => {
    expect(updateRuleSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a partial update with only status', () => {
    expect(updateRuleSchema.safeParse({ status: 'active' }).success).toBe(true);
  });

  it('rejects invalid status', () => {
    expect(updateRuleSchema.safeParse({ status: 'archived' }).success).toBe(false);
  });

  it('accepts all valid status values', () => {
    for (const status of ['active', 'inactive', 'draft']) {
      expect(updateRuleSchema.safeParse({ status }).success, `status "${status}"`).toBe(true);
    }
  });

  it('rejects invalid evaluation_mode when provided', () => {
    expect(updateRuleSchema.safeParse({ evaluation_mode: 'nope' }).success).toBe(false);
  });

  it('rejects invalid severity_if_failed when provided', () => {
    expect(updateRuleSchema.safeParse({ severity_if_failed: 'nope' }).success).toBe(false);
  });

  it('does not accept a scope field (PATCH never allows scope changes)', () => {
    const result = updateRuleSchema.safeParse({ scope: { layer: 'project', ref: 'proj_1' } });
    // Non-strict schema: unknown keys are stripped, not rejected — the
    // parsed payload simply never carries `scope` through.
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).scope).toBeUndefined();
    }
  });

  it('accepts multiple fields at once', () => {
    const result = updateRuleSchema.safeParse({
      name: 'Renamed rule',
      description: 'Updated description',
      category: 'security_rule',
      config: { severity: 'high' },
    });
    expect(result.success).toBe(true);
  });
});
