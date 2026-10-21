import { z } from 'zod';
import { actorMetadataSchema } from './actor-metadata-validators.js';
import { inlineAttachmentSchema } from './artifact-validators.js';

export const createCommentSchema = z.object({
  parent_type: z.enum(['finding', 'case']),
  parent_id: z.string().min(1),
  body: z.string().min(1).max(10000),
  source: z.enum(['human', 'ide_agent', 'google_chat']).optional(),
  agent_name: z.string().min(1).max(50).optional(),
  actor_metadata: actorMetadataSchema.optional(),
  attachments: z.array(inlineAttachmentSchema).max(20).optional(),
});

export type CreateCommentPayload = z.infer<typeof createCommentSchema>;
