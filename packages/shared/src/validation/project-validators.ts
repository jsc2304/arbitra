import { z } from 'zod';
import { lifecycleProfileSchema } from './lifecycle-profile-validators.js';
import { NOTIFICATION_EVENT_DEFAULTS } from '../constants/notification-events.js';

const defaultValidationTrackSchema = z.enum(['direct', 'manual']);
const defaultLanguageSchema = z.enum(['en', 'de']);

/** Shared with `updateProjectSchema` below and the narrowed `notificationConfigSchema`. */
export const notificationTemplatesSchema = z.record(z.string(), z.string());

/**
 * `notification_webhook_url` must either be empty (clears the webhook) or
 * start with the Google Chat incoming-webhook host — anything else can
 * never be a valid delivery target, per spec Slice C item 3 ("validated at
 * write time, not first-send time"). `null` is accepted as an equivalent
 * clear signal (`.nullable()`) alongside the empty string, matching how
 * `llm_overrides: null` already clears that field on this same route.
 */
export const notificationWebhookUrlSchema = z
  .string()
  .refine(
    (value) => value === '' || value.startsWith('https://chat.googleapis.com/'),
    { message: 'notification_webhook_url must start with https://chat.googleapis.com/ (or be empty to clear)' },
  )
  .nullable();

/**
 * `notification_events` keys must be members of the
 * `NOTIFICATION_EVENT_DEFAULTS` catalog (`constants/notification-events.ts`)
 * — the same catalog the dispatcher switches on and the Integrations tab
 * renders toggles from — with boolean values. Rejects both a typo'd event
 * name and a non-boolean value (e.g. `"true"`) before the write.
 */
const notificationEventKeySchema = z.string().refine((key) => key in NOTIFICATION_EVENT_DEFAULTS, {
  message: 'Unknown notification event',
});
export const notificationEventsOverrideSchema = z.record(notificationEventKeySchema, z.boolean());

/**
 * Narrowed schema for the notification-config subset of a project PATCH
 * body (spec Slice C item 3). Deliberately separate from `updateProjectSchema`
 * below rather than wired wholesale into the route: `updateProjectSchema`
 * also tightens fields (e.g. `name.trim().min(1)`) the route does not
 * validate today, and wiring it in would be a general PATCH-hardening pass
 * beyond this slice's scope. `notificationConfigSchema` validates only the
 * three notification fields; every other field keeps today's (lack of)
 * validation.
 */
/**
 * `notification_delivery` is server-owned (spec Slice C item 4): the
 * dispatcher and the test-webhook route write it after each real send
 * attempt, and a client PATCH must never be able to set or spoof it —
 * imagine a client papering over a real delivery failure by PATCHing a fake
 * `last_success_at`. `z.never()` rejects any value at all; `.optional()`
 * only permits the key to be absent, not present-with-any-value, so a
 * client that omits the field (every legitimate caller) is unaffected while
 * one that includes it gets a 400 instead of a silent drop or a persisted
 * spoof.
 */
const notificationDeliveryForbiddenSchema = z.never().optional();

export const notificationConfigSchema = z.object({
  notification_webhook_url: notificationWebhookUrlSchema.optional(),
  notification_events: notificationEventsOverrideSchema.optional(),
  notification_templates: notificationTemplatesSchema.optional(),
  notification_delivery: notificationDeliveryForbiddenSchema,
});

export type NotificationConfigPayload = z.infer<typeof notificationConfigSchema>;

/**
 * Shape-only mirror of `Project['llm_overrides']`. Deliberately does NOT
 * replicate `validateLlmOverrides` (`projects/[projectId]/llm-overrides-validator.ts`)
 * catalog checks (`isKnownLlmProvider`/`isKnownLlmModel`) — those look up a
 * runtime model catalog and warn-but-allow unknown models (legacy values),
 * which doesn't map cleanly onto a static Zod enum. Follow-up route wiring
 * should keep calling `validateLlmOverrides` alongside this schema (or fold
 * the catalog check into a `.refine()` later) rather than duplicating that
 * logic here.
 */
const llmOverridesShapeSchema = z
  .object({
    provider: z.string().optional(),
    models: z.record(z.string(), z.string()).optional(),
  })
  .nullable();

/**
 * Destined for `POST /api/projects` (`projects/route.ts`). `name` mirrors
 * the route's `!body.name?.trim()` check exactly — `.trim().min(1)` rejects
 * whitespace-only values the same way the route's truthiness check on the
 * trimmed result does. `default_language` mirrors the route's own explicit
 * `'en'|'de'` check (already enforced, not a tightening). `default_validation_track`
 * IS a deliberate tightening: the route today does
 * `...(body.default_validation_track ? { ... } : {})` — any truthy string
 * is stored unchecked, an "obviously too loose" enum per the method note.
 * `reviewer_pool`/`tech_leads`/`members`/`default_rule_set_refs` stay
 * `string[]` (route defaults each to `[]` or `[auth.userId]` with no
 * per-element validation).
 *
 * `.strict()`: unknown keys are REJECTED (400), not silently dropped, per
 * issue #1070's resolution of the passthrough-vs-strict question — same
 * precedent as #879. `reviewer_pool`/`tech_leads`/`members` are exactly the
 * arrays `isEffectiveMember()` (`packages/backend/src/lib/project-access.ts`)
 * walks to grant project access; silently stripping an unrecognized key on
 * an access-control write is its own audit smell, so a typo'd or unexpected
 * field must surface as a 400, not vanish.
 */
export const createProjectSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(''),
  reviewer_pool: z.array(z.string()).optional(),
  tech_leads: z.array(z.string()).optional(),
  members: z.array(z.string()).optional(),
  default_evidence_policy_id: z.string().optional(),
  default_rule_set_refs: z.array(z.string()).optional(),
  default_validation_track: defaultValidationTrackSchema.optional(),
  default_language: defaultLanguageSchema.optional(),
}).strict();

/**
 * Destined for `PATCH /api/projects/:projectId` (`projects/[projectId]/route.ts`).
 *
 * RESOLVED (issue #1070): the pre-fix handler spread the ENTIRE body (minus
 * `project_id`/`created_at`/`owner_user_id`) onto the Firestore doc via
 * `{ ...safeBody, updated_at }` — any extra/typo'd key was silently
 * persisted. This schema restricts to `Project`'s known writable fields and
 * uses `.strict()`: an unknown key is REJECTED (400), not silently dropped
 * (Zod's non-strict default) and not preserved via `.passthrough()`. Same
 * precedent as #879 — silently stripping an unrecognized key on
 * `reviewer_pool`/`tech_leads`/`members` (the arrays `isEffectiveMember()`,
 * `packages/backend/src/lib/project-access.ts`, walks for access control)
 * is its own audit smell; a typo'd or unexpected field must surface as a
 * 400 instead of vanishing or persisting unchecked.
 *
 * `notification_webhook_url` and `notification_events` reuse the same
 * `notificationWebhookUrlSchema`/`notificationEventsOverrideSchema` the
 * narrower `notificationConfigSchema` above validates with — kept in sync
 * so this schema's own type-shape check on those two fields can never be
 * looser than the dedicated notification-config check the route already
 * runs first. `default_language` and `llm_overrides` mirror the route's own
 * explicit checks (already enforced). `lifecycle_profile` reuses the
 * existing `lifecycleProfileSchema` (`lifecycle-profile-validators.ts`)
 * rather than re-deriving it. All other fields are unconstrained beyond
 * basic type shape — the route performs no validation on them today. Note
 * `name` specifically: the route performed zero checks on it before this
 * fix (even an empty or whitespace-only string would be persisted);
 * `.trim().min(1)` here is a small deliberate tightening (an empty project
 * name has no legitimate use) — flagged in case a follow-up caller
 * genuinely relies on clearing it.
 */
export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  reviewer_pool: z.array(z.string()).optional(),
  tech_leads: z.array(z.string()).optional(),
  members: z.array(z.string()).optional(),
  default_evidence_policy_id: z.string().optional(),
  default_rule_set_refs: z.array(z.string()).optional(),
  notification_webhook_url: notificationWebhookUrlSchema.optional(),
  notification_events: notificationEventsOverrideSchema.optional(),
  notification_templates: notificationTemplatesSchema.optional(),
  notification_delivery: notificationDeliveryForbiddenSchema,
  llm_overrides: llmOverridesShapeSchema.optional(),
  lifecycle_profile: lifecycleProfileSchema.optional(),
  default_validation_track: defaultValidationTrackSchema.optional(),
  default_language: defaultLanguageSchema.optional(),
}).strict();

export type CreateProjectPayload = z.infer<typeof createProjectSchema>;
export type UpdateProjectPayload = z.infer<typeof updateProjectSchema>;
