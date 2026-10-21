/**
 * Starter Rule Set — Low-friction, advisory rules for onboarding.
 *
 * Design principles:
 * - severity_if_failed is 'low' or 'medium' — warnings, not blockers
 * - Rules guide teams toward best practices without gate-keeping
 * - Cover multiple evaluation modes to demonstrate the Rule Engine's capabilities
 */

import type { Rule, RuleSet } from '../types/rule.js';

const now = new Date().toISOString();

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------

export const STARTER_RULES: Rule[] = [
  {
    rule_id: 'rule_evidence_required',
    name: 'CI evidence present',
    category: 'release_gate',
    scope: { layer: 'global', ref: 'global' },
    evaluation_mode: 'evidence_check',
    severity_if_failed: 'medium',
    config: { required_evidence_types: ['ci_result'] },
    description: 'Checks that at least a CI result is attached before a case can proceed to approval.',
    rationale: 'Every change should pass CI. This is the minimum bar.',
    status: 'active',
    version: 1,
    created_at: now,
    updated_at: now,
  },
  {
    rule_id: 'rule_description_present',
    name: 'Case description filled in',
    category: 'code_quality_rule',
    scope: { layer: 'global', ref: 'global' },
    evaluation_mode: 'metadata_check',
    severity_if_failed: 'low',
    config: { field: 'description', operator: 'exists' },
    description: 'Warns when a case has no description. Helps reviewers understand the context.',
    rationale: 'A brief description accelerates reviews and creates better audit trails.',
    status: 'active',
    version: 1,
    created_at: now,
    updated_at: now,
  },
  {
    rule_id: 'rule_no_console_log',
    name: 'No console.log in diff',
    category: 'code_quality_rule',
    scope: { layer: 'global', ref: 'global' },
    evaluation_mode: 'diff_pattern',
    severity_if_failed: 'low',
    config: { pattern: '\\+.*console\\.log\\(' },
    description: 'Flags added console.log statements in the diff. Consider using a proper logger.',
    rationale: 'Debug logs in production code create noise and may leak sensitive data.',
    status: 'active',
    version: 1,
    created_at: now,
    updated_at: now,
  },
  {
    rule_id: 'rule_no_todo_fixme',
    name: 'No TODO/FIXME in diff',
    category: 'code_quality_rule',
    scope: { layer: 'global', ref: 'global' },
    evaluation_mode: 'diff_pattern',
    severity_if_failed: 'low',
    config: { pattern: '\\+.*(TODO|FIXME|HACK|XXX)' },
    description: 'Flags new TODO/FIXME comments added in the diff. Track these as separate tasks instead.',
    rationale: 'TODOs tend to accumulate. Better to create a ticket and fix immediately or defer explicitly.',
    status: 'active',
    version: 1,
    created_at: now,
    updated_at: now,
  },
  {
    rule_id: 'rule_risk_level_set',
    name: 'Risk level explicitly set',
    category: 'project_convention',
    scope: { layer: 'global', ref: 'global' },
    evaluation_mode: 'metadata_check',
    severity_if_failed: 'low',
    config: { field: 'risk_level', operator: 'exists' },
    description: 'Ensures the case has an explicit risk level rather than relying on defaults.',
    rationale: 'Explicit risk assessment drives the right level of review and evidence requirements.',
    status: 'active',
    version: 1,
    created_at: now,
    updated_at: now,
  },
  {
    rule_id: 'rule_no_secrets_in_diff',
    name: 'No secrets or keys in diff',
    category: 'security_rule',
    scope: { layer: 'global', ref: 'global' },
    evaluation_mode: 'diff_pattern',
    severity_if_failed: 'medium',
    config: { pattern: '\\+.*(api_key|apikey|secret_key|password|PRIVATE_KEY)\\s*[:=]\\s*["\'][^"\']{8,}' },
    description: 'Flags potential secrets, API keys, or passwords added in the diff.',
    rationale: 'Secrets in source code are a top security risk. Use environment variables or secret managers instead.',
    status: 'active',
    version: 1,
    created_at: now,
    updated_at: now,
  },
];

// ---------------------------------------------------------------------------
// Rule Set referencing all starter rules
// ---------------------------------------------------------------------------

export const STARTER_RULE_SET: RuleSet = {
  rule_set_id: 'rs_starter',
  name: 'Starter Rule Set',
  description: 'Low-friction advisory rules for onboarding. Flags common issues without blocking. Customize or extend per project.',
  rule_refs: STARTER_RULES.map((r) => r.rule_id),
  status: 'active',
  version: 1,
  created_at: now,
  updated_at: now,
};
