import type { Rule } from '@arbitra/shared';
import type { RuleRunner, RunnerContext, RunnerResult } from './runner-interface.js';

export class EvidenceCheckRunner implements RuleRunner {
  async evaluate(rule: Rule, ctx: RunnerContext): Promise<RunnerResult> {
    const config = rule.config as {
      required_evidence_types?: string[];
    };

    if (!config.required_evidence_types || config.required_evidence_types.length === 0) {
      return {
        result_status: 'not_applicable',
        message: 'Evidence check rule has no required types configured',
        evidence_refs: [],
      };
    }

    const presentTypes = new Set(ctx.evidence.map((e) => e.type));
    const missing = config.required_evidence_types.filter((t) => !presentTypes.has(t));

    const matchedEvidence = ctx.evidence
      .filter((e) => config.required_evidence_types!.includes(e.type))
      .map((e) => e.evidence_id);

    if (missing.length > 0) {
      return {
        result_status: 'fail',
        message: `Missing required evidence types: ${missing.join(', ')}`,
        evidence_refs: matchedEvidence,
      };
    }

    return {
      result_status: 'pass',
      message: `All required evidence types present: ${config.required_evidence_types.join(', ')}`,
      evidence_refs: matchedEvidence,
    };
  }
}
