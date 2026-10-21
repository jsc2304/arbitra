import type { Rule } from '@arbitra/shared';
import type { RuleRunner, RunnerContext, RunnerResult } from './runner-interface.js';

export class HumanConfirmationRunner implements RuleRunner {
  async evaluate(rule: Rule, _ctx: RunnerContext): Promise<RunnerResult> {
    const config = rule.config as { confirmation_prompt?: string };

    // Human confirmation rules always produce "blocked" until human confirms
    return {
      result_status: 'blocked',
      message: config.confirmation_prompt ?? 'Human confirmation required',
      evidence_refs: [],
    };
  }
}
