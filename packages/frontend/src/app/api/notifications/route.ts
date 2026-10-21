import { NextRequest, NextResponse } from 'next/server';
import { NotificationService } from '@arbitra/backend';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const notificationService = new NotificationService();

/**
 * GET /api/notifications — cursor-paginated notification list (issue #794
 * P0). Both query params are optional and additive: a request with neither
 * (an old client predating this contract) still gets a valid first page,
 * same response shape (`notifications` was always the top-level key; only
 * `next_cursor`/`unread_count` are new).
 *
 * Query params:
 *   - `cursor` — the previous page's `next_cursor`, unchanged.
 *   - `limit` — page size, default/max enforced server-side
 *     (`NotificationRepository`'s `DEFAULT_PAGE_LIMIT`/`MAX_PAGE_LIMIT`).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get('cursor') ?? undefined;
    const limitRaw = searchParams.get('limit');
    const limit = limitRaw !== null ? Number(limitRaw) : undefined;

    const page = await notificationService.listNotifications(auth.userId, { cursor, limit });
    return NextResponse.json(page);
  } catch (error) {
    return handleError(error);
  }
}
