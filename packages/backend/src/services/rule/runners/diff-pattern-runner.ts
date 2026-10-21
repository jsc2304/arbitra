import type { Rule } from '@arbitra/shared';
import type { RuleRunner, RunnerContext, RunnerResult } from './runner-interface.js';

export class DiffPatternRunner implements RuleRunner {
  async evaluate(rule: Rule, ctx: RunnerContext): Promise<RunnerResult> {
    const config = rule.config as {
      pattern?: string;
      target_files?: string;
      exclude_files?: string;
    };

    if (!config.pattern) {
      return {
        result_status: 'not_applicable',
        message: 'Diff pattern rule missing pattern config',
        evidence_refs: [],
      };
    }

    if (!ctx.diff) {
      return {
        result_status: 'not_applicable',
        message: 'No diff available for pattern check',
        evidence_refs: [],
      };
    }

    try {
      const regex = new RegExp(config.pattern, 'gm');
      const matches = ctx.diff.match(regex);

      if (matches && matches.length > 0) {
        return {
          result_status: 'fail',
          message: `Pattern "${config.pattern}" matched ${matches.length} time(s) in diff`,
          evidence_refs: [],
        };
      }

      return {
        result_status: 'pass',
        message: `Pattern "${config.pattern}" not found in diff`,
        evidence_refs: [],
      };
    } catch {
      return {
        result_status: 'blocked',
        message: `Invalid regex pattern: ${config.pattern}`,
        evidence_refs: [],
      };
    }
  }
}
