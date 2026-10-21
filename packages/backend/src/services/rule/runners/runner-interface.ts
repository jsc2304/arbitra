import type { Rule, RuleResultStatus, Case, Evidence } from '@arbitra/shared';

export interface RunnerContext {
  case_: Case;
  evidence: Evidence[];
  diff?: string;
}

export interface RunnerResult {
  result_status: RuleResultStatus;
  message: string;
  evidence_refs: string[];
}

export interface RuleRunner {
  evaluate(rule: Rule, ctx: RunnerContext): Promise<RunnerResult>;
}
