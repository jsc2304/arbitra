import { NextRequest, NextResponse } from 'next/server';
import type { Rule } from '@arbitra/shared';
import { updateRuleSchema } from '@arbitra/shared';
import { authenticate, handleError, requireProjectScopedRole, validate } from '@/lib/api-helpers';

/**
 * PATCH /api/rules/:ruleId — the resource is loaded FIRST and the role gate
 * is evaluated against the *stored* rule's own `scope` (never a client-
 * supplied body field): a tech_lead of project X must not be able to mutate
 * a project-Y-scoped rule by simply calling the endpoint — there is no
 * `scope` in the request body to spoof (it isn't patchable), but gating on
 * the loaded doc rather than re-deriving scope from input keeps this route
 * correct even if a future PATCH ever allowed re-scoping. Project-scoped
 * rules require `tech_lead`/`admin` + project membership
 * (`requireProjectScopedRole`); global-scope rules are admin-only, mirroring
 * the `rules/overrides/route.ts` posture.
 */
export async function PATCH(request: NextRequest, props: { params: Promise<{ ruleId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const { collections } = await import('@arbitra/backend');
    const docRef = collections.rules().doc(params.ruleId);
    const doc = await docRef.get();
    if (!doc.exists) {
      return NextResponse.json({ error: { message: 'Rule not found' } }, { status: 404 });
    }
    const rule = doc.data() as Rule;

    if (rule.scope.layer === 'project') {
      const denied = await requireProjectScopedRole(auth.userId, rule.scope.ref, ['tech_lead', 'admin']);
      if (denied) return denied;
    } else {
      const { requireRole } = await import('@arbitra/backend');
      await requireRole(auth.userId, ['admin']);
    }

    const input = validate(updateRuleSchema, await request.json());

    if (Object.keys(input).length === 0) {
      return NextResponse.json(
        { error: { message: 'No valid fields to update' } },
        { status: 400 },
      );
    }

    await docRef.update({ ...input, updated_at: new Date().toISOString(), updated_by: auth.userId });
    const updated = await docRef.get();
    return NextResponse.json(updated.data());
  } catch (error) {
    return handleError(error);
  }
}
