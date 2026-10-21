export type RuleCategory =
  | 'architecture_rule'
  | 'code_quality_rule'
  | 'test_rule'
  | 'integration_rule'
  | 'security_rule'
  | 'project_convention'
  | 'customer_constraint'
  | 'release_gate'
  | (string & {});

export type EvaluationMode =
  | 'metadata_check'
  | 'diff_pattern'
  | 'evidence_check'
  | 'llm_evaluation'
  | 'human_confirmation';

export type RuleStatus = 'active' | 'inactive' | 'draft';

export type RuleLayer = 'global' | 'project';

export interface RuleScope {
  layer: RuleLayer;
  ref: string;
}

export interface Rule {
  rule_id: string;
  name: string;
  category: RuleCategory;
  scope: RuleScope;
  evaluation_mode: EvaluationMode;
  severity_if_failed: string;
  config: Record<string, unknown>;
  description: string;
  rationale: string;
  status: RuleStatus;
  version: number;
  created_at: string;
  updated_at: string;
  /** Actor stamp for the most recent create/update (audit trail). */
  updated_by?: string;
}

export interface RuleSet {
  rule_set_id: string;
  name: string;
  description: string;
  project_id?: string;
  rule_refs: string[];
  status: RuleStatus;
  version: number;
  created_at: string;
  updated_at: string;
  /** Actor stamp for the most recent create/update (audit trail). */
  updated_by?: string;
}

export type RuleResultStatus = 'pass' | 'fail' | 'warning' | 'not_applicable' | 'blocked';

export interface RuleResult {
  rule_result_id: string;
  rule_id: string;
  case_id: string;
  run_id: string;
  result_status: RuleResultStatus;
  message: string;
  evidence_refs: string[];
  finding_ref?: string;
  evaluated_at: string;
}

/**
 * A human-confirmed decision that `overriding_rule_id` (typically a
 * project-scoped rule) is intentionally allowed to shadow `rule_id`
 * (typically the global rule it conflicts with) — see `RuleConflict` in
 * `services/rule/conflict-detector.ts` for how the pair is detected.
 *
 * Creating one resolves the matching `rule_override_conflict` Finding(s)
 * (see `RuleOverrideService.createOverride`) and permanently settles the
 * pair: future rule evaluations no longer re-flag it as a conflict.
 */
export interface RuleOverride {
  override_id: string;
  rule_id: string;
  overriding_rule_id: string;
  scope: RuleScope;
  rationale: string;
  /** Revision of the override record itself. Always 1 today (no update path). */
  version: number;
  /** `rule_id`'s `Rule.version` at the moment the override was created (audit snapshot). */
  rule_version: number;
  /** `overriding_rule_id`'s `Rule.version` at the moment the override was created (audit snapshot). */
  overriding_rule_version: number;
  created_by: string;
  created_at: string;
}

export interface CreateRuleOverrideInput {
  rule_id: string;
  overriding_rule_id: string;
  scope: RuleScope;
  rationale: string;
  /**
   * Optional: the specific `rule_override_conflict` Finding this override is
   * resolving (e.g. the courtroom "Confirm Override" button already knows
   * which finding triggered it). When supplied it is resolved directly, in
   * addition to any other still-open finding found for the same rule pair
   * (e.g. the same conflict re-detected on a different case).
   */
  finding_id?: string;
}
