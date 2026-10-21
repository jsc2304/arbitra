import { z } from 'zod';
import { notificationWebhookUrlSchema } from './project-validators.js';
import { CHAT_CONVERSATION_WINDOWS } from '../types/user.js';

/**
 * Destined for `PATCH /api/users/:userId/roles` (`users/[userId]/roles/route.ts`).
 * Mirrors the hand-rolled `!Array.isArray(roles) || roles.length === 0`
 * check plus the per-element `VALID_ROLES` check, both already enforced
 * today — a faithful mirror, not a tightening. The existing
 * inline admin gate + last-admin guard in the route are NOT duplicated
 * here; this schema only replaces the missing body validation.
 */
export const updateUserRolesSchema = z.object({
  roles: z.array(z.enum(['developer', 'reviewer', 'tech_lead', 'admin'])).min(1),
});

/**
 * Destined for `PATCH /api/users/:userId/chat-identity`
 * (`users/[userId]/chat-identity/route.ts`). Issue #1069 fix 1 — the admin
 * remap path is CLEAR ONLY (issue #1069):
 * `chat_user_id` is an opaque Google Chat resource id (`users/123456789`)
 * surfaced in no UI and no log, so an admin has no value to type in for a
 * replace variant. The `action: 'clear'` literal (rather than an empty
 * body) both proves this is an intentional admin action, not a bare PATCH,
 * and leaves room for a `'replace'` variant to be added later as a second
 * literal in a discriminated union if a future change gives an admin a way
 * to discover a `chat_user_id` first.
 */
export const updateChatIdentitySchema = z.object({
  action: z.literal('clear'),
});
export type UpdateChatIdentityPayload = z.infer<typeof updateChatIdentitySchema>;

/**
 * Destined for `PATCH /api/users/me` (`users/me/route.ts`). Patchable fields
 * are `custom_avatar_url` and — since spec Slice D,
 * `docs/specs/clerk-config-scheduling-chat.md` — `notification_chat_webhook`,
 * both independently optional (the route 400s only if BOTH are absent;
 * omitting one leaves it untouched, so a caller can update just the webhook
 * without resending the avatar).
 *
 * `custom_avatar_url` mirrors `validateCustomAvatarUrl` (`lib/avatar-url.ts`):
 * empty/whitespace-only clears the override, otherwise must be an `https://`
 * URL parseable via `new URL(...)`, at most 500 chars. The dedicated
 * `lib/avatar-url.ts` validator remains the runtime check the route actually
 * calls for that field (this schema is a faithful boundary mirror for it).
 *
 * `notification_chat_webhook` reuses `notificationWebhookUrlSchema`
 * (`project-validators.ts`) — the SAME rule `Project.notification_webhook_url`
 * enforces (`https://chat.googleapis.com/…` or empty/`null` to clear) — so a
 * Clerk-outcome webhook can never point anywhere else, and this one IS the
 * schema the route parses that field against directly (not just a mirror).
 *
 * `chat_conversation_window` (chat DM conversation window feature) is a
 * closed-set enum, `CHAT_CONVERSATION_WINDOWS` (`types/user.ts`) — never a
 * free-form duration. Independently optional like the other two fields, but
 * unlike them there is no empty-string/`null` "clear" signal for it: "no
 * preference chosen" is already representable by simply never sending the
 * field (the read side falls back to `DEFAULT_CHAT_CONVERSATION_WINDOW`).
 */
export const updateUserProfileSchema = z.object({
  custom_avatar_url: z
    .string()
    .refine(
      (value) => {
        const trimmed = value.trim();
        if (trimmed === '') return true;
        if (trimmed.length > 500) return false;
        if (!/^https:\/\//i.test(trimmed)) return false;
        try {
          return new URL(trimmed).protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'custom_avatar_url must be empty or a valid https:// URL of at most 500 characters' },
    )
    .optional(),
  notification_chat_webhook: notificationWebhookUrlSchema.optional(),
  chat_conversation_window: z.enum(CHAT_CONVERSATION_WINDOWS).optional(),
});

export type UpdateUserRolesPayload = z.infer<typeof updateUserRolesSchema>;
export type UpdateUserProfilePayload = z.infer<typeof updateUserProfileSchema>;
