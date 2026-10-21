import { z } from 'zod';

/**
 * Zod schema mirroring `ActorMetadata` from
 * `../types/actor-metadata.ts`. All fields optional. Reused by comment and
 * evidence validators so both channels accept the same shape.
 */
export const actorMetadataSchema = z
  .object({
    client_name: z.string().min(1).max(100).optional(),
    client_version: z.string().min(1).max(50).optional(),
    model: z.string().min(1).max(100).optional(),
  })
  .strict();

export type ActorMetadataPayload = z.infer<typeof actorMetadataSchema>;
