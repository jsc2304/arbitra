import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { CreateKnowledgeAssetInput, KnowledgeAsset } from '@arbitra/shared';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * The `KnowledgeAsset.type` every entry created through this route carries.
 * Fixed by the route, never by the caller (#832 slice A — the context tab
 * has no type selector; see the module doc on `[knowledgeId]/route.ts`).
 */
const CONTEXT_TYPE = 'clerk_context' as const;

const createContextEntrySchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  always_inject: z.boolean().optional(),
});

/**
 * Short, non-sensitive summary for `KnowledgeAsset.summary`, which this
 * surface has no UI field for (`docs/specs/clerk-config-scheduling-chat.md`,
 * slice A: "title, body … no type/scope selectors" — no summary field
 * either). Mirrors `answerPreview` in `assistant-prompt.ts`: collapse
 * whitespace, elide past the limit.
 */
function summarizeContextBody(body: string): string {
  const collapsed = body.trim().replace(/\s+/g, ' ');
  return collapsed.length <= 200 ? collapsed : `${collapsed.slice(0, 199)}…`;
}

/**
 * `GET /api/assistant/context` — the signed-in user's own Clerk context
 * entries: knowledge assets scoped to their private Clerk project
 * (`clerkCoreIds`), narrowed to `type: 'clerk_context'` so an unrelated
 * asset that happens to share the scope (e.g. created through the generic
 * `/api/knowledge` route by an admin) never shows up on this tab.
 *
 * There is nothing to authorize beyond identity: `clerkCoreIds` derives the
 * scope from the session's own `auth.userId`, so there is no id a caller
 * could substitute to reach someone else's project.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const { clerkCoreIds, KnowledgeService } = await import('@arbitra/backend');
    const { projectId } = clerkCoreIds(auth.userId);
    const service = new KnowledgeService();
    const assets = await service.listByScope('project', projectId);
    const entries = assets.filter((asset) => asset.type === CONTEXT_TYPE);
    return NextResponse.json({ entries });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * `POST /api/assistant/context` — create one Clerk context entry in the
 * caller's OWN private Clerk project. `scope_type`/`scope_ref`/`type` are
 * all fixed by this route rather than accepted from the body — there is
 * nothing here a caller could point at someone else's data, which is what
 * makes ownership of the project the entire authorization (the identity the
 * write lands under always comes from the session, never the body).
 *
 * `status` is left at `KnowledgeService.createAsset`'s default
 * (`'suggested'`) — the context tab has no review workflow of its own.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const { clerkCoreIds, KnowledgeService, validateBody } = await import('@arbitra/backend');
    const validated = validateBody(createContextEntrySchema, await request.json());
    const { projectId } = clerkCoreIds(auth.userId);

    const input: CreateKnowledgeAssetInput = {
      type: CONTEXT_TYPE,
      title: validated.title,
      summary: summarizeContextBody(validated.body),
      body: validated.body,
      scope_type: 'project',
      scope_ref: projectId,
      ...(validated.always_inject !== undefined ? { always_inject: validated.always_inject } : {}),
    };

    const service = new KnowledgeService();
    const entry: KnowledgeAsset = await service.createAsset(input, auth.userId);
    return NextResponse.json({ entry }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
