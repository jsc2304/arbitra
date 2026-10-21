import { NextRequest, NextResponse } from 'next/server';
import { createRuleOverrideSchema } from '@arbitra/shared';
import { authenticate, handleError, requireProjectAccess, validate } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * POST /api/rules/overrides — create a RuleOverride, resolving the matching
 * `rule_override_conflict` finding(s) (see `RuleOverrideService`).
 *
 * Authz follows the governance-route pattern (`authenticate` -> Zod body validation ->
 * project/role access — validation runs before the access check here
 * because the check needs `scope` out of the parsed body, same ordering
 * the `POST /api/cases` handler uses), adapted from
 * `evidence-policies/route.ts`'s `requireRole(['tech_lead', 'admin'])`
 * plus the project-scope rule for rules/rule-sets: a project-scoped
 * override additionally requires membership in that project; a global-scope
 * override (both rules global) is admin-only.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const input = validate(createRuleOverrideSchema, await request.json());

    const { requireRole, RuleOverrideService } = await import('@arbitra/backend');

    if (input.scope.layer === 'project') {
      const denied = await requireProjectAccess(input.scope.ref, auth.userId);
      if (denied) return denied;
      await requireRole(auth.userId, ['tech_lead', 'admin']);
    } else {
      // Global-scope creation is admin only (mirrors the rule for
      // global-scope rules/rule-sets — there is no "project" to scope the
      // tech_lead check to).
      await requireRole(auth.userId, ['admin']);
    }

    const service = new RuleOverrideService();
    const override = await service.createOverride(input, auth.userId);
    return NextResponse.json(override, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * GET /api/rules/overrides?rule_id=&overriding_rule_id= — list overrides.
 * Project-scoped overrides are filtered to the caller's accessible projects
 * (mirrors the `/api/cases` GET pattern); global-scope overrides always
 * show. No role gate — reading existing overrides is not governance-mutating.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const { RuleOverrideService, checkIsAdmin, getAccessibleProjectIds } = await import('@arbitra/backend');

    const params = request.nextUrl.searchParams;
    const ruleId = params.get('rule_id') ?? undefined;
    const overridingRuleId = params.get('overriding_rule_id') ?? undefined;

    const service = new RuleOverrideService();
    let overrides = await service.listOverrides({
      rule_id: ruleId,
      overriding_rule_id: overridingRuleId,
    });

    const isAdmin = await checkIsAdmin(auth.userId);
    if (!isAdmin) {
      const accessibleIds = await getAccessibleProjectIds(auth.userId, false);
      if (accessibleIds !== 'all') {
        const accessibleSet = new Set(accessibleIds);
        overrides = overrides.filter(
          (o) => o.scope.layer === 'global' || accessibleSet.has(o.scope.ref),
        );
      }
    }

    return NextResponse.json({ overrides });
  } catch (error) {
    return handleError(error);
  }
}
