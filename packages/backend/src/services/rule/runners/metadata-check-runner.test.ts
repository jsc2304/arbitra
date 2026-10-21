import { describe, it, expect } from 'vitest';
import { MetadataCheckRunner } from './metadata-check-runner.js';
import type { Rule, Case, Evidence } from '@arbitra/shared';
import type { RunnerContext } from './runner-interface.js';

function makeRule(config: Record<string, unknown>): Rule {
  return {
    rule_id: 'r1', name: 'test-rule', category: 'code_quality_rule',
    scope: { layer: 'global', ref: 'global' }, evaluation_mode: 'metadata_check',
    severity_if_failed: 'medium', config, description: '', rationale: '',
    status: 'active', version: 1, created_at: '', updated_at: '',
  };
}

function makeContext(caseOverrides: Partial<Case> = {}): RunnerContext {
  return {
    case_: {
      case_id: 'case_1', title: 'Test Case', description: 'desc', source_type: 'manual',
      source_ref: '', project_id: 'p1', repository_id: 'r1', owner_user_id: 'usr_1',
      status: 'in_validation', validation_track: 'direct', risk_level: 'medium',
      priority: 'normal', active_rule_set_refs: [], knowledge_context_refs: [],
      decision_ready: false, created_at: '', updated_at: '',
      ...caseOverrides,
    },
    evidence: [],
  };
}

const runner = new MetadataCheckRunner();

describe('MetadataCheckRunner – equals operator', () => {
  it('should pass when field equals expected value', async () => {
    const rule = makeRule({ field: 'risk_level', operator: 'equals', expected_value: 'medium' });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('pass');
  });

  it('should fail when field does not equal expected value', async () => {
    const rule = makeRule({ field: 'risk_level', operator: 'equals', expected_value: 'high' });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('fail');
  });
});

describe('MetadataCheckRunner – not_equals operator', () => {
  it('should pass when field differs from expected', async () => {
    const rule = makeRule({ field: 'risk_level', operator: 'not_equals', expected_value: 'high' });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('pass');
  });

  it('should fail when field matches expected', async () => {
    const rule = makeRule({ field: 'risk_level', operator: 'not_equals', expected_value: 'medium' });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('fail');
  });
});

describe('MetadataCheckRunner – exists operator', () => {
  it('should pass when field exists and is non-null', async () => {
    const rule = makeRule({ field: 'title', operator: 'exists' });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('pass');
  });

  it('should fail when field is undefined', async () => {
    const rule = makeRule({ field: 'current_branch', operator: 'exists' });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('fail');
  });
});

describe('MetadataCheckRunner – not_exists operator', () => {
  it('should pass when field is undefined', async () => {
    const rule = makeRule({ field: 'current_branch', operator: 'not_exists' });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('pass');
  });

  it('should fail when field exists', async () => {
    const rule = makeRule({ field: 'title', operator: 'not_exists' });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('fail');
  });
});

describe('MetadataCheckRunner – contains operator', () => {
  it('should pass when string field contains expected substring', async () => {
    const rule = makeRule({ field: 'title', operator: 'contains', expected_value: 'Test' });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('pass');
  });

  it('should fail when string field does not contain substring', async () => {
    const rule = makeRule({ field: 'title', operator: 'contains', expected_value: 'ZZZZZ' });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('fail');
  });

  it('should fail when field is not a string', async () => {
    const rule = makeRule({ field: 'decision_ready', operator: 'contains', expected_value: 'true' });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('fail');
  });
});

describe('MetadataCheckRunner – in operator', () => {
  it('should pass when field value is in the expected array', async () => {
    const rule = makeRule({ field: 'risk_level', operator: 'in', expected_value: ['low', 'medium', 'high'] });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('pass');
  });

  it('should fail when field value is not in the expected array', async () => {
    const rule = makeRule({ field: 'risk_level', operator: 'in', expected_value: ['low', 'critical'] });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('fail');
  });
});

describe('MetadataCheckRunner – edge cases', () => {
  it('should return not_applicable when field config is missing', async () => {
    const rule = makeRule({ operator: 'equals', expected_value: 'x' });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('not_applicable');
  });

  it('should return not_applicable when operator config is missing', async () => {
    const rule = makeRule({ field: 'title' });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('not_applicable');
  });

  it('should return not_applicable for unknown operator', async () => {
    const rule = makeRule({ field: 'title', operator: 'matches_regex', expected_value: '.*' });
    const result = await runner.evaluate(rule, makeContext());
    expect(result.result_status).toBe('not_applicable');
    expect(result.message).toContain('Unknown operator');
  });
});
