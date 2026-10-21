import { z } from 'zod';

const validationTrackSchema = z.enum(['direct', 'manual']);
const riskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
const prioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
const caseTypeSchema = z.enum([
  'ticket_implementation', 'bugfix', 'refactoring',
  'pr_review', 'manual_verification', 'security_review', 'assistant_task', 'other',
]);

const caseTemplateDefaultsSchema = z.object({
  case_type: caseTypeSchema.optional(),
  risk_level: riskLevelSchema.optional(),
  priority: prioritySchema.optional(),
  validation_track: validationTrackSchema.optional(),
  title_prefix: z.string().max(200).optional(),
  description_template: z.string().max(5000).optional(),
  active_rule_set_refs: z.array(z.string()).optional(),
});

export const createCaseTemplateSchema = z.object({
  project_id: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().default(''),
  defaults: caseTemplateDefaultsSchema,
});

export type CreateCaseTemplatePayload = z.infer<typeof createCaseTemplateSchema>;
