import { NextRequest, NextResponse } from 'next/server';
import { TaskBlueprintService, validateBody } from '@arbitra/backend';
import { createTaskBlueprintSchema } from '@arbitra/shared';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const blueprintService = new TaskBlueprintService();

/**
 * `GET /api/assistant/blueprints` — the signed-in user's own blueprints.
 *
 * Modeled on `GET /api/assistant/credentials`: scoped to `auth.userId` from
 * the session, never a query parameter — there is no admin bypass, an admin
 * calling this sees only their OWN blueprints.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const blueprints = await blueprintService.list(auth.userId);
    return NextResponse.json({ blueprints });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * `POST /api/assistant/blueprints` — create a new Task Blueprint owned by
 * the signed-in user. Version starts at 1; `project_id` is derived from the
 * caller's own Clerk core (`clerkCoreIds`), never accepted from the body.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const body = await request.json();
    const input = validateBody(createTaskBlueprintSchema, body);

    const blueprint = await blueprintService.create(auth.userId, input);
    return NextResponse.json({ blueprint }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
