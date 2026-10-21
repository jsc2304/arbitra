import { NextRequest, NextResponse } from 'next/server';
import { buildPolicyRulesFromPreset, createEvidencePolicySchema } from '@arbitra/shared';
import { authenticate, handleError, requireProjectScopedRole, validate } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

// Filter to the caller's accessible projects (mirrors `/api/cases`
// GET). Every `EvidencePolicy` doc carries a required `project_id` — there
// is no global-scope row for this collection — so a non-member/non-admin
// simply sees nothing for projects they aren't on.
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const { checkIsAdmin, getAccessibleProjectIds, collections } = await import('@arbitra/backend');
    const snapshot = await collections.evidencePolicies().get();
    let policies = snapshot.docs.map((doc) => doc.data());

    const isAdmin = await checkIsAdmin(auth.userId);
    if (!isAdmin) {
      const accessibleIds = await getAccessibleProjectIds(auth.userId, false);
      if (accessibleIds !== 'all') {
        const accessibleSet = new Set(accessibleIds);
        policies = policies.filter((p) => accessibleSet.has(p.project_id));
      }
    }

    return NextResponse.json({ policies });
  } catch (error) {
    return handleError(error);
  }
}

// Role-gated to tech_lead / admin *of the target project*:
// `requireProjectScopedRole` checks project membership before the global
// role check, so a global tech_lead who isn't on `project_id` can no longer
// create/replace another project's policy (denied 404, not 403 — same
// posture `requireProjectAccess` uses elsewhere, avoiding an existence leak
// to an outsider). Validation runs first because the gate needs
// `input.project_id` out of the parsed body — same ordering the
// `POST /api/cases` handler and `rules/overrides/route.ts` use.
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const input = validate(createEvidencePolicySchema, await request.json());
    const denied = await requireProjectScopedRole(auth.userId, input.project_id, ['tech_lead', 'admin']);
    if (denied) return denied;
    const { collections, generateId } = await import('@arbitra/backend');
    // Enforce one evidence policy per project (issue #626). A project must own
    // at most one canonical `evidence_policies` doc; a second CREATE would
    // reintroduce the ambiguous-policy data shape the reader has to work around.
    // Edits go through PATCH on `[policyId]`, not a second POST.
    const existingSnap = await collections.evidencePolicies()
      .where('project_id', '==', input.project_id)
      .limit(1)
      .get();
    if (!existingSnap.empty) {
      const existingId = existingSnap.docs[0]!.data().policy_id;
      return NextResponse.json(
        {
          error: {
            code: 'POLICY_ALREADY_EXISTS',
            message: `An evidence policy already exists for project ${input.project_id}. Update it via PATCH instead of creating a second one.`,
            details: { existing_policy_id: existingId },
          },
        },
        { status: 409 },
      );
    }
    // A caller may declare repo capabilities via `preset` / `capabilities`
    // instead of an explicit `rules` map; expand them into a full risk-first
    // rules map. The schema guarantees exactly one source is supplied.
    const rules = input.rules ?? buildPolicyRulesFromPreset(input.preset ?? input.capabilities!);
    const now = new Date().toISOString();
    // `ep_${Date.now()}` collided under concurrent same-ms POSTs
    // (silent overwrite via `.set()`) — use the collision-resistant id
    // generator like every other entity type.
    const policyId = generateId('evidencePolicy');
    const policy = {
      policy_id: policyId,
      project_id: input.project_id,
      repository_id: input.repository_id,
      rules,
      version: 1,
      created_at: now,
      updated_at: now,
    };
    await collections.evidencePolicies().doc(policyId).set(policy);
    return NextResponse.json(policy, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
