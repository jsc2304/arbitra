import { NextRequest, NextResponse } from 'next/server';
import { NotificationService } from '@arbitra/backend';
import { authenticate, handleError } from '@/lib/api-helpers';

const notificationService = new NotificationService();

/**
 * POST /api/notifications/read-all — bulk mark-all-as-read (issue #794 P0).
 * The necessary companion to the drawer's new pagination: with a paginated
 * list, "mark all as read" can no longer be implemented client-side as
 * "mark every currently-loaded row" (`packages/frontend/src/providers/
 * notification-provider.tsx`'s previous per-item loop) without silently
 * leaving older, un-fetched unread rows behind. Scoped server-side to every
 * unread row the caller owns (`NotificationService.markAllAsRead`).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const count = await notificationService.markAllAsRead(auth.userId);
    return NextResponse.json({ status: 'ok', count });
  } catch (error) {
    return handleError(error);
  }
}
