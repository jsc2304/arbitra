import { describe, it, expect } from 'vitest';
import { createRuleSetSchema, updateRuleSetSchema } from '../validation/rule-set-validators.js';

describe('createRuleSetSchema', () => {
  it('accepts a minimal valid rule set (only name)', () => {
    const result = createRuleSetSchema.safeParse({ name: 'Security baseline' });
    expect(result.success).toBe(true);
  });

  it('defaults description to empty string', () => {
    const result = createRuleSetSchema.safeParse({ name: 'Security baseline' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.description).toBe('');
  });

  it('defaults rule_refs to an empty array', () => {
    const result = createRuleSetSchema.safeParse({ name: 'Security baseline' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.rule_refs).toEqual([]);
  });

  it("defaults status to 'draft'", () => {
    const result = createRuleSetSchema.safeParse({ name: 'Security baseline' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toBe('draft');
  });

  it('rejects when name is missing', () => {
    expect(createRuleSetSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(createRuleSetSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects a whitespace-only name', () => {
    expect(createRuleSetSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('trims a padded name', () => {
    const result = createRuleSetSchema.safeParse({ name: '  Security baseline  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('Security baseline');
  });

  it('rejects an invalid status (tightening: today\'s route does not validate this at all)', () => {
    const result = createRuleSetSchema.safeParse({ name: 'x', status: 'bogus' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid status values', () => {
    for (const status of ['active', 'inactive', 'draft']) {
      const result = createRuleSetSchema.safeParse({ name: 'x', status });
      expect(result.success, `status "${status}"`).toBe(true);
    }
  });

  it('accepts an optional project_id', () => {
    const result = createRuleSetSchema.safeParse({ name: 'x', project_id: 'proj_1' });
    expect(result.success).toBe(true);
  });

  it('accepts rule_refs as an array of strings', () => {
    const result = createRuleSetSchema.safeParse({ name: 'x', rule_refs: ['rule_1', 'rule_2'] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.rule_refs).toEqual(['rule_1', 'rule_2']);
  });
});

describe('updateRuleSetSchema', () => {
  it('accepts an empty object (no fields to update)', () => {
    expect(updateRuleSetSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a partial update with only status', () => {
    expect(updateRuleSetSchema.safeParse({ status: 'active' }).success).toBe(true);
  });

  it('rejects invalid status', () => {
    expect(updateRuleSetSchema.safeParse({ status: 'archived' }).success).toBe(false);
  });

  it('accepts a partial update with name/description/rule_refs', () => {
    const result = updateRuleSetSchema.safeParse({
      name: 'Renamed set',
      description: 'New description',
      rule_refs: ['rule_1'],
    });
    expect(result.success).toBe(true);
  });

  it('does not accept a project_id field (not patchable today)', () => {
    const result = updateRuleSetSchema.safeParse({ project_id: 'proj_2' });
    // Non-strict: unknown keys stripped rather than rejected.
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).project_id).toBeUndefined();
    }
  });
});
