import { z } from 'zod';

const ruleSetStatusSchema = z.enum(['active', 'inactive', 'draft']);

/**
 * Destined for `POST /api/rule-sets` (`rule-sets/route.ts`). Only `name` is
 * genuinely required today (hand-rolled: non-empty after trim) —
 * `.trim().min(1)` mirrors that exactly, rejecting whitespace-only values
 * the same way the route's `body.name.trim() === ''` check does. `status`
 * is a deliberate tightening: the current route casts
 * `body.status as RuleStatus` with zero runtime validation (any string, e.g.
 * `"bogus"`, is stored as-is) — an "obviously too loose" enum per the
 * method note, so this schema enforces `RuleStatus`'s real 3-value union.
 * `project_id` stays unconstrained (`z.string()`, no `.min(1)`): the route
 * accepts it as `body.project_id ?? undefined` with no shape check at all.
 */
export const createRuleSetSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(''),
  project_id: z.string().optional(),
  rule_refs: z.array(z.string()).default([]),
  status: ruleSetStatusSchema.default('draft'),
});

/**
 * Destined for `PATCH /api/rule-sets/:ruleSetId` (`rule-sets/[ruleSetId]/route.ts`).
 * Mirrors the route's own field set exactly (`status`, `name`, `description`,
 * `rule_refs`) — `project_id` is not patchable today. `status` mirrors the
 * route's existing `VALID_STATUSES` check (already enforced, not a
 * tightening here). `name`/`description`/`rule_refs` stay unconstrained
 * beyond basic type shape: the route assigns them through unchecked.
 */
export const updateRuleSetSchema = z.object({
  status: ruleSetStatusSchema.optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  rule_refs: z.array(z.string()).optional(),
});

export type CreateRuleSetPayload = z.infer<typeof createRuleSetSchema>;
export type UpdateRuleSetPayload = z.infer<typeof updateRuleSetSchema>;
