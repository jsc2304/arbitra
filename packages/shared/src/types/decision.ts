import type { ActorMetadata } from './actor-metadata.js';

/**
 * Single source of truth for decision types.
 *
 * The `DecisionType` union is derived from this const array so the Zod
 * validator (`createDecisionSchema`) can also derive from it — making
 * drift between the TS type and the runtime schema structurally
 * impossible. Adding a new decision type requires touching only this
 * array.
 */
export const DECISION_TYPES = [
  'approve',
  'auto_approve',
  'request_changes',
  'waive',
  // Agent-initiated proposal to waive/resolve a finding (via MCP
  // `resolve_finding`). Records the rationale + proposed resolution but leaves
  // the finding in the still-blocking `waiver_proposed` status: a human must
  // confirm with a terminal `waive`/`approve` decision before the finding stops
  // gating approval. Preserves human-in-the-loop the same way agent-suggested
  // knowledge assets land as `suggested` (issue arbitra-mcp#34).
  'propose_waiver',
  'reject',
  'escalate',
  'manual_validation_confirmed',
  'merge_not_applicable',
  // Human escape hatch for a case stuck in `in_review` when the server-side
  // AI review run fails permanently (e.g. provider quota error) and no
  // completed review_run will ever land. Sets `Case.review_not_applicable`
  // (the same flag the pipeline auto-attaches for no-diff cases, issue #687)
  // with a documented rationale + role check — an operational unblock, not
  // an approval; downstream approval anti-gaming still applies.
  'review_not_applicable',
  'gate_confirmed',
  'gate_rejected',
  // System-only, emitted by the completion closer
  // (`closeOutstandingWaiverProposalsOnCompletion`) when a case reaches `done`
  // while a `propose_waiver` was still awaiting human confirmation. Closes the
  // finding administratively (status `waived_on_completion`) so the audit trail
  // carries no pending decision nobody can make anymore. Never
  // client-submittable — see `SYSTEM_DECISION_TYPES` (issue #751).
  'waived_on_completion',
] as const;

export type DecisionType = (typeof DECISION_TYPES)[number];

/**
 * Decision types only the server writes. They are excluded from the
 * client-submittable schema (`createDecisionSchema`) so a caller cannot forge a
 * system decision through `POST /api/cases/:caseId/decisions`:
 *
 *   - `auto_approve`          — written by `FirestorePipelineAdapter`
 *   - `waived_on_completion`  — written by the completion closer
 *
 * `merge_not_applicable` is deliberately absent: the system attaches it AND a
 * human may record it to recover a stuck `pending_merge` case (issue #687).
 * `review_not_applicable` is likewise absent: it exists solely as a human
 * escape hatch (the system's own bypass path writes `Case.review_not_applicable`
 * directly, never via a decision) for a case stuck in `in_review`.
 *
 * The persisted-record validator (`decisionSchema`) still accepts every
 * `DecisionType` — the restriction is on the intake boundary only.
 */
export const SYSTEM_DECISION_TYPES = [
  'auto_approve',
  'waived_on_completion',
] as const satisfies readonly DecisionType[];

export type SystemDecisionType = (typeof SYSTEM_DECISION_TYPES)[number];

/** Decision types a client may submit — derived by exclusion, never hand-listed. */
export type ClientDecisionType = Exclude<DecisionType, SystemDecisionType>;

export interface DecisionSnapshot {
  active_rule_set_versions: Record<string, number>;
  evidence_policy_id?: string;
  evidence_policy_version: number;
  knowledge_asset_refs: string[];
  snapshot_fidelity?: 'legacy' | 'exact';
}

export interface Decision {
  decision_id: string;
  case_id: string;
  finding_id?: string;
  /**
   * Rule id targeted by a `gate_confirmed`/`gate_rejected` decision that
   * resolves a blocked `human_confirmation` RuleResult. Absent for
   * decisions that resolve a lifecycle `pending_gate` instead — those are
   * identified via `Case.pending_gate`, not a rule reference.
   */
  rule_id?: string;
  type: DecisionType;
  actor_id: string;
  rationale: string;
  snapshot: DecisionSnapshot;
  created_at: string;
  /**
   * Derived server-side: set to true when the actor is the case owner AND the
   * effective evidence policy cell had `allow_self_approval: true` for the case's
   * risk/track. Surfaces self-approvals in the audit trail. Never persisted as false
   * — only true or undefined.
   */
  self_approved?: boolean;
  /**
   * Authoritative client/model signature when the decision is filed by an
   * IDE agent (Cursor, Claude Code, Codex, etc.). Populated by the MCP client
   * on the API call — separate from any self-report inside `rationale`.
   * All fields optional.
   *
   * For auto-attached `manual_validation_confirmed` decisions, this is copied
   * from the parent `approve` decision so the audit trail surfaces the same
   * client for both rows (the user only clicked one button).
   */
  actor_metadata?: ActorMetadata;
}

export interface CreateDecisionInput {
  case_id: string;
  finding_id?: string;
  /**
   * Rule id targeted by a `gate_confirmed`/`gate_rejected` decision. When
   * present, the decision resolves the matching blocked `human_confirmation`
   * RuleResult(s) for the case instead of the lifecycle `pending_gate`. Only
   * meaningful for `gate_confirmed`/`gate_rejected`.
   */
  rule_id?: string;
  type: DecisionType;
  rationale: string;
  /**
   * Human-readable resolution text written onto the targeted finding's
   * `resolution` field (e.g. "false positive — hallucinated API signature,
   * verified against production usage"). Only meaningful for finding-level
   * decisions that change status (`waive` / `approve` / `propose_waiver`).
   */
  resolution?: string;
  /**
   * When true, marks the targeted finding's `severity_contested` flag — the
   * actor disputes the assigned severity. Only meaningful for finding-level
   * decisions.
   */
  severity_contested?: boolean;
  /**
   * Knowledge-asset id to link to the targeted finding (e.g. the precedent an
   * agent captured while proposing the waiver). Written onto the finding's
   * `knowledge_asset_ref`. Only meaningful for finding-level decisions.
   */
  knowledge_asset_ref?: string;
  actor_metadata?: ActorMetadata;
}
