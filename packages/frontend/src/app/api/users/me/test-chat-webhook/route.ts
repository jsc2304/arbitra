import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';

/**
 * POST /api/users/me/test-chat-webhook — sends a test message to the
 * CALLING user's own `notification_chat_webhook` (spec Slice D,
 * `docs/specs/clerk-config-scheduling-chat.md`).
 *
 * Mirrors `POST /api/projects/[projectId]/test-webhook` exactly, scoped to
 * `auth.userId` instead of a `projectId` route param — there is no
 * project-access check to perform because there is no target-user
 * parameter at all: this route only ever reads and writes the authenticated
 * caller's own document, so it cannot be used to probe or spam another
 * user's space.
 *
 * A Test click is a real send attempt, so it records
 * `users/{id}.notification_chat_delivery` exactly like a live
 * `EventNotifier.notifyRequesterChat` send would (same delivery-recording
 * pattern as the project route) — the Settings card then reflects a manual
 * Test the same way it reflects a real Clerk-outcome ping.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const { collections, GoogleChatNotifier } = await import('@arbitra/backend');

    const doc = await collections.users().doc(auth.userId).get();
    if (!doc.exists) {
      return NextResponse.json({ error: { message: 'User profile not found' } }, { status: 404 });
    }

    const user = doc.data()!;
    const webhookUrl = user.notification_chat_webhook;

    if (!webhookUrl) {
      return NextResponse.json(
        { error: { message: 'No chat webhook configured for your profile' } },
        { status: 400 },
      );
    }

    const notifier = new GoogleChatNotifier();
    const result = await notifier.sendTest(webhookUrl);

    // Awaited so the write is durable before the response goes out, but its
    // own failure is caught and never surfaces as (or replaces) the
    // test-send's own result below — mirrors the project test-webhook route.
    const now = new Date().toISOString();
    const deliveryUpdate = result.ok
      ? { 'notification_chat_delivery.last_success_at': now }
      : {
          'notification_chat_delivery.last_error': {
            at: now,
            code: result.status !== undefined ? String(result.status) : 'network_error',
            message: result.error ?? 'Unknown error',
          },
        };
    try {
      await collections.users().doc(auth.userId).update(deliveryUpdate);
    } catch (err) {
      console.warn(`[test-chat-webhook] Failed to record delivery outcome for ${auth.userId}:`, err);
    }

    if (!result.ok) {
      return NextResponse.json(
        { error: { message: 'Failed to send test message. Check the webhook URL.' } },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleError(error);
  }
}
