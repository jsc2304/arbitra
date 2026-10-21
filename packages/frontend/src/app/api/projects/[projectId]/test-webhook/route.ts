import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError, requireProjectAccess } from '@/lib/api-helpers';

export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireProjectAccess(params.projectId, auth.userId);
    if (denied) return denied;
    const { collections, GoogleChatNotifier } = await import('@arbitra/backend');

    const doc = await collections.projects().doc(params.projectId).get();
    if (!doc.exists) {
      return NextResponse.json({ error: { message: 'Project not found' } }, { status: 404 });
    }

    const project = doc.data()!;
    const webhookUrl = project.notification_webhook_url;

    if (!webhookUrl) {
      return NextResponse.json(
        { error: { message: 'No webhook URL configured for this project' } },
        { status: 400 },
      );
    }

    const notifier = new GoogleChatNotifier();
    const result = await notifier.sendTest(webhookUrl);

    // A Test click is a real send attempt, so it updates
    // `notification_delivery` exactly like a dispatcher send would (spec
    // Slice C item 4, `docs/specs/clerk-config-scheduling-chat.md`) — the
    // Integrations tab then reflects a manual Test the same way it reflects
    // a live event notification. Fire-and-forget in the sense that mirrors
    // `NotificationDispatcher.recordDeliveryOutcome`: awaited so the write is
    // durable before the response goes out, but its own failure is caught
    // and never surfaces as (or replaces) the test-send's own result below.
    const now = new Date().toISOString();
    const deliveryUpdate = result.ok
      ? { 'notification_delivery.last_success_at': now }
      : {
          'notification_delivery.last_error': {
            at: now,
            code: result.status !== undefined ? String(result.status) : 'network_error',
            message: result.error ?? 'Unknown error',
          },
        };
    try {
      await collections.projects().doc(params.projectId).update(deliveryUpdate);
    } catch (err) {
      console.warn(`[test-webhook] Failed to record delivery outcome for ${params.projectId}:`, err);
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
