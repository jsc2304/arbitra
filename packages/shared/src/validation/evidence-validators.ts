import { z } from 'zod';
import { actorMetadataSchema } from './actor-metadata-validators.js';
import { CANONICAL_EVIDENCE_TYPES } from '../types/evidence.js';

export const createEvidenceSchema = z.object({
  case_id: z.string().min(1),
  run_id: z.string().optional(),
  // Permissive on purpose: webhooks, system paths, and policy-driven custom
  // evidence types legitimately register non-canonical `type` values. Boundaries
  // that accept evidence from an IDE agent (the build-complete inline path) must
  // additionally constrain to `canonicalEvidenceTypeSchema` — see that schema's
  // doc-comment — so unknown types are rejected at the edge instead of being
  // silently dropped by completeness evaluation.
  type: z.string().min(1),
  source_type: z.enum(['automated', 'manual', 'webhook', 'agent']),
  artifact_ref: z.string().optional(),
  summary: z.string().optional(),
  machine_readable: z.boolean().optional().default(false),
  actor_metadata: actorMetadataSchema.optional(),
});

export type CreateEvidencePayload = z.infer<typeof createEvidenceSchema>;

/**
 * Strict enum of canonical evidence types an external caller may submit inline.
 *
 * Wired at the agent build-complete boundary (`buildCompleteEvidenceItemSchema`)
 * to close the silent-drop footgun: previously a non-canonical `type` (e.g.
 * `manual_verification`) passed the permissive `createEvidenceSchema`, got
 * registered, then failed to satisfy any required-evidence type — leaving the
 * requirement unmet with no error returned to the caller. With this enum the
 * boundary rejects the unknown type with a 400 that names the offending value
 * and lists the accepted types, so the caller can correct it.
 */
export const canonicalEvidenceTypeSchema = z.enum(CANONICAL_EVIDENCE_TYPES);

/**
 * Runtime validator for a single cell of an EvidencePolicy (track × risk).
 *
 * Mirrors `EvidencePolicyRule` in `../types/evidence.ts`. Kept in sync by
 * convention — adding a new field to the TS interface requires extending this
 * schema as well. `allow_self_approval` is a required boolean (default false
 * must be set explicitly by the caller to preserve anti-gaming defaults).
 */
export const evidencePolicyRuleSchema = z.object({
  required_evidence_types: z.array(z.string().min(1)),
  optional_evidence_types: z.array(z.string().min(1)),
  four_eyes_required: z.boolean(),
  allow_self_approval: z.boolean(),
  /**
   * Explicit "this cell deliberately requires no evidence" intent. See the
   * doc-comment on `EvidencePolicyRule.requires_no_evidence` for the full
   * rationale. Optional so legacy payloads/documents without it keep
   * parsing; the superRefine below is what actually enforces the intent
   * requirement on WRITE.
   */
  requires_no_evidence: z.boolean().optional(),
}).superRefine((rule, ctx) => {
  const hasRequired = rule.required_evidence_types.length > 0;
  // An empty required list used to be indistinguishable from an unfinished
  // edit (see edit-policy-modal.tsx's `deepCopyRules` bug) and silently
  // satisfied the evidence gate. Reject it at the boundary unless the caller
  // affirmatively says so via `requires_no_evidence`.
  if (!hasRequired && !rule.requires_no_evidence) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['required_evidence_types'],
      message:
        'required_evidence_types cannot be empty unless requires_no_evidence is set to true.',
    });
  }
  // The two are mutually exclusive. Rather than pick a winner (which would
  // silently discard whichever field the caller didn't intend), reject the
  // contradiction so the caller resolves it explicitly.
  if (hasRequired && rule.requires_no_evidence) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requires_no_evidence'],
      message:
        'requires_no_evidence cannot be true while required_evidence_types is non-empty.',
    });
  }
});

const evidencePolicyTrackRulesSchema = z.object({
  direct: evidencePolicyRuleSchema.optional(),
  manual: evidencePolicyRuleSchema.optional(),
}).partial().strict();

/**
 * Risk-first, track-second: `rules[risk_level][validation_track]`. `.strict()`
 * on both this schema and `evidencePolicyTrackRulesSchema` rejects a
 * track-first payload (e.g. `rules.direct.low`) instead of silently stripping
 * the unrecognized keys down to `{}` — see issue #851. A stripped-to-empty
 * `rules` map used to pass validation and persist as a policy requiring no
 * evidence at all.
 */
export const evidencePolicyRulesSchema = z.object({
  low: evidencePolicyTrackRulesSchema.optional(),
  medium: evidencePolicyTrackRulesSchema.optional(),
  high: evidencePolicyTrackRulesSchema.optional(),
  critical: evidencePolicyTrackRulesSchema.optional(),
}).partial().strict();

/**
 * Capability flags / named preset a caller may submit instead of (or alongside)
 * an explicit `rules` map. The route expands these into a full risk-first
 * rules map via `buildPolicyRulesFromPreset` so no new storage concept is
 * introduced — see `evidence-policy-presets.ts` for the governance trade-off
 * (dropping ci_result/unit_test_result substitutes a required manual_confirmation).
 */
export const evidencePolicyPresetNameSchema = z.enum(['no_ci_no_unit', 'no_ci', 'no_unit']);

export const evidenceCapabilityFlagsSchema = z
  .object({
    ci_available: z.boolean().optional(),
    unit_tests_available: z.boolean().optional(),
  })
  .partial();

/**
 * Whether a `capabilities` object actually declares at least one flag. An empty
 * object `{}` is valid per the schema (all fields optional) but is a no-op — it
 * must NOT count as a rules source, otherwise it would expand to FULL DEFAULTS
 * and silently overwrite a policy's custom cells (see the route guards).
 */
const hasCapabilityFlags = (
  capabilities: z.infer<typeof evidenceCapabilityFlagsSchema> | undefined,
): boolean => Boolean(capabilities) && Object.keys(capabilities!).length > 0;

export const createEvidencePolicySchema = z
  .object({
    project_id: z.string().min(1),
    repository_id: z.string().min(1).optional(),
    rules: evidencePolicyRulesSchema.optional(),
    preset: evidencePolicyPresetNameSchema.optional(),
    capabilities: evidenceCapabilityFlagsSchema.optional(),
  })
  // Exactly one source of rules must be supplied: an explicit `rules` map, a
  // named `preset`, or `capabilities` flags. An empty `capabilities` object is
  // not a source (it would expand to full defaults). Forbid combining `rules`
  // with a preset/flags so the persisted rules are unambiguous.
  .refine(
    (v) => Boolean(v.rules) || Boolean(v.preset) || hasCapabilityFlags(v.capabilities),
    { message: 'Provide one of: rules, preset, or capabilities', path: ['rules'] },
  )
  .refine(
    (v) => !(v.rules && (v.preset || hasCapabilityFlags(v.capabilities))),
    { message: 'Provide rules OR preset/capabilities, not both', path: ['rules'] },
  );

export const updateEvidencePolicySchema = z
  .object({
    project_id: z.string().min(1).optional(),
    repository_id: z.string().min(1).optional(),
    rules: evidencePolicyRulesSchema.optional(),
    preset: evidencePolicyPresetNameSchema.optional(),
    capabilities: evidenceCapabilityFlagsSchema.optional(),
  })
  // A PATCH must not carry more than one rules source. Without this guard a
  // payload combining `rules` with a `preset` would silently drop `rules` (the
  // route rebuilds the map from the preset), so reject the ambiguity here. An
  // empty `capabilities` object is treated as no source and never conflicts.
  .refine(
    (v) => !(v.rules && (v.preset || hasCapabilityFlags(v.capabilities))),
    { message: 'Provide rules OR preset/capabilities, not both', path: ['rules'] },
  )
  .refine(
    (v) => !(v.preset && hasCapabilityFlags(v.capabilities)),
    { message: 'Provide preset OR capabilities, not both', path: ['preset'] },
  );

export type EvidencePolicyRulePayload = z.infer<typeof evidencePolicyRuleSchema>;
export type CreateEvidencePolicyPayload = z.infer<typeof createEvidencePolicySchema>;
export type UpdateEvidencePolicyPayload = z.infer<typeof updateEvidencePolicySchema>;
