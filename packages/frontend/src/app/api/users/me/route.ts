import { NextRequest, NextResponse } from 'next/server';
import { notificationWebhookUrlSchema, updateUserProfileSchema } from '@arbitra/shared';
import { authenticate, handleError, validationErrorResponse } from '@/lib/api-helpers';
import { validateCustomAvatarUrl } from '@/lib/avatar-url';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const { collections } = await import('@arbitra/backend');
    const doc = await collections.users().doc(auth.userId).get();
    if (!doc.exists) {
      return NextResponse.json({
        user_id: auth.userId,
        email: auth.email,
        display_name: auth.email.split('@')[0],
        roles: ['developer'],
      });
    }
    return NextResponse.json(doc.data());
  } catch (error) {
    return handleError(error);
  }
}

/**
 * PATCH /api/users/me — Self-service profile updates for the calling user.
 *
 * Patchable fields, all independently optional (at least one must be
 * present — omitting one leaves it untouched, so a caller can update just
 * one field without resending the others):
 *
 *  - `custom_avatar_url`. The separate `avatar_url` field is managed by auth
 *    middleware (synced from the identity provider's `picture` claim) and
 *    must not be touched here — `custom_avatar_url` is an explicit override,
 *    used as a fallback when Firebase serves a stale or silhouette
 *    `photoURL` for Workspace tenants.
 *  - `notification_chat_webhook` (spec Slice D,
 *    `docs/specs/clerk-config-scheduling-chat.md`): the REQUESTER's own
 *    Google Chat webhook for Clerk task outcomes. Validated with the exact
 *    same rule as `Project.notification_webhook_url`
 *    (`notificationWebhookUrlSchema` — `https://chat.googleapis.com/…` or
 *    empty/`null` to clear).
 *  - `chat_conversation_window` (chat DM conversation-window feature):
 *    the caller's habit for when a DM to Clerk should start a fresh
 *    conversation. Validated against the closed
 *    `updateUserProfileSchema.shape.chat_conversation_window` enum piece —
 *    reusing the real schema (`user-validators.ts`) rather than re-declaring
 *    the enum inline here, so a client cannot store an arbitrary string.
 *    `custom_avatar_url` keeps its own dedicated validator
 *    (`lib/avatar-url.ts`, trim + empty-clears semantics that don't map
 *    cleanly onto a plain Zod field) rather than routing through the full
 *    object schema — `updateUserProfileSchema` is a faithful mirror for
 *    that one field only, not (yet) the route's parser for it.
 *
 * Every other body key — including server-owned fields like `roles`,
 * `user_id`, `email`, or `notification_chat_delivery` — is silently ignored:
 * this route reads out only the three field names above and never spreads
 * the body onto the document. There is no target-user parameter anywhere on
 * this route, so it can only ever operate on `auth.userId` — a caller can
 * never patch someone else's profile or webhook through this endpoint.
 */
export async function PATCH(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } },
        { status: 400 },
      );
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: { code: 'INVALID_JSON', message: 'Request body must be a JSON object' } },
        { status: 400 },
      );
    }

    const {
      custom_avatar_url: rawCustomAvatarUrl,
      notification_chat_webhook: rawChatWebhook,
      chat_conversation_window: rawChatConversationWindow,
    } = body as Record<string, unknown>;

    if (rawCustomAvatarUrl === undefined && rawChatWebhook === undefined && rawChatConversationWindow === undefined) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message:
              'No updatable fields provided. Supported: custom_avatar_url, notification_chat_webhook, chat_conversation_window.',
          },
        },
        { status: 400 },
      );
    }

    const updates: Record<string, unknown> = {};
    const deletes: string[] = [];

    if (rawCustomAvatarUrl !== undefined) {
      const validation = validateCustomAvatarUrl(rawCustomAvatarUrl);
      if (!validation.ok) {
        return NextResponse.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: validation.error,
              details: { field: 'custom_avatar_url' },
            },
          },
          { status: 400 },
        );
      }
      // Empty string clears the override — strip the field entirely so read
      // paths don't need to special-case "" vs. undefined.
      if (validation.value === '') deletes.push('custom_avatar_url');
      else updates.custom_avatar_url = validation.value;
    }

    if (rawChatWebhook !== undefined) {
      const check = notificationWebhookUrlSchema.safeParse(rawChatWebhook);
      if (!check.success) {
        return validationErrorResponse('Invalid notification_chat_webhook', check.error.issues);
      }
      // '' and null are both equivalent "clear" signals on the wire.
      if (check.data === '' || check.data === null) deletes.push('notification_chat_webhook');
      else updates.notification_chat_webhook = check.data;
    }

    if (rawChatConversationWindow !== undefined) {
      // Reuses the actual field schema off `updateUserProfileSchema`
      // (closed `CHAT_CONVERSATION_WINDOWS` enum) rather than a third
      // hand-rolled check, so a client cannot persist an arbitrary string.
      const check = updateUserProfileSchema.shape.chat_conversation_window.safeParse(rawChatConversationWindow);
      if (!check.success) {
        return validationErrorResponse('Invalid chat_conversation_window', check.error.issues);
      }
      // No clear signal for this field (see the docstring above) — a
      // defined input always resolves to a defined, valid enum member here.
      updates.chat_conversation_window = check.data;
    }

    const { collections } = await import('@arbitra/backend');
    const userRef = collections.users().doc(auth.userId);
    const snap = await userRef.get();
    if (!snap.exists) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'User profile not found' } },
        { status: 404 },
      );
    }

    const now = new Date().toISOString();
    const updatePayload: Record<string, unknown> = { ...updates, updated_at: now };
    if (deletes.length > 0) {
      const { FieldValue } = await import('firebase-admin/firestore');
      for (const field of deletes) updatePayload[field] = FieldValue.delete();
    }
    await userRef.update(updatePayload);

    const updated = await userRef.get();
    return NextResponse.json(updated.data());
  } catch (error) {
    return handleError(error);
  }
}
