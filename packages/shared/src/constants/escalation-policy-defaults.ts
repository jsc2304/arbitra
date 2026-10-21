import type { EvidencePolicy } from '../types/evidence.js';
import type { RiskLevel } from '../types/case.js';
import { RISK_LEVEL_ORDER } from './risk-levels.js';

/**
 * Built-in default escalation threshold (issue #987 / ADR-0001): an Observed
 * Case escalates into the full enforced lifecycle once its (re-)assessed
 * `risk_level` reaches `high` — i.e. `high` and `critical` escalate, `low`
 * and `medium` stay observed. Mirrors the existing hard block on
 * auto-approving high/critical risk (`preconditions.ts::auto_approve_criteria_met`)
 * — the same risk band that always required a human decision is the band
 * that always requires the full lifecycle to reach it.
 */
export const DEFAULT_ESCALATION_RISK_THRESHOLD: RiskLevel = 'high';

/**
 * Resolve the effective escalation risk threshold for a project's evidence
 * policy: the project's `escalation.risk_threshold` when the project has
 * authored one, else the built-in default. `policy` is `undefined` when the
 * project has no evidence-policy document at all (falls straight to
 * defaults, same fallback CompletenessEvaluator uses for evidence rules).
 */
export function resolveEscalationThreshold(policy: EvidencePolicy | undefined | null): RiskLevel {
  return policy?.escalation?.risk_threshold ?? DEFAULT_ESCALATION_RISK_THRESHOLD;
}

/** True iff `riskLevel` meets or exceeds `threshold` on the RiskLevel order. */
export function meetsEscalationThreshold(riskLevel: RiskLevel, threshold: RiskLevel): boolean {
  return RISK_LEVEL_ORDER[riskLevel] >= RISK_LEVEL_ORDER[threshold];
}
