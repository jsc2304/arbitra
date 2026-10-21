import { z } from 'zod';

/**
 * Mirrors `EvaluationMode` (`types/rule.ts`). Both `rules/route.ts` (POST) and
 * `rules/[ruleId]/route.ts` (PATCH) already hand-roll this exact 5-value
 * enum check today — this is a faithful mirror, not a tightening.
 */
const evaluationModeSchema = z.enum([
  'metadata_check', 'diff_pattern', 'evidence_check', 'llm_evaluation', 'human_confirmation',
]);

/**
 * `Rule.severity_if_failed` is typed as a bare `string` in `types/rule.ts`,
 * but both rule routes already hand-roll this exact 4-value check at
 * runtime (`VALID_SEVERITY_LEVELS`) — mirroring the route's actual runtime
 * behavior here, which is stricter than the raw TS type but not stricter
 * than what the backend genuinely enforces today.
 */
const ruleSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);

/**
 * Local scope object for a Rule. `ref` is required only when `layer` is
 * `'project'` — `rules/route.ts` POST enforces exactly this conditional
 * requirement (`scope.ref` is read/stored as-is for `layer: 'global'`,
 * with no presence check). Kept unexported and local to avoid colliding
 * with `rule-override-validators.ts`'s own local `ruleScopeSchema` export
 * (that file predates this one and wasn't touched per the task brief).
 */
const ruleScopeSchema = z
  .object({
    layer: z.enum(['global', 'project']),
    ref: z.string().optional(),
  })
  .refine((v) => v.layer !== 'project' || Boolean(v.ref && v.ref.length > 0), {
    message: "scope.ref is required when scope.layer is 'project'",
    path: ['ref'],
  });

/**
 * Destined for `POST /api/rules` (`rules/route.ts:35-105`). Mirrors the
 * hand-rolled `requiredFields` + `VALID_EVALUATION_MODES` /
 * `VALID_SEVERITY_LEVELS` / `VALID_SCOPE_LAYERS` checks. `category` stays a
 * permissive non-empty string: the route requires it be present but never
 * validates its value against `RuleCategory`'s literal members (and the
 * shared type itself widens via `(string & {})`, i.e. is deliberately
 * open-ended).
 */
export const createRuleSchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  evaluation_mode: evaluationModeSchema,
  severity_if_failed: ruleSeveritySchema,
  scope: ruleScopeSchema,
  description: z.string().min(1),
  rationale: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Destined for `PATCH /api/rules/:ruleId` (`rules/[ruleId]/route.ts`).
 * Mirrors `allowedFields` exactly — note `scope` is intentionally absent:
 * the hand-rolled PATCH route never allows scope changes. `name`,
 * `description`, `rationale`, `category` stay unconstrained strings because
 * the route itself performs no value validation on them when present
 * (only `status`, `evaluation_mode`, `severity_if_failed` are checked).
 */
export const updateRuleSchema = z.object({
  status: z.enum(['active', 'inactive', 'draft']).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  rationale: z.string().optional(),
  category: z.string().optional(),
  evaluation_mode: evaluationModeSchema.optional(),
  severity_if_failed: ruleSeveritySchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export type CreateRulePayload = z.infer<typeof createRuleSchema>;
export type UpdateRulePayload = z.infer<typeof updateRuleSchema>;
