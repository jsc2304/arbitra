import { NextRequest, NextResponse } from 'next/server';
import { buildLeaderboard, checkIsAdmin } from '@arbitra/backend';
import type { ActivityLeaderboardWindow } from '@arbitra/shared';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const ALLOWED_WINDOWS: readonly ActivityLeaderboardWindow[] = ['24h', '7d', '30d'];

function parseWindow(raw: string | null): ActivityLeaderboardWindow {
  if (raw && (ALLOWED_WINDOWS as readonly string[]).includes(raw)) {
    return raw as ActivityLeaderboardWindow;
  }
  return '24h';
}

/**
 * GET /api/activity/leaderboard — activity overview aggregates for the
 * `/activity` page. Returns:
 * - `rows`: source-level counts grouped by `client_name + client_version + model`
 * - `project_rows`: case-scoped counts grouped by project
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const admin = await checkIsAdmin(auth.userId);

    const window = parseWindow(request.nextUrl.searchParams.get('window'));
    const data = await buildLeaderboard(auth.userId, admin, window);

    return NextResponse.json({ window, ...data });
  } catch (error) {
    return handleError(error);
  }
}
