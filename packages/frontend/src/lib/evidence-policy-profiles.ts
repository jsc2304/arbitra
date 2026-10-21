/**
 * Pre-defined starting profiles for the evidence-policy editor.
 *
 * Each profile is a fully-materialized `(risk × track) → EvidencePolicyRule`
 * map. The picker in `edit-policy-modal.tsx` uses these to seed a sensible
 * starting state and to detect which profile (if any) the live policy
 * matches against, so users always see a meaningful label instead of a
 * blank "custom" state.
 *
 * IMPORTANT: profile cell shapes must use only evidence-type identifiers
 * that already exist in `@arbitra/shared`'s
 * `evidence-policy-defaults.ts`. New identifiers go in shared first.
 */

import type {
  EvidencePolicyRule,
  EvidencePolicyRulesMap,
  EvidenceType,
} from '@arbitra/shared';
import {
  DEFAULT_DIRECT_TRACK_POLICY,
  DEFAULT_MANUAL_TRACK_POLICY,
  getDefaultPolicyRule,
} from '@arbitra/shared';

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
const TRACKS = ['direct', 'manual'] as const;

type RiskLevel = (typeof RISK_LEVELS)[number];
type Track = (typeof TRACKS)[number];

export const PROFILE_IDS = [
  'fast-iteration',
  'balanced',
  'strict-regulated',
  'custom',
] as const;
export type EvidencePolicyProfileId = (typeof PROFILE_IDS)[number];

export interface EvidencePolicyProfile {
  id: EvidencePolicyProfileId;
  display_name: string;
  one_liner: string;
  /**
   * Fully materialized rules map for non-custom profiles. `custom` carries
   * an empty object — it is a sentinel state, not a preset to apply.
   */
  rules: EvidencePolicyRulesMap;
}

type FullRulesMap = Record<RiskLevel, Record<Track, EvidencePolicyRule>>;

function buildPairTrack(
  direct: EvidencePolicyRule,
  manual: EvidencePolicyRule,
): Record<Track, EvidencePolicyRule> {
  return { direct, manual };
}

function deepCopyRule(rule: EvidencePolicyRule): EvidencePolicyRule {
  return {
    required_evidence_types: [...rule.required_evidence_types],
    optional_evidence_types: [...rule.optional_evidence_types],
    four_eyes_required: rule.four_eyes_required,
    allow_self_approval: rule.allow_self_approval,
  };
}

function deepCopyFullRules(rules: FullRulesMap): EvidencePolicyRulesMap {
  const out: EvidencePolicyRulesMap = {};
  for (const risk of RISK_LEVELS) {
    out[risk] = {
      direct: deepCopyRule(rules[risk].direct),
      manual: deepCopyRule(rules[risk].manual),
    };
  }
  return out;
}

/**
 * Build a fully-materialized rules map populated from
 * `getDefaultPolicyRule()` for every (risk × track) cell. Used as the
 * fall-through baseline when comparing a partially-populated stored policy
 * against the profile shapes.
 */
export function buildDefaultRulesMap(): EvidencePolicyRulesMap {
  const out: EvidencePolicyRulesMap = {};
  for (const risk of RISK_LEVELS) {
    out[risk] = {
      direct: deepCopyRule(getDefaultPolicyRule('direct', risk)),
      manual: deepCopyRule(getDefaultPolicyRule('manual', risk)),
    };
  }
  return out;
}

// Fast iteration = mirror of the existing Default Direct Track shape on
// both tracks. The Manual track in this profile uses the same Direct
// shape as the Direct track, because the profile says "fast iteration
// regardless of track choice" — the direct shape is intentionally the
// looser one.
const FAST_ITERATION_RULES: FullRulesMap = {
  low: buildPairTrack(
    deepCopyRule(DEFAULT_DIRECT_TRACK_POLICY.low),
    deepCopyRule(DEFAULT_DIRECT_TRACK_POLICY.low),
  ),
  medium: buildPairTrack(
    deepCopyRule(DEFAULT_DIRECT_TRACK_POLICY.medium),
    deepCopyRule(DEFAULT_DIRECT_TRACK_POLICY.medium),
  ),
  high: buildPairTrack(
    deepCopyRule(DEFAULT_DIRECT_TRACK_POLICY.high),
    deepCopyRule(DEFAULT_DIRECT_TRACK_POLICY.high),
  ),
  critical: buildPairTrack(
    deepCopyRule(DEFAULT_DIRECT_TRACK_POLICY.critical),
    deepCopyRule(DEFAULT_DIRECT_TRACK_POLICY.critical),
  ),
};

// Balanced = Direct shape for the direct track, Manual shape for the
// manual track. Matches the system defaults exactly: direct track is
// tooling-driven, manual track adds manual_confirmation + screenshot.
const BALANCED_RULES: FullRulesMap = {
  low: buildPairTrack(
    deepCopyRule(DEFAULT_DIRECT_TRACK_POLICY.low),
    deepCopyRule(DEFAULT_MANUAL_TRACK_POLICY.low),
  ),
  medium: buildPairTrack(
    deepCopyRule(DEFAULT_DIRECT_TRACK_POLICY.medium),
    deepCopyRule(DEFAULT_MANUAL_TRACK_POLICY.medium),
  ),
  high: buildPairTrack(
    deepCopyRule(DEFAULT_DIRECT_TRACK_POLICY.high),
    deepCopyRule(DEFAULT_MANUAL_TRACK_POLICY.high),
  ),
  critical: buildPairTrack(
    deepCopyRule(DEFAULT_DIRECT_TRACK_POLICY.critical),
    deepCopyRule(DEFAULT_MANUAL_TRACK_POLICY.critical),
  ),
};

// Strict regulated = upper bound. Required at every level: ci_result,
// unit_test_result, integration_test_result, manual_confirmation. Add
// screenshot at high/critical. four_eyes_required everywhere. No self-approval.
function strictCell(risk: RiskLevel): EvidencePolicyRule {
  const baseRequired: EvidenceType[] = [
    'ci_result',
    'unit_test_result',
    'integration_test_result',
    'manual_confirmation',
  ];
  const requiredHighRisk: EvidenceType[] = [...baseRequired, 'screenshot'];
  return {
    required_evidence_types:
      risk === 'high' || risk === 'critical' ? requiredHighRisk : baseRequired,
    optional_evidence_types: ['lint_result', 'runtime_log'],
    four_eyes_required: true,
    allow_self_approval: false,
  };
}

const STRICT_REGULATED_RULES: FullRulesMap = {
  low: buildPairTrack(strictCell('low'), strictCell('low')),
  medium: buildPairTrack(strictCell('medium'), strictCell('medium')),
  high: buildPairTrack(strictCell('high'), strictCell('high')),
  critical: buildPairTrack(strictCell('critical'), strictCell('critical')),
};

export const PROFILES: Record<EvidencePolicyProfileId, EvidencePolicyProfile> = {
  'fast-iteration': {
    id: 'fast-iteration',
    display_name: 'Fast iteration',
    one_liner:
      'Lean ceremony for prototyping and exploratory work — automated checks only, four-eyes only at high/critical.',
    rules: deepCopyFullRules(FAST_ITERATION_RULES),
  },
  balanced: {
    id: 'balanced',
    display_name: 'Balanced',
    one_liner:
      'Default mix — automated checks on direct track, plus manual confirmation on the manual track. Most teams start here.',
    rules: deepCopyFullRules(BALANCED_RULES),
  },
  'strict-regulated': {
    id: 'strict-regulated',
    display_name: 'Strict regulated',
    one_liner:
      'Maximum evidence and four-eyes at every risk level — for audited, compliance-bound, or production-critical environments.',
    rules: deepCopyFullRules(STRICT_REGULATED_RULES),
  },
  custom: {
    id: 'custom',
    display_name: 'Custom',
    one_liner: 'No matching preset — your policy has been tuned by hand.',
    rules: {},
  },
};

function rulesEqual(a: EvidencePolicyRule, b: EvidencePolicyRule): boolean {
  if (a.four_eyes_required !== b.four_eyes_required) return false;
  if ((a.allow_self_approval ?? false) !== (b.allow_self_approval ?? false))
    return false;
  if (
    a.required_evidence_types.length !== b.required_evidence_types.length ||
    a.optional_evidence_types.length !== b.optional_evidence_types.length
  ) {
    return false;
  }
  const reqA = [...a.required_evidence_types].sort();
  const reqB = [...b.required_evidence_types].sort();
  if (reqA.some((v, i) => v !== reqB[i])) return false;
  const optA = [...a.optional_evidence_types].sort();
  const optB = [...b.optional_evidence_types].sort();
  if (optA.some((v, i) => v !== optB[i])) return false;
  return true;
}

function fullRulesEqual(
  a: EvidencePolicyRulesMap,
  b: EvidencePolicyRulesMap,
  defaults: EvidencePolicyRulesMap,
): boolean {
  for (const risk of RISK_LEVELS) {
    for (const track of TRACKS) {
      // Empty/missing cells fall through to system defaults — that lets
      // a stored policy that has only customized one cell still match
      // a profile whose other cells equal the default shape.
      const aCell = a[risk]?.[track] ?? defaults[risk]?.[track];
      const bCell = b[risk]?.[track] ?? defaults[risk]?.[track];
      if (!aCell || !bCell) return false;
      if (!rulesEqual(aCell, bCell)) return false;
    }
  }
  return true;
}

/**
 * Pure auto-detect: returns the profile id whose materialized rules deep-equal
 * the input `rules` after empty cells have been substituted with the system
 * default for that (risk × track). Returns `'custom'` when no preset matches.
 *
 * Order is "first match wins" — but profile shapes are mutually exclusive by
 * construction, so the order doesn't change the outcome for any non-custom
 * input.
 */
export function detectProfile(
  rules: EvidencePolicyRulesMap,
  defaultRulesMap: EvidencePolicyRulesMap,
): EvidencePolicyProfileId {
  for (const id of ['fast-iteration', 'balanced', 'strict-regulated'] as const) {
    if (fullRulesEqual(rules, PROFILES[id].rules, defaultRulesMap)) {
      return id;
    }
  }
  return 'custom';
}
