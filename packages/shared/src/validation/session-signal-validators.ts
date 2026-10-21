import { z } from 'zod';

/**
 * Validator-at-the-boundary for one Session Signal event (issue #983 /
 * ADR-0001). Deliberately has no field for tool output, diffs, or code —
 * the payload's shape is the enforcement of "never tool contents or code",
 * not a runtime check.
 *
 * No version in the URL: `schema_version` travels with the payload so the
 * shape can evolve additively without a new route.
 */
/** Used as a Firestore document id: no `/`, not `.` or `..`, bounded length. */
const documentIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('/') && value !== '.' && value !== '..', {
    message: 'must not contain "/" or be "." / ".."',
  });

export const sessionSignalEventSchema = z.object({
  event_id: documentIdSchema,
  schema_version: z.number().int().positive(),
  event_type: z.enum(['session_start', 'heartbeat', 'session_end']),
  agent_name: z.string().min(1),
  repository: z.string().min(1),
  branch: z.string().min(1),
  session_id: documentIdSchema,
  client_timestamp: z.string().optional(),
});

export type SessionSignalEventPayload = z.infer<typeof sessionSignalEventSchema>;

/** Top-level batch envelope: `POST /api/signals` body shape. */
export const sessionSignalBatchSchema = z.object({
  events: z.array(z.unknown()).min(1),
});

export type SessionSignalBatchPayload = z.infer<typeof sessionSignalBatchSchema>;
