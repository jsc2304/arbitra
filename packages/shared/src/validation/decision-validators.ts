import { z } from 'zod';
import {
  DECISION_TYPES,
  SYSTEM_DECISION_TYPES,
  type ClientDecisionType,
  type DecisionType,
} from '../types/decision.js';
import { actorMetadataSchema } from './actor-metadata-validators.js';

/**
 * Client-submittable decision types: every `DecisionType` minus the system-only
 * ones. Derived by exclusion (no parallel hand-maintained enum) so adding a
 * decision type stays a one-line change in `DECISION_TYPES`.
 *
 * The cast satisfies `z.enum`'s non-empty-tuple signature; the compile-time
 * parity guard at the bottom of this file proves the resulting enum equals
 * `ClientDecisionType` exactly.
 */
export const CLIENT_DECISION_TYPES = DECISION_TYPES.filter(
  (t): t is ClientDecisionType =>
    !(SYSTEM_DECISION_TYPES as readonly DecisionType[]).includes(t),
) as [ClientDecisionType, ...ClientDecisionType[]];

/**
 * Intake validator for `POST /api/cases/:caseId/decisions`. Accepts only
 * `CLIENT_DECISION_TYPES` — a system decision type is rejected at the boundary
 * with a 400 rather than persisted with a caller's actor id.
 */
export const createDecisionSchema = z.object({
  case_id: z.string().min(1),
  finding_id: z.string().optional(),
  /**
   * Rule id targeted by a `gate_confirmed`/`gate_rejected` decision — resolves
   * the matching blocked `human_confirmation` RuleResult(s) for the case.
   * Only meaningful for those two decision types.
   */
  rule_id: z.string().min(1).optional(),
  type: z.enum(CLIENT_DECISION_TYPES),
  rationale: z.string().min(1).max(5000),
  /**
   * Optional finding-resolution text persisted onto the targeted finding's
   * `resolution` field. Bounded to keep it a short human-readable note rather
   * than a second copy of the full rationale.
   */
  resolution: z.string().min(1).max(5000).optional(),
  /** Optional: mark the targeted finding's severity as contested. */
  severity_contested: z.boolean().optional(),
  /** Optional: link a knowledge asset id to the targeted finding. */
  knowledge_asset_ref: z.string().min(1).max(200).optional(),
  actor_metadata: actorMetadataSchema.optional(),
});

export type CreateDecisionPayload = z.infer<typeof createDecisionSchema>;

/**
 * Runtime validator for a persisted Decision record.
 *
 * `self_approved` is derived server-side and optional. It is set only when the
 * case owner approves or confirms their own gate under an evidence policy cell
 * that permits self-approval. Never persisted as `false` — absence means "not a
 * self-approval".
 */
export const decisionSchema = z.object({
  decision_id: z.string().min(1),
  case_id: z.string().min(1),
  finding_id: z.string().optional(),
  rule_id: z.string().optional(),
  type: z.enum(DECISION_TYPES),
  actor_id: z.string().min(1),
  rationale: z.string(),
  snapshot: z.object({
    active_rule_set_versions: z.record(z.string(), z.number()),
    evidence_policy_id: z.string().min(1).optional(),
    evidence_policy_version: z.number(),
    knowledge_asset_refs: z.array(z.string()),
    snapshot_fidelity: z.enum(['legacy', 'exact']).optional(),
  }),
  created_at: z.string(),
  self_approved: z.boolean().optional(),
  actor_metadata: actorMetadataSchema.optional(),
});

export type DecisionPayload = z.infer<typeof decisionSchema>;

// ── Compile-time drift guards ───────────────────────────────────────
//
// Ensure both Zod enums stay exactly in sync with their TS unions:
// `createDecisionSchema` with `ClientDecisionType` (system types excluded)
// and `decisionSchema` with the full `DecisionType`. If either pair ever
// diverges (e.g. a new value added to one but not the other, or a system
// type leaking into the intake schema), `npm run typecheck` fails here
// with a clear pointer.

type _SchemaDecisionType = z.infer<typeof createDecisionSchema>['type'];
type _PersistedDecisionType = z.infer<typeof decisionSchema>['type'];
type _Assert<T extends true> = T;
// Exported (rather than local type aliases) so `noUnusedLocals` does not
// flag the assertions. Consumers should NOT import these — they exist only
// to make the parity checks participate in type resolution.
export type _DecisionTypeMatchesSchema = _Assert<
  [_SchemaDecisionType] extends [ClientDecisionType]
    ? [ClientDecisionType] extends [_SchemaDecisionType]
      ? true
      : false
    : false
>;
export type _DecisionTypeMatchesPersistedSchema = _Assert<
  [_PersistedDecisionType] extends [DecisionType]
    ? [DecisionType] extends [_PersistedDecisionType]
      ? true
      : false
    : false
>;
