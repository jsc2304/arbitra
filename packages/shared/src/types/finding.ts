export type FindingCategory =
  | 'bug'
  | 'architecture_violation'
  | 'rule_violation'
  | 'rule_override_conflict'
  | 'missing_evidence'
  | 'test_gap'
  | 'security_risk'
  | 'performance_risk'
  | 'maintainability_issue'
  | 'clarification_needed'
  | 'large_diff_warning'
  | 'diff_exceeds_limit'
  | 'risk_downgrade_audit';

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type FindingStatus =
  | 'open'
  | 'accepted'
  | 'fixed'
  | 'waived'
  | 'contested'
  | 'resolved'
  /**
   * An agent (via MCP `resolve_finding` → `propose_waiver` decision) has
   * proposed waiving/resolving this finding with a rationale, but a human has
   * NOT yet confirmed it. Mirrors how agent-suggested knowledge assets land as
   * `suggested`: the proposal is recorded (rationale in `resolution`, optional
   * `severity_contested`, optional linked knowledge asset) but the finding STILL
   * BLOCKS approval until a human confirms via a terminal `waive`/`approve`
   * decision. Human-in-the-loop is structural, not heuristic.
   */
  | 'waiver_proposed'
  /**
   * Set when a case reached `done` while a `waiver_proposed` finding was still
   * awaiting human confirmation. Administrative and system-recorded (paired
   * with a `waived_on_completion` decision, actor `system:pipeline`) — no human
   * confirmed the proposal. Terminal and non-blocking: once the case is
   * complete no surface can act on the proposal anymore, so leaving it in a
   * blocking status would park an unactionable decision in the audit trail
   * forever (issue #751). Distinct from `waived` on purpose: the trail must
   * plainly state that the system closed this, not a reviewer.
   */
  | 'waived_on_completion';

export type FindingOriginType = 'reviewer' | 'rule_engine' | 'test_engine' | 'human';

/**
 * Provenance of the code a finding is raised against, relative to the change
 * under review:
 *   - `authored`  — code the author wrote/changed in this PR (the default).
 *   - `vendored`  — third-party code copied into the repo (reserved; not yet
 *                    auto-detected, see note below).
 *   - `submodule` — code that lives inside a git submodule the PR merely added
 *                    (`git submodule add`); the author did not write it.
 *
 * Governance rationale: high/critical findings against `authored` code must
 * gate exactly as before. Findings against `submodule` (and `vendored`) code
 * MUST NOT auto-escalate a case to `needs_human_decision` or block auto-approve
 * purely on their own — the author only pulled the code in, they didn't write
 * the defect. The human reviewer can still see these findings; they just don't
 * auto-block. See issue #633.
 *
 * Back-compat: the field is optional and a missing value is treated as
 * `authored` everywhere (see `effectiveFindingOrigin` /
 * `isAuthorBlockingOrigin`). Old findings persisted before this field existed
 * therefore keep gating exactly as they did.
 */
export type FindingOrigin = 'authored' | 'vendored' | 'submodule';

/**
 * Outcome of the post-consolidation verification step (see
 * `services/review/verification/finding-verifier.ts`). Before findings are
 * persisted, each is re-checked against ground truth (repo contents at the PR
 * head + registered case evidence) via one adversarial LLM verdict call:
 *   - `confirmed`  — the ground truth supports the finding.
 *   - `refuted`    — the ground truth mechanically disproves it (false positive).
 *   - `uncertain`  — the provided context could not decide either way.
 *   - `unverified` — verification was attempted but failed (fetch/LLM/schema
 *                    error) and fell soft; the finding is treated as if it had
 *                    not been verified for gating purposes.
 *
 * A missing value means verification never ran (feature disabled, or the
 * finding predates the feature) and the finding gates exactly as before.
 */
export type FindingVerificationStatus =
  | 'confirmed'
  | 'refuted'
  | 'uncertain'
  | 'unverified';

/** Consensus metadata attached when multiple LLMs review the same case. */
export interface FindingConsensus {
  /** Total number of LLM reviewers that ran. */
  reviewer_count: number;
  /** How many reviewers flagged this specific issue. */
  agreement_count: number;
  /** agreement_count / reviewer_count (0–1). */
  agreement_ratio: number;
  /** Which model identifiers flagged this issue. */
  models: string[];
}

export interface Finding {
  finding_id: string;
  case_id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: number;
  status: FindingStatus;
  title: string;
  description: string;
  origin_type: FindingOriginType;
  source_refs: string[];
  evidence_refs: string[];
  rule_refs: string[];
  resolution?: string;
  owner_ref?: string;
  severity_contested?: boolean;
  /**
   * Reference to a knowledge asset (KA id) an agent suggested alongside a
   * proposed waiver — e.g. the precedent that explains why this finding is a
   * false positive. Set by a `propose_waiver`/`waive` decision that carries a
   * `knowledge_asset_ref`. Lets the "derive KA from decision" flow be one
   * coherent action (issue arbitra-mcp#34).
   */
  knowledge_asset_ref?: string;
  /**
   * Provenance of the code this finding is raised against (see `FindingOrigin`).
   * Optional + back-compatible: a missing value is treated as `authored`.
   */
  origin?: FindingOrigin;
  /** Deterministic dedup signature computed at creation time. */
  signature?: string;
  /** Consensus metadata when multiple LLMs reviewed the case. */
  consensus?: FindingConsensus;
  /**
   * Verdict of the adversarial verification step (see
   * `FindingVerificationStatus`). Optional + back-compatible: a missing value
   * means verification never ran and the finding gates exactly as before. A
   * `refuted` finding stays visible/queryable but no longer counts as blocking
   * in the high/critical precondition gates.
   */
  verification_status?: FindingVerificationStatus;
  /** Verifier rationale (with citations) explaining the verdict. */
  verification_note?: string;
  /** ISO timestamp of when the verdict was produced. */
  verified_at?: string;
  /** Model id that produced the verdict. */
  verifier_model?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateFindingInput {
  case_id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: number;
  title: string;
  description: string;
  origin_type: FindingOriginType;
  source_refs?: string[];
  evidence_refs?: string[];
  rule_refs?: string[];
}
