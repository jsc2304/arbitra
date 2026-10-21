/**
 * Client-side replica of the Arbitra backend's Session Signal wire schema
 * (`packages/shared/src/validation/session-signal-validators.ts`).
 *
 * arbitra-mcp is published to npm as a standalone package and does not depend
 * on `packages/shared`, so this file replicates the schema deliberately.
 * Keep the two in sync by hand; a schema drift here would surface as 4xx
 * responses at `POST /api/signals`, which the emitter swallows silently by
 * design (see session-signal-hook.ts), so this replica is also the test
 * fixture that pins the emitted payload shape.
 */

import { z } from "zod";

export const SESSION_SIGNAL_SCHEMA_VERSION = 1;

export const sessionSignalEventTypeSchema = z.enum([
  "session_start",
  "heartbeat",
  "session_end",
]);

export type SessionSignalEventType = z.infer<typeof sessionSignalEventTypeSchema>;

export const sessionSignalEventSchema = z.object({
  event_id: z.string().min(1),
  schema_version: z.number().int().positive(),
  event_type: sessionSignalEventTypeSchema,
  agent_name: z.string().min(1),
  repository: z.string().min(1),
  branch: z.string().min(1),
  session_id: z.string().min(1),
  client_timestamp: z.string().optional(),
});

export type SessionSignalEvent = z.infer<typeof sessionSignalEventSchema>;

export const sessionSignalBatchSchema = z.object({
  events: z.array(z.unknown()).min(1),
});

export type SessionSignalBatchPayload = z.infer<typeof sessionSignalBatchSchema>;
