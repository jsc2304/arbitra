import { describe, it, expect } from 'vitest';
import { resolveRuleLayers } from './layering.js';
import type { Rule } from '@arbitra/shared';

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    rule_id: 'r1', name: 'test-rule', category: 'code_quality_rule',
    scope: { layer: 'global', ref: 'global' }, evaluation_mode: 'metadata_check',
    severity_if_failed: 'medium', config: {}, description: '', rationale: '',
    status: 'active', version: 1, created_at: '', updated_at: '',
    ...overrides,
  };
}

describe('resolveRuleLayers', () => {
  it('should return all rules when there are no conflicts', () => {
    const rules = [
      makeRule({ rule_id: 'g1', name: 'rule-a', category: 'code_quality_rule', scope: { layer: 'global', ref: 'global' } }),
      makeRule({ rule_id: 'p1', name: 'rule-b', category: 'test_rule', scope: { layer: 'project', ref: 'proj_1' } }),
    ];
    const result = resolveRuleLayers(rules);
    expect(result).toHaveLength(2);
  });

  it('should override global rule when project rule has same category and name', () => {
    const rules = [
      makeRule({ rule_id: 'g1', name: 'no-console', category: 'code_quality_rule', scope: { layer: 'global', ref: 'global' }, severity_if_failed: 'low' }),
      makeRule({ rule_id: 'p1', name: 'no-console', category: 'code_quality_rule', scope: { layer: 'project', ref: 'proj_1' }, severity_if_failed: 'critical' }),
    ];
    const result = resolveRuleLayers(rules);
    expect(result).toHaveLength(1);
    expect(result[0]!.rule_id).toBe('p1');
    expect(result[0]!.severity_if_failed).toBe('critical');
  });

  it('should keep both when same name but different category', () => {
    const rules = [
      makeRule({ rule_id: 'g1', name: 'no-console', category: 'code_quality_rule', scope: { layer: 'global', ref: 'global' } }),
      makeRule({ rule_id: 'p1', name: 'no-console', category: 'security_rule', scope: { layer: 'project', ref: 'proj_1' } }),
    ];
    const result = resolveRuleLayers(rules);
    expect(result).toHaveLength(2);
  });

  it('should keep both when same category but different name', () => {
    const rules = [
      makeRule({ rule_id: 'g1', name: 'rule-a', category: 'code_quality_rule', scope: { layer: 'global', ref: 'global' } }),
      makeRule({ rule_id: 'p1', name: 'rule-b', category: 'code_quality_rule', scope: { layer: 'project', ref: 'proj_1' } }),
    ];
    const result = resolveRuleLayers(rules);
    expect(result).toHaveLength(2);
  });

  it('should place project rules before surviving global rules', () => {
    const rules = [
      makeRule({ rule_id: 'g1', name: 'global-only', category: 'test_rule', scope: { layer: 'global', ref: 'global' } }),
      makeRule({ rule_id: 'p1', name: 'project-only', category: 'security_rule', scope: { layer: 'project', ref: 'proj_1' } }),
    ];
    const result = resolveRuleLayers(rules);
    expect(result[0]!.rule_id).toBe('p1');
    expect(result[1]!.rule_id).toBe('g1');
  });

  it('should handle multiple overrides across categories', () => {
    const rules = [
      makeRule({ rule_id: 'g1', name: 'rule-x', category: 'code_quality_rule', scope: { layer: 'global', ref: 'global' } }),
      makeRule({ rule_id: 'g2', name: 'rule-y', category: 'security_rule', scope: { layer: 'global', ref: 'global' } }),
      makeRule({ rule_id: 'g3', name: 'rule-z', category: 'test_rule', scope: { layer: 'global', ref: 'global' } }),
      makeRule({ rule_id: 'p1', name: 'rule-x', category: 'code_quality_rule', scope: { layer: 'project', ref: 'proj_1' } }),
      makeRule({ rule_id: 'p2', name: 'rule-y', category: 'security_rule', scope: { layer: 'project', ref: 'proj_1' } }),
    ];
    const result = resolveRuleLayers(rules);
    // p1 overrides g1, p2 overrides g2, g3 survives
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.rule_id)).toEqual(['p1', 'p2', 'g3']);
  });

  it('should return empty array for empty input', () => {
    expect(resolveRuleLayers([])).toHaveLength(0);
  });

  it('should return only global rules when no project rules exist', () => {
    const rules = [
      makeRule({ rule_id: 'g1', scope: { layer: 'global', ref: 'global' } }),
      makeRule({ rule_id: 'g2', name: 'other', scope: { layer: 'global', ref: 'global' } }),
    ];
    const result = resolveRuleLayers(rules);
    expect(result).toHaveLength(2);
  });

  it('should return only project rules when no global rules exist', () => {
    const rules = [
      makeRule({ rule_id: 'p1', scope: { layer: 'project', ref: 'proj_1' } }),
    ];
    const result = resolveRuleLayers(rules);
    expect(result).toHaveLength(1);
    expect(result[0]!.rule_id).toBe('p1');
  });
});
