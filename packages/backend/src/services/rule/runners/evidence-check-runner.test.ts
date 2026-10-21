import { describe, it, expect } from 'vitest';
import { EvidenceCheckRunner } from './evidence-check-runner.js';
import type { Rule, Case, Evidence } from '@arbitra/shared';
import type { RunnerContext } from './runner-interface.js';

function makeRule(requiredTypes?: string[]): Rule {
  return {
    rule_id: 'r1', name: 'evidence-rule', category: 'test_rule',
    scope: { layer: 'global', ref: 'global' }, evaluation_mode: 'evidence_check',
    severity_if_failed: 'high',
    config: requiredTypes ? { required_evidence_types: requiredTypes } : {},
    description: '', rationale: '', status: 'active', version: 1,
    created_at: '', updated_at: '',
  };
}

function makeEvidence(type: string, id?: string): Evidence {
  return {
    evidence_id: id ?? `ev_${type}`, case_id: 'case_1', type,
    source_type: 'automated', machine_readable: true,
    validation_track: 'direct', created_at: '', created_by: 'system',
  };
}

function makeContext(evidence: Evidence[]): RunnerContext {
  return {
    case_: {
      case_id: 'case_1', title: 'Test', description: '', source_type: 'manual',
      source_ref: '', project_id: 'p1', repository_id: 'r1', owner_user_id: 'usr_1',
      status: 'in_validation', validation_track: 'direct', risk_level: 'medium',
      priority: 'normal', active_rule_set_refs: [], knowledge_context_refs: [],
      decision_ready: false, created_at: '', updated_at: '',
    },
    evidence,
  };
}

const runner = new EvidenceCheckRunner();

describe('EvidenceCheckRunner – all evidence present', () => {
  it('should pass when all required evidence types are present', async () => {
    const rule = makeRule(['ci_result', 'unit_test_result']);
    const ctx = makeContext([
      makeEvidence('ci_result', 'ev_1'),
      makeEvidence('unit_test_result', 'ev_2'),
    ]);
    const result = await runner.evaluate(rule, ctx);
    expect(result.result_status).toBe('pass');
    expect(result.evidence_refs).toContain('ev_1');
    expect(result.evidence_refs).toContain('ev_2');
  });

  it('should pass with extra evidence beyond required', async () => {
    const rule = makeRule(['ci_result']);
    const ctx = makeContext([
      makeEvidence('ci_result', 'ev_1'),
      makeEvidence('lint_result', 'ev_2'),
      makeEvidence('screenshot', 'ev_3'),
    ]);
    const result = await runner.evaluate(rule, ctx);
    expect(result.result_status).toBe('pass');
    expect(result.evidence_refs).toEqual(['ev_1']);
  });
});

describe('EvidenceCheckRunner – missing evidence', () => {
  it('should fail when required evidence is missing', async () => {
    const rule = makeRule(['ci_result', 'unit_test_result', 'runtime_log']);
    const ctx = makeContext([makeEvidence('ci_result', 'ev_1')]);
    const result = await runner.evaluate(rule, ctx);
    expect(result.result_status).toBe('fail');
    expect(result.message).toContain('unit_test_result');
    expect(result.message).toContain('runtime_log');
  });

  it('should fail when no evidence is provided at all', async () => {
    const rule = makeRule(['ci_result']);
    const ctx = makeContext([]);
    const result = await runner.evaluate(rule, ctx);
    expect(result.result_status).toBe('fail');
    expect(result.message).toContain('ci_result');
    expect(result.evidence_refs).toHaveLength(0);
  });
});

describe('EvidenceCheckRunner – edge cases', () => {
  it('should return not_applicable when no required types configured', async () => {
    const rule = makeRule(undefined);
    const ctx = makeContext([makeEvidence('ci_result')]);
    const result = await runner.evaluate(rule, ctx);
    expect(result.result_status).toBe('not_applicable');
  });

  it('should return not_applicable when required types is empty array', async () => {
    const rule = makeRule([]);
    const ctx = makeContext([]);
    const result = await runner.evaluate(rule, ctx);
    expect(result.result_status).toBe('not_applicable');
  });

  it('should include matched evidence refs even when some are missing', async () => {
    const rule = makeRule(['ci_result', 'unit_test_result']);
    const ctx = makeContext([makeEvidence('ci_result', 'ev_ci')]);
    const result = await runner.evaluate(rule, ctx);
    expect(result.result_status).toBe('fail');
    expect(result.evidence_refs).toContain('ev_ci');
    expect(result.evidence_refs).not.toContain('ev_unit_test_result');
  });
});
