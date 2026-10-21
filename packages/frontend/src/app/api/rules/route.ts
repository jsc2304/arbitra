import { NextRequest, NextResponse } from 'next/server';
import type { Rule, RuleScope } from '@arbitra/shared';
import { createRuleSchema } from '@arbitra/shared';
import { authenticate, handleError, requireProjectScopedRole, validate } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/rules — lists all rules + rule sets. Governance-relevant but
 * read-only, so no role gate (mirrors evidence-policies GET) — only project
 * scoping: global-layer rules and project-less rule sets stay visible
 * to every authenticated user, project-scoped rows are filtered down to the
 * caller's accessible projects (mirrors `/api/cases` GET / `rules/overrides`
 * GET's `getAccessibleProjectIds` pattern).
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const { collections, checkIsAdmin, getAccessibleProjectIds } = await import('@arbitra/backend');
    const [ruleSetsSnap, rulesSnap] = await Promise.all([
      collections.ruleSets().get(),
      collections.rules().get(),
    ]);
    let ruleSets = ruleSetsSnap.docs.map((doc) => doc.data());
    let rules = rulesSnap.docs.map((doc) => doc.data());

    const isAdmin = await checkIsAdmin(auth.userId);
    if (!isAdmin) {
      const accessibleIds = await getAccessibleProjectIds(auth.userId, false);
      if (accessibleIds !== 'all') {
        const accessibleSet = new Set(accessibleIds);
        rules = rules.filter((r) => r.scope.layer === 'global' || accessibleSet.has(r.scope.ref));
        ruleSets = ruleSets.filter((rs) => !rs.project_id || accessibleSet.has(rs.project_id));
      }
    }

    return NextResponse.json({ ruleSets, rules });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * POST /api/rules — creates a rule. Role-gated: a project-scoped
 * rule requires the caller be an effective member holding `tech_lead`/`admin`
 * on `scope.ref`'s project (`requireProjectScopedRole`, layered project-access
 * + role check); a global-scope rule is admin-only (there is no project to
 * scope the tech_lead check to — same posture `rules/overrides/route.ts`
 * uses for its global branch).
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const input = validate(createRuleSchema, await request.json());

    if (input.scope.layer === 'project') {
      const denied = await requireProjectScopedRole(auth.userId, input.scope.ref as string, ['tech_lead', 'admin']);
      if (denied) return denied;
    } else {
      const { requireRole } = await import('@arbitra/backend');
      await requireRole(auth.userId, ['admin']);
    }

    const now = new Date().toISOString();
    const { generateId, collections } = await import('@arbitra/backend');
    const rule: Rule = {
      rule_id: generateId('rule'),
      name: input.name,
      category: input.category,
      scope: input.scope as RuleScope,
      evaluation_mode: input.evaluation_mode,
      severity_if_failed: input.severity_if_failed,
      description: input.description,
      rationale: input.rationale,
      config: input.config ?? {},
      status: 'draft',
      version: 1,
      created_at: now,
      updated_at: now,
      updated_by: auth.userId,
    };
    await collections.rules().doc(rule.rule_id).set(rule);
    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
