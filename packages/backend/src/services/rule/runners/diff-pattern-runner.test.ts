import { describe, it, expect } from 'vitest';
import { DiffPatternRunner } from './diff-pattern-runner.js';
import type { Rule, Case } from '@arbitra/shared';
import type { RunnerContext } from './runner-interface.js';

function makeRule(config: Record<string, unknown>): Rule {
  return {
    rule_id: 'r1', name: 'diff-rule', category: 'security_rule',
    scope: { layer: 'global', ref: 'global' }, evaluation_mode: 'diff_pattern',
    severity_if_failed: 'high', config, description: '', rationale: '',
    status: 'active', version: 1, created_at: '', updated_at: '',
  };
}

function makeContext(diff?: string): RunnerContext {
  return {
    case_: {
      case_id: 'case_1', title: 'Test', description: '', source_type: 'manual',
      source_ref: '', project_id: 'p1', repository_id: 'r1', owner_user_id: 'usr_1',
      status: 'in_validation', validation_track: 'direct', risk_level: 'medium',
      priority: 'normal', active_rule_set_refs: [], knowledge_context_refs: [],
      decision_ready: false, created_at: '', updated_at: '',
    },
    evidence: [],
    diff,
  };
}

const runner = new DiffPatternRunner();

describe('DiffPatternRunner – pattern matching', () => {
  it('should fail (match found) when diff contains the pattern', async () => {
    const rule = makeRule({ pattern: 'console\\.log' });
    const ctx = makeContext('+ console.log("debug info");');
    const result = await runner.evaluate(rule, ctx);
    expect(result.result_status).toBe('fail');
    expect(result.message).toContain('matched 1 time(s)');
  });

  it('should pass when diff does not contain the pattern', async () => {
    const rule = makeRule({ pattern: 'console\\.log' });
    const ctx = makeContext('+ logger.info("proper logging");');
    const result = await runner.evaluate(rule, ctx);
    expect(result.result_status).toBe('pass');
  });

  it('should count multiple matches', async () => {
    const rule = makeRule({ pattern: 'TODO' });
    const ctx = makeContext('+ // TODO: fix this\n+ // TODO: refactor\n+ // TODO: test');
    const result = await runner.evaluate(rule, ctx);
    expect(result.result_status).toBe('fail');
    expect(result.message).toContain('matched 3 time(s)');
  });

  it('should support multiline matching with gm flags', async () => {
    const rule = makeRule({ pattern: '^\\+.*password' });
    const diff = `--- a/config.ts
+++ b/config.ts
+ const password = "secret123";
  const host = "localhost";`;
    const result = await runner.evaluate(rule, makeContext(diff));
    expect(result.result_status).toBe('fail');
  });

  it('should return not_applicable with empty string diff (falsy)', async () => {
    const rule = makeRule({ pattern: 'secret' });
    const ctx = makeContext('');
    const result = await runner.evaluate(rule, ctx);
    // Empty string is falsy in JS, so !ctx.diff is true
    expect(result.result_status).toBe('not_applicable');
  });
});

describe('DiffPatternRunner – missing input', () => {
  it('should return not_applicable when no pattern configured', async () => {
    const rule = makeRule({});
    const result = await runner.evaluate(rule, makeContext('some diff'));
    expect(result.result_status).toBe('not_applicable');
    expect(result.message).toContain('missing pattern');
  });

  it('should return not_applicable when no diff available', async () => {
    const rule = makeRule({ pattern: 'test' });
    const ctx = makeContext(undefined);
    const result = await runner.evaluate(rule, ctx);
    expect(result.result_status).toBe('not_applicable');
    expect(result.message).toContain('No diff available');
  });
});

describe('DiffPatternRunner – invalid regex', () => {
  it('should return blocked for invalid regex pattern', async () => {
    const rule = makeRule({ pattern: '[invalid(' });
    const ctx = makeContext('some diff content');
    const result = await runner.evaluate(rule, ctx);
    expect(result.result_status).toBe('blocked');
    expect(result.message).toContain('Invalid regex');
  });
});
