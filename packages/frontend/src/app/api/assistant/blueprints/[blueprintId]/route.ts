import { NextRequest, NextResponse } from 'next/server';
import { TaskBlueprintService, validateBody } from '@arbitra/backend';
import { updateTaskBlueprintSchema } from '@arbitra/shared';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const blueprintService = new TaskBlueprintService();

/**
 * `GET /api/assistant/blueprints/[blueprintId]` — one blueprint. Owner-only:
 * `TaskBlueprintService.get` throws a 403 (not a leak-avoiding 404) for a
 * blueprint that exists but belongs to someone else.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ blueprintId: string }> },
): Promise<NextResponse> {
  const { blueprintId } = await params;
  try {
    const auth = await authenticate(request);
    const blueprint = await blueprintService.get(blueprintId, auth.userId);
    return NextResponse.json({ blueprint });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * `PATCH /api/assistant/blueprints/[blueprintId]` — partial update. Bumps
 * `version`; blocked (409) on an archived blueprint. `.strict()` +
 * "at least one field" are enforced by `updateTaskBlueprintSchema` before the
 * service is ever called.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ blueprintId: string }> },
): Promise<NextResponse> {
  const { blueprintId } = await params;
  try {
    const auth = await authenticate(request);
    const body = await request.json();
    const input = validateBody(updateTaskBlueprintSchema, body);

    const blueprint = await blueprintService.update(blueprintId, auth.userId, input);
    return NextResponse.json({ blueprint });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * `DELETE /api/assistant/blueprints/[blueprintId]` — archive, not a hard
 * delete. Terminal in v1 (no unarchive flow) and idempotent: archiving an
 * already-archived blueprint is a no-op 200, not a 404.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ blueprintId: string }> },
): Promise<NextResponse> {
  const { blueprintId } = await params;
  try {
    const auth = await authenticate(request);
    const blueprint = await blueprintService.archive(blueprintId, auth.userId);
    return NextResponse.json({ blueprint });
  } catch (error) {
    return handleError(error);
  }
}
