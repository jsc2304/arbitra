import { z } from 'zod';

/**
 * Local scope schema — mirrors `RuleScope` (`types/rule.ts`).
 */
export const ruleScopeSchema = z.object({
  layer: z.enum(['global', 'project']),
  ref: z.string().min(1),
});

export const createRuleOverrideSchema = z
  .object({
    rule_id: z.string().min(1),
    overriding_rule_id: z.string().min(1),
    scope: ruleScopeSchema,
    rationale: z.string().min(1, 'rationale is required').max(5000),
    finding_id: z.string().min(1).optional(),
  })
  .refine((v) => v.rule_id !== v.overriding_rule_id, {
    message: 'rule_id and overriding_rule_id must reference different rules',
    path: ['overriding_rule_id'],
  });

export type CreateRuleOverridePayload = z.infer<typeof createRuleOverrideSchema>;

export const ruleOverrideFiltersSchema = z.object({
  rule_id: z.string().min(1).optional(),
  overriding_rule_id: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
});

export type RuleOverrideFiltersPayload = z.infer<typeof ruleOverrideFiltersSchema>;
