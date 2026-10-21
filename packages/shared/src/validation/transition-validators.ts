import { z } from 'zod';

const caseStatusSchema = z.enum([
  'open', 'exploration', 'ready_for_build', 'in_build', 'in_validation',
  'in_review', 'needs_human_decision', 'verification_pending',
  'approved', 'pending_merge', 'done', 'rejected',
]);

export const transitionRequestSchema = z.object({
  target_status: caseStatusSchema,
});

export type TransitionRequestPayload = z.infer<typeof transitionRequestSchema>;
