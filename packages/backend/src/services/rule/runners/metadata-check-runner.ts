import type { Rule } from '@arbitra/shared';
import type { RuleRunner, RunnerContext, RunnerResult } from './runner-interface.js';

export class MetadataCheckRunner implements RuleRunner {
  async evaluate(rule: Rule, ctx: RunnerContext): Promise<RunnerResult> {
    const config = rule.config as {
      field?: string;
      operator?: string;
      expected_value?: unknown;
    };

    if (!config.field || !config.operator) {
      return {
        result_status: 'not_applicable',
        message: 'Metadata check missing field or operator config',
        evidence_refs: [],
      };
    }

    // Access the field from the case object
    const caseRecord = ctx.case_ as unknown as Record<string, unknown>;
    const actualValue = caseRecord[config.field];

    let passed = false;
    switch (config.operator) {
      case 'equals':
        passed = actualValue === config.expected_value;
        break;
      case 'not_equals':
        passed = actualValue !== config.expected_value;
        break;
      case 'exists':
        passed = actualValue !== undefined && actualValue !== null;
        break;
      case 'not_exists':
        passed = actualValue === undefined || actualValue === null;
        break;
      case 'contains':
        passed = typeof actualValue === 'string' && actualValue.includes(String(config.expected_value));
        break;
      case 'in':
        passed = Array.isArray(config.expected_value) && config.expected_value.includes(actualValue);
        break;
      default:
        return {
          result_status: 'not_applicable',
          message: `Unknown operator: ${config.operator}`,
          evidence_refs: [],
        };
    }

    return {
      result_status: passed ? 'pass' : 'fail',
      message: passed
        ? `Metadata check passed: ${config.field} ${config.operator} ${JSON.stringify(config.expected_value)}`
        : `Metadata check failed: ${config.field}=${JSON.stringify(actualValue)}, expected ${config.operator} ${JSON.stringify(config.expected_value)}`,
      evidence_refs: [],
    };
  }
}
