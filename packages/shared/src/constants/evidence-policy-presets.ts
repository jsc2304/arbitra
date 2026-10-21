import type { EvidencePolicyRule, EvidencePolicyRulesMap, EvidenceType } from '../types/evidence.js';
import type { RiskLevel, ValidationTrack } from '../types/case.js';
import {
  DEFAULT_DIRECT_TRACK_POLICY,
  DEFAULT_MANUAL_TRACK_POLICY,
} from './evidence-policy-defaults.js';

/**
 * Evidence-policy capability flags for a project/repository.
 *
 * Some repos legitimately cannot ever produce certain evidence:
 *  - A repository with no unit-test harness and no CI pipeline —
 *    `gh pr checks` returns no checks, so `ci_result` can NEVER
 *    arrive and a case can never reach build-complete on the default policy.
 *  - Prototype and throwaway repositories frequently have no CI wired at all.
 *
 * These flags let such a project DECLARE its capabilities so the required
 * evidence set is adjusted to what the repo can actually emit — instead of
 * forcing manual, per-cell policy surgery in the UI.
 *
 * Both default to `true` (the historical behaviour: CI and unit tests are
 * expected and required wherever the default policy required them).
 */
export interface EvidenceCapabilityFlags {
  /** Repo has a CI pipeline that produces `ci_result`. Default true. */
  ci_available?: boolean;
  /** Repo has a unit-test harness that produces `unit_test_result`. Default true. */
  unit_tests_available?: boolean;
}

/**
 * Named presets that expand to a set of {@link EvidenceCapabilityFlags}.
 * `no_ci_no_unit` is the canonical preset for repositories without CI or unit tests.
 */
export const EVIDENCE_POLICY_PRESETS = {
  /** Repo has neither CI nor a unit-test harness (a repository without CI or unit tests). */
  no_ci_no_unit: { ci_available: false, unit_tests_available: false },
  /** Repo has a unit-test harness but no CI pipeline. */
  no_ci: { ci_available: false, unit_tests_available: true },
  /** Repo has CI but no unit-test harness. */
  no_unit: { ci_available: true, unit_tests_available: false },
} as const satisfies Record<string, EvidenceCapabilityFlags>;

export type EvidencePolicyPresetName = keyof typeof EVIDENCE_POLICY_PRESETS;

/**
 * Resolve a preset name (or raw flags) to a concrete {@link EvidenceCapabilityFlags}
 * object with both fields defaulted to `true` (CI + unit tests available).
 */
export function resolveCapabilityFlags(
  presetOrFlags: EvidencePolicyPresetName | EvidenceCapabilityFlags,
): Required<EvidenceCapabilityFlags> {
  const flags =
    typeof presetOrFlags === 'string'
      ? EVIDENCE_POLICY_PRESETS[presetOrFlags]
      : presetOrFlags;
  return {
    ci_available: flags.ci_available ?? true,
    unit_tests_available: flags.unit_tests_available ?? true,
  };
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

/**
 * Apply capability flags to a single policy rule.
 *
 * GOVERNANCE TRADE-OFF (intentional, documented):
 * When `ci_result` and/or `unit_test_result` are removed from the REQUIRED set
 * because the repo cannot produce them, we do NOT silently weaken the gate. We
 * substitute an explicit human/agent attestation so an evidence gate still
 * exists:
 *  - `manual_confirmation` is ADDED to required (so a case still needs a
 *    deliberate "I verified this" signal before it can reach build-complete).
 *  - `lint_result` is offered as an acceptable alternative in the OPTIONAL set
 *    (lint is cheap and usually available even without CI/unit harness).
 *
 * Dropped types are removed from both required and optional (they can never be
 * produced, so listing them as optional would be misleading). All other types
 * the rule required/offered are preserved.
 */
export function applyCapabilityFlagsToRule(
  rule: EvidencePolicyRule,
  presetOrFlags: EvidencePolicyPresetName | EvidenceCapabilityFlags,
): EvidencePolicyRule {
  const { ci_available, unit_tests_available } = resolveCapabilityFlags(presetOrFlags);

  // Nothing to drop → return the rule unchanged (preserves identity-ish
  // behaviour and keeps "no preset" a true no-op).
  if (ci_available && unit_tests_available) {
    return rule;
  }

  const dropped = new Set<EvidenceType>();
  if (!ci_available) dropped.add('ci_result');
  if (!unit_tests_available) dropped.add('unit_test_result');

  let required = rule.required_evidence_types.filter((t) => !dropped.has(t));
  let optional = rule.optional_evidence_types.filter((t) => !dropped.has(t));

  // Did this rule actually require any of the dropped types? Only substitute a
  // manual gate when we removed a *required* governance signal. A cell that
  // merely listed ci_result as optional keeps its existing required set.
  const removedARequiredSignal = rule.required_evidence_types.some((t) => dropped.has(t));

  if (removedARequiredSignal) {
    // Substitute an explicit attestation so the gate is not silently weakened.
    required = unique([...required, 'manual_confirmation' satisfies EvidenceType]);
    // Offer lint as an acceptable, repo-available alternative signal.
    if (!required.includes('lint_result')) {
      optional = unique([...optional, 'lint_result' satisfies EvidenceType]);
    }
  }

  return {
    ...rule,
    required_evidence_types: required,
    optional_evidence_types: optional,
  };
}

const TRACKS: ValidationTrack[] = ['direct', 'manual'];
const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

/**
 * Build a full {@link EvidencePolicyRulesMap} (risk-first, track-second — the
 * shape the resolver in `completeness-evaluator.ts` reads and the editor
 * persists) by applying capability flags to every default cell.
 *
 * The result is a normal evidence-policy document body that can be stored via
 * the existing `evidencePolicies` mechanism (POST /api/evidence-policies or the
 * `apply-evidence-policy-preset` script). No new storage concept is introduced.
 */
export function buildPolicyRulesFromPreset(
  presetOrFlags: EvidencePolicyPresetName | EvidenceCapabilityFlags,
): EvidencePolicyRulesMap {
  const rules: EvidencePolicyRulesMap = {};
  for (const risk of RISK_LEVELS) {
    rules[risk] = {};
    for (const track of TRACKS) {
      const base =
        track === 'direct'
          ? DEFAULT_DIRECT_TRACK_POLICY[risk]
          : DEFAULT_MANUAL_TRACK_POLICY[risk];
      rules[risk]![track] = applyCapabilityFlagsToRule(base, presetOrFlags);
    }
  }
  return rules;
}
