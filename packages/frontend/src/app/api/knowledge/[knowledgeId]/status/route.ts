import { NextRequest, NextResponse } from 'next/server';
import { updateKnowledgeStatusSchema } from '@arbitra/shared';
import type { KnowledgeScopeType, UserRole } from '@arbitra/shared';
import { authenticate, handleError, requireProjectAccess } from '@/lib/api-helpers';

/**
 * Resolves a knowledge scope to the project id that governs read/write
 * access, or `null` when the scope carries no project restriction —
 * `global`/`org`/`team` stay visible/writable org-wide (mirroring the "global rows stay visible" rule of the other
 * governance collections).
 * `repo` scope resolves via the Repository doc's `project_id` (a repo
 * belongs to exactly one project — see `docs/page.tsx`'s scope table:
 * `scope_ref` for `repo` is the `repository_id`). An unresolvable repo id
 * denies (404) rather than silently allowing — unlike `checkCaseAccess`'s
 * "orphaned = allow", there's no downstream 404 for a bad `scope_ref` to
 * fall back on here.
 *
 * Duplicated verbatim in `../route.ts` and `../[knowledgeId]/route.ts` —
 * small enough that a shared module wasn't worth the extra indirection.
 */
async function requireKnowledgeScopeAccess(
  scopeType: KnowledgeScopeType,
  scopeRef: string,
  userId: string,
): Promise<NextResponse | null> {
  const { collections } = await import('@arbitra/backend');
  if (scopeType === 'project') {
    const projectDoc = await collections.projects().doc(scopeRef).get();
    if (!projectDoc.exists) {
      return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    }
    return requireProjectAccess(scopeRef, userId);
  }
  if (scopeType === 'repo') {
    const repoDoc = await collections.repositories().doc(scopeRef).get();
    if (!repoDoc.exists) {
      return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    }
    const projectId = repoDoc.data()!.project_id;
    const projectDoc = await collections.projects().doc(projectId).get();
    if (!projectDoc.exists) {
      return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    }
    return requireProjectAccess(projectId, userId);
  }
  return null; // global/org/team: visible/writable by every authenticated user
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ knowledgeId: string }> },
) {
  const { knowledgeId } = await params;
  try {
    const auth = await authenticate(request);
    const { KnowledgeService, validateBody } = await import('@arbitra/backend');
    const { status } = validateBody(updateKnowledgeStatusSchema, await request.json());

    const service = new KnowledgeService();
    const asset = await service.getAsset(knowledgeId);

    const denied = await requireKnowledgeScopeAccess(asset.scope_type, asset.scope_ref, auth.userId);
    if (denied) return denied;

    // Verified and canonical transitions are tech_lead/admin only — the same
    // role gate that updateAsset/deleteAsset use. Only read the user doc for
    // targets that need roles; all other transitions stay free.
    let actorRoles: UserRole[] = [];
    if (status === 'verified' || status === 'canonical') {
      const { collections } = await import('@arbitra/backend');
      const userDoc = await collections.users().doc(auth.userId).get();
      actorRoles = userDoc.exists
        ? ((userDoc.data()?.roles ?? []) as UserRole[])
        : [];
    }

    const updated = await service.updateStatus(knowledgeId, status, auth.userId, actorRoles);
    return NextResponse.json({ asset: updated });
  } catch (error) {
    return handleError(error);
  }
}
