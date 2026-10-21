import { z } from 'zod';

export const gateBehaviorSchema = z.enum(['auto', 'confirm']);

export const gateIdSchema = z.enum([
  'exploration_to_ready',
  'ready_to_build',
  'build_to_validation',
  'validation_to_review',
  'review_to_approved',
  'review_to_needs_human',
  'review_to_verification',
  'approved_to_pending_merge',
  'pending_merge_to_done',
]);

export const lifecyclePresetIdSchema = z.enum(['autonomous', 'standard', 'strict']);

export const gateConfirmerRoleSchema = z.enum(['reviewer', 'tech_lead']);

export const gateConfigSchema = z.object({
  exploration_to_ready:      gateBehaviorSchema.optional(),
  ready_to_build:            gateBehaviorSchema.optional(),
  build_to_validation:       gateBehaviorSchema.optional(),
  validation_to_review:      gateBehaviorSchema.optional(),
  review_to_approved:        gateBehaviorSchema.optional(),
  review_to_needs_human:     gateBehaviorSchema.optional(),
  review_to_verification:    gateBehaviorSchema.optional(),
  approved_to_pending_merge: gateBehaviorSchema.optional(),
  pending_merge_to_done:     gateBehaviorSchema.optional(),
}).strict();

export const lifecycleProfileSchema = z.object({
  preset: lifecyclePresetIdSchema,
  overrides: gateConfigSchema.optional(),
  gate_confirmer_roles: z.array(gateConfirmerRoleSchema).optional(),
});
