import type { EvidencePolicyRule, EvidenceType } from '../types/evidence.js';
import type { RiskLevel } from '../types/case.js';

type TrackPolicyMap = Record<RiskLevel, EvidencePolicyRule>;

export const DEFAULT_DIRECT_TRACK_POLICY: TrackPolicyMap = {
  low: {
    required_evidence_types: ['ci_result'] satisfies EvidenceType[],
    optional_evidence_types: ['unit_test_result', 'lint_result', 'diff_snapshot'] satisfies EvidenceType[],
    four_eyes_required: false,
    allow_self_approval: false,
  },
  medium: {
    required_evidence_types: ['ci_result', 'unit_test_result'] satisfies EvidenceType[],
    optional_evidence_types: ['lint_result', 'runtime_log'] satisfies EvidenceType[],
    four_eyes_required: false,
    allow_self_approval: false,
  },
  high: {
    required_evidence_types: ['ci_result', 'unit_test_result', 'runtime_log'] satisfies EvidenceType[],
    optional_evidence_types: ['integration_test_result', 'lint_result'] satisfies EvidenceType[],
    four_eyes_required: true,
    allow_self_approval: false,
  },
  critical: {
    required_evidence_types: ['ci_result', 'unit_test_result', 'runtime_log', 'integration_test_result'] satisfies EvidenceType[],
    optional_evidence_types: ['lint_result'] satisfies EvidenceType[],
    four_eyes_required: true,
    allow_self_approval: false,
  },
};

export const DEFAULT_MANUAL_TRACK_POLICY: TrackPolicyMap = {
  low: {
    required_evidence_types: ['ci_result', 'manual_confirmation'] satisfies EvidenceType[],
    optional_evidence_types: ['unit_test_result', 'screenshot'] satisfies EvidenceType[],
    four_eyes_required: false,
    allow_self_approval: false,
  },
  medium: {
    required_evidence_types: ['ci_result', 'unit_test_result', 'manual_confirmation'] satisfies EvidenceType[],
    optional_evidence_types: ['screenshot', 'runtime_log'] satisfies EvidenceType[],
    four_eyes_required: false,
    allow_self_approval: false,
  },
  high: {
    required_evidence_types: ['ci_result', 'unit_test_result', 'runtime_log', 'screenshot', 'manual_confirmation'] satisfies EvidenceType[],
    optional_evidence_types: ['integration_test_result'] satisfies EvidenceType[],
    four_eyes_required: true,
    allow_self_approval: false,
  },
  critical: {
    required_evidence_types: ['ci_result', 'unit_test_result', 'runtime_log', 'screenshot', 'manual_confirmation'] satisfies EvidenceType[],
    optional_evidence_types: ['integration_test_result'] satisfies EvidenceType[],
    four_eyes_required: true,
    allow_self_approval: false,
  },
};

export function getDefaultPolicyRule(
  track: 'direct' | 'manual',
  riskLevel: RiskLevel,
): EvidencePolicyRule {
  const policy = track === 'direct' ? DEFAULT_DIRECT_TRACK_POLICY : DEFAULT_MANUAL_TRACK_POLICY;
  return policy[riskLevel];
}
