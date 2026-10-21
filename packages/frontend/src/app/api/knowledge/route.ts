import { NextRequest, NextResponse } from 'next/server';
import { createKnowledgeSchema } from '@arbitra/shared';
import type { KnowledgeScopeType } from '@arbitra/shared';
import { authenticate, handleError, requireCaseAccess, requireProjectAccess } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

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
 * Duplicated verbatim in `[knowledgeId]/route.ts` and
 * `[knowledgeId]/status/route.ts` — small enough that a shared module wasn't worth the extra
 * indirection.
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

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const { collections, checkIsAdmin, getAccessibleProjectIds } = await import('@arbitra/backend');
    const snapshot = await collections.knowledgeAssets().get();
    const assets = snapshot.docs.map((doc) => doc.data());

    const isAdmin = await checkIsAdmin(auth.userId);
    if (isAdmin) {
      return NextResponse.json({ assets });
    }

    const accessibleIds = await getAccessibleProjectIds(auth.userId, false);
    if (accessibleIds === 'all') {
      return NextResponse.json({ assets });
    }
    const accessibleSet = new Set(accessibleIds);

    // Repo-scoped assets resolve to a project via the Repository doc; batch
    // the unique repo ids once instead of a Firestore read per asset.
    const repoIds = [...new Set(
      assets.filter((asset) => asset.scope_type === 'repo').map((asset) => asset.scope_ref),
    )];
    const repoProjectMap = new Map<string, string | undefined>();
    await Promise.all(
      repoIds.map(async (repoId) => {
        const repoDoc = await collections.repositories().doc(repoId).get();
        repoProjectMap.set(repoId, repoDoc.exists ? repoDoc.data()!.project_id : undefined);
      }),
    );

    const visibleAssets = assets.filter((asset) => {
      if (asset.scope_type === 'project') return accessibleSet.has(asset.scope_ref);
      if (asset.scope_type === 'repo') {
        const projectId = repoProjectMap.get(asset.scope_ref);
        return projectId !== undefined && accessibleSet.has(projectId);
      }
      return true; // global/org/team: visible to every authenticated user
    });

    return NextResponse.json({ assets: visibleAssets });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const { validateBody } = await import('@arbitra/backend');
    const input = validateBody(createKnowledgeSchema, await request.json());

    const scopeDenied = await requireKnowledgeScopeAccess(input.scope_type, input.scope_ref, auth.userId);
    if (scopeDenied) return scopeDenied;

    const hasSourceRefs = input.source_case_refs?.length || input.source_decision_refs?.length;
    const { collections } = hasSourceRefs ? await import('@arbitra/backend') : { collections: null };

    for (const caseId of input.source_case_refs ?? []) {
      const caseDoc = await collections!.cases().doc(caseId).get();
      if (!caseDoc.exists) {
        return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
      }
      const denied = await requireCaseAccess(caseId, auth.userId);
      if (denied) return denied;
    }

    if (input.source_decision_refs?.length) {
      for (const decisionId of input.source_decision_refs) {
        const decisionDoc = await collections!.decisions().doc(decisionId).get();
        if (!decisionDoc.exists) {
          return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
        }
        const caseId = decisionDoc.data()!.case_id;
        const caseDoc = await collections!.cases().doc(caseId).get();
        if (!caseDoc.exists) {
          return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
        }
        const denied = await requireCaseAccess(caseId, auth.userId);
        if (denied) return denied;
      }
    }

    // No role-gate on creation: any authenticated user with access to the
    // target scope/cases can propose a knowledge asset (e.g. via the
    // Courtroom Knowledge Capture Prompt). New assets always land as
    // `suggested` inside KnowledgeService.createAsset — verification
    // (suggested -> verified -> canonical) is gated separately in
    // updateStatus.
    const { KnowledgeService } = await import('@arbitra/backend');
    const service = new KnowledgeService();
    const asset = await service.createAsset(input, auth.userId);
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
