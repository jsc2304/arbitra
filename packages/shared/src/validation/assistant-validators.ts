import { z } from 'zod';
import { ASSISTANT_FEEDBACK_RATINGS } from '../types/assistant-feedback.js';

/**
 * Body accepted by `POST /api/assistant/tasks`.
 *
 * Deliberately does NOT cap `text` here: the maximum input length is an
 * operational limit read from `ARBITRA_ASSISTANT_MAX_INPUT_CHARS` at request
 * time, so it lives in `AssistantIntakeService` where the configured value can
 * appear in the error message. This schema only checks shape.
 */
/**
 * Request shape accepted by the authenticated web intake route.
 *
 * Channel provenance belongs to an entry point, not an untrusted browser
 * payload. This strict schema intentionally has no channel or Chat-coordinate
 * fields: the web route always supplies `channel: 'web'` itself.
 */
export const webAssistantIntakeSchema = z
  .object({
    text: z.string(),
    idempotency_key: z.string().min(1).max(500).optional(),
  })
  .strict();

/**
 * Browser-facing follow-up shape. The key is mandatory because a submit retry
 * must resolve to the same child Case rather than append another turn.
 */
export const webAssistantFollowUpSchema = z
  .object({
    text: z.string(),
    idempotency_key: z.string().min(1).max(500),
  })
  .strict();

/** Exact active attempt the case page asks the dedicated stop route to cancel. */
export const assistantCancelRequestSchema = z
  .object({
    run_id: z.string().min(1).max(200),
  })
  .strict();

/**
 * A judgement must carry its reason. Trimming at the boundary makes identical
 * browser retries compare identically and keeps whitespace-only explanations
 * out of the audit record.
 */
export const assistantFeedbackRequestSchema = z
  .object({
    rating: z.enum(ASSISTANT_FEEDBACK_RATINGS),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
