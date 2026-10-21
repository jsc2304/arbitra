import { NextRequest, NextResponse } from 'next/server';
import type { RuleSet } from '@arbitra/shared';
import { updateRuleSetSchema } from '@arbitra/shared';
import { authenticate, handleError, requireProjectScopedRole, validate } from '@/lib/api-helpers';

/**
 * PATCH /api/rule-sets/:ruleSetId — the resource is loaded FIRST and the
 * role gate is evaluated against the *stored* rule set's own `project_id`
 * (never a client-supplied body field — `project_id` isn't patchable, so
 * there's nothing to spoof, but gating on the loaded doc keeps the pattern
 * uniform with `rules/[ruleId]/route.ts`). Project-scoped rule sets require
 * `tech_lead`/`admin` + project membership (`requireProjectScopedRole`);
 * unscoped (global) rule sets are admin-only.
 */
export async function PATCH(request: NextRequest, props: { params: Promise<{ ruleSetId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const { collections } = await import('@arbitra/backend');
    const docRef = collections.ruleSets().doc(params.ruleSetId);
    const doc = await docRef.get();
    if (!doc.exists) {
      return NextResponse.json({ error: { message: 'Rule set not found' } }, { status: 404 });
    }
    const ruleSet = doc.data() as RuleSet;

    if (ruleSet.project_id) {
      const denied = await requireProjectScopedRole(auth.userId, ruleSet.project_id, ['tech_lead', 'admin']);
      if (denied) return denied;
    } else {
      const { requireRole } = await import('@arbitra/backend');
      await requireRole(auth.userId, ['admin']);
    }

    const input = validate(updateRuleSetSchema, await request.json());

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
