import type { ActorMetadata } from './actor-metadata.js';
import type { RiskLevel, ValidationTrack } from './case.js';

/**
 * Canonical, system-recognized evidence types — the single source of truth for
 * the named members of {@link EvidenceType}. Boundaries that accept evidence
 * from an external caller (e.g. the agent build-complete inline-evidence path)
 * validate against this tuple so a non-canonical `type` is rejected at the edge
 * instead of being silently registered-then-ignored by completeness evaluation.
 *
 * NOTE: this is intentionally NOT the universe of *all* legal evidence types —
 * policy authors may declare custom required/optional types (the open
 * `(string & {})` arm of `EvidenceType` exists for that), and webhooks/system
 * paths emit `pr_merged` / `detection_report`. Keep this list to the types an
 * IDE agent can legitimately submit inline.
 */
export const CANONICAL_EVIDENCE_TYPES = [
  'unit_test_result',
  'integration_test_result',
  'ci_result',
  'lint_result',
  'runtime_log',
  'screenshot',
  'diff_snapshot',
  'manual_confirmation',
  'benchmark_result',
  'external_reference',
  'pr_merged',
  'detection_report',
] as const;

export type CanonicalEvidenceType = (typeof CANONICAL_EVIDENCE_TYPES)[number];

export type EvidenceType = CanonicalEvidenceType | (string & {});

export type EvidenceSourceType = 'automated' | 'manual' | 'webhook' | 'agent';

export interface Evidence {
  evidence_id: string;
  case_id: string;
  run_id?: string;
  type: EvidenceType;
  source_type: EvidenceSourceType;
  artifact_ref?: string;
  summary?: string;
  machine_readable: boolean;
  validation_track: string;
  created_at: string;
  created_by: string;
  /**
   * Authoritative client/model signature when the evidence is registered by
   * an IDE agent. Populated by the MCP client on the API call. All fields
   * optional.
   */
  actor_metadata?: ActorMetadata;
  /**
   * Repeat counter for evidence types that dedupe on
   * `(case_id, type, artifact_ref)`. Currently set only by `file_edit`
   * evidence (Cursor `afterFileEdit` hook), where Cursor saves can
   * produce many rows in seconds. Defaults to 1 on first create and
   * increments on every dedupe-match. Other evidence types do not
   * dedupe and leave this field unset.
   */
  edit_count?: number;
  /**
   * Last time a dedupe-match updated this evidence row. Set together
   * with `edit_count` increments. Absent on rows that have never been
   * deduped.
   */
  updated_at?: string;
}

export interface CreateEvidenceInput {
  case_id: string;
  run_id?: string;
  type: EvidenceType;
  source_type: EvidenceSourceType;
  artifact_ref?: string;
  summary?: string;
  machine_readable?: boolean;
  actor_metadata?: ActorMetadata;
}

export interface EvidencePolicyRule {
  required_evidence_types: EvidenceType[];
  optional_evidence_types: EvidenceType[];
  four_eyes_required: boolean;
  /**
   * When true, the case owner is permitted to approve or confirm their own case's gate
   * for this risk/track cell. Default false (anti-gaming).
   */
  allow_self_approval: boolean;
  /**
   * Explicit "this cell deliberately requires no evidence" intent — distinct
   * from simply not authoring the cell (which inherits the built-in default
   * rule; see `completeness-evaluator.ts::getEffectivePolicy`). Only this
   * flag makes an empty `required_evidence_types` a real decision instead of
   * indistinguishable-from-an-unfinished-edit; the write boundary
   * (`evidencePolicyRuleSchema` in `evidence-validators.ts`) rejects an empty
   * `required_evidence_types` unless this is `true`, and rejects it being
   * `true` together with a non-empty `required_evidence_types` (contradiction).
   * Optional — legacy documents written before this field existed don't have
   * it; see `classifyPolicyCell` in `utils/evidence-policy-rules.ts` for how
   * that legacy shape is read.
   */
  requires_no_evidence?: boolean;
}

/**
 * Policy rules are stored **risk-first, track-second**:
 * `rules[risk_level][validation_track] → EvidencePolicyRule`.
 *
 * This matches what the editor (`edit-policy-modal.tsx`) persists and what
 * exists in Firestore. A mismatch with the resolver used to silently drop all
 * customer customizations back to defaults — see
 * `completeness-evaluator.ts::getEffectivePolicyRule`. Keep readers aligned.
 */
export type EvidencePolicyRulesMap = Partial<
  Record<RiskLevel, Partial<Record<ValidationTrack, EvidencePolicyRule>>>
>;

export interface EvidencePolicy {
  policy_id: string;
  project_id: string;
  repository_id?: string;
  rules: EvidencePolicyRulesMap;
  version: number;
  created_at: string;
  updated_at: string;
  /**
   * Escalation policy for Observed Cases (issue #987 / ADR-0001): the risk
   * level at or above which an Observed Case in this project escalates into
   * the full enforced lifecycle. Optional — absent means the built-in
   * default applies (`DEFAULT_ESCALATION_RISK_THRESHOLD` in
   * `constants/escalation-policy-defaults.ts`, currently `'high'`). Kept as
   * its own small object (rather than a bare field) so it reads as a
   * deliberate policy decision, mirroring how `rules` groups the
   * evidence-completeness cells — and so it can grow (e.g. a per-track
   * threshold) without another top-level field.
   */
  escalation?: {
    risk_threshold: RiskLevel;
  };
}
