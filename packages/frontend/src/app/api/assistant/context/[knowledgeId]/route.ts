import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { UpdateKnowledgeAssetInput } from '@arbitra/shared';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * `PATCH/DELETE /api/assistant/context/[knowledgeId]` — the owner write path
 * for Clerk context entries (#832 slice A). The generic
 * `PATCH/DELETE /api/knowledge/[knowledgeId]` gates on the global
 * `tech_lead`/`admin` role (`role-middleware.ts:12-32`), so a regular user
 * can create a knowledge asset in their own private Clerk project but never
 * edit or delete it there.
 *
 * Ownership is asserted INSIDE `KnowledgeService.updateAssetAsOwner`/
 * `deleteAssetAsOwner`, not here: this route resolves the caller's own
 * private project id (`clerkCoreIds`) and passes it as `expectedScopeRef`;
 * the service throws `NotFoundError` on any mismatch — foreign scope, wrong
 * type, or a genuinely missing asset all land on the identical 404 below,
 * via `handleError` — so a future caller of those service methods cannot
 * mutate an arbitrary asset even if a route forgets its own check. That
 * also means this route does not fetch the asset itself before writing:
 * the single `getById` read inside the service covers both the ownership
 * check and the load, where an earlier version of this route paid for that
 * read twice (once here, once inside the service).
 */
const updateContextEntrySchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    body: z.string().trim().min(1).optional(),
    always_inject: z.boolean().optional(),
  })
  .strict();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ knowledgeId: string }> },
): Promise<NextResponse> {
  const { knowledgeId } = await params;
  try {
    const auth = await authenticate(request);
    const { clerkCoreIds, KnowledgeService, validateBody } = await import('@arbitra/backend');
    const update: UpdateKnowledgeAssetInput = validateBody(
      updateContextEntrySchema,
      await request.json(),
    );
    const { projectId } = clerkCoreIds(auth.userId);
    const service = new KnowledgeService();
    const entry = await service.updateAssetAsOwner(knowledgeId, update, auth.userId, projectId);
    return NextResponse.json({ entry });
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ knowledgeId: string }> },
): Promise<NextResponse> {
  const { knowledgeId } = await params;
  try {
    const auth = await authenticate(request);
    const { clerkCoreIds, KnowledgeService } = await import('@arbitra/backend');
    const { projectId } = clerkCoreIds(auth.userId);
    const service = new KnowledgeService();
    await service.deleteAssetAsOwner(knowledgeId, auth.userId, projectId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleError(error);
  }
}
