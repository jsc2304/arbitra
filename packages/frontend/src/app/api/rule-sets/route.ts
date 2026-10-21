import { NextRequest, NextResponse } from 'next/server';
import type { RuleSet } from '@arbitra/shared';
import { createRuleSetSchema } from '@arbitra/shared';
import { validateBody } from '@arbitra/backend';
import { authenticate, handleError, requireProjectScopedRole } from '@/lib/api-helpers';

/**
 * POST /api/rule-sets — creates a rule set. Role-gated, same
 * layered pattern as `rules/route.ts` POST: a project-scoped rule set
 * (`project_id` present) requires `tech_lead`/`admin` + membership on that
 * project (`requireProjectScopedRole`); an unscoped (global) rule set is
 * admin-only.
 *
 * Uses `validateBody` (not the `validate` wrapper) directly: `createRuleSetSchema`
 * has `.default()`-bearing fields (`description`/`rule_refs`/`status`), and
 * `validate`'s `ZodSchema<T>`-typed parameter collapses T's defaulted fields
 * back to `| undefined` at this call site (a pre-existing `api-helpers.ts`
 * generics quirk, out of scope here per the task brief — `validateBody` is
 * the same underlying validator, just without the wrapper's narrower type,
 * and is already how `cases/route.ts` calls it).
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const input = validateBody(createRuleSetSchema, await request.json());

    if (input.project_id) {
      const denied = await requireProjectScopedRole(auth.userId, input.project_id, ['tech_lead', 'admin']);
      if (denied) return denied;
    } else {
      const { requireRole } = await import('@arbitra/backend');
      await requireRole(auth.userId, ['admin']);
    }

    const now = new Date().toISOString();
    const { generateId, collections } = await import('@arbitra/backend');
    const ruleSet: RuleSet = {
      rule_set_id: generateId('ruleSet'),
      name: input.name,
      description: input.description,
      project_id: input.project_id,
      rule_refs: input.rule_refs,
      status: input.status,
      version: 1,
      created_at: now,
      updated_at: now,
      updated_by: auth.userId,
    };
    await collections.ruleSets().doc(ruleSet.rule_set_id).set(ruleSet);
    return NextResponse.json(ruleSet, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
