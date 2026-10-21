import { NextRequest, NextResponse } from 'next/server';
import {
  CaseService,
  validateBody,
  checkIsAdmin,
  getAccessibleProjectIds,
  isEffectiveMember,
  collections,
} from '@arbitra/backend';
import { caseFiltersSchema } from '@arbitra/shared';
import type { Case, CaseFilters } from '@arbitra/shared';
import { authenticate, handleError } from '@/lib/api-helpers';
import { buildObservatoryAggregate, type ObservatoryAggregate } from '../observatory/observatory-helpers';

export const dynamic = 'force-dynamic';

const caseService = new CaseService();

export type DashboardSection<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export type DashboardAggregate = {
  myCases: DashboardSection<{ cases: Case[] }>;
  needs_human_decision: DashboardSection<{ cases: Case[] }>;
  verification_pending: DashboardSection<{ cases: Case[] }>;
  observatory: DashboardSection<ObservatoryAggregate>;
};

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

/**
 * Load cases matching `filters` and apply the same project-access filtering
 * used by `GET /api/cases` (see packages/frontend/src/app/api/cases/route.ts).
 * Non-admins only see cases in projects they're effective members of.
 */
async function loadCases(
  rawFilters: Record<string, string>,
  userId: string,
  admin: boolean,
): Promise<{ cases: Case[] }> {
  const filters: CaseFilters = validateBody(caseFiltersSchema, rawFilters);

  if (filters.project_id && !admin) {
    const projectDoc = await collections.projects().doc(filters.project_id).get();
    if (projectDoc.exists && !isEffectiveMember(projectDoc.data()!, userId)) {
      return { cases: [] };
    }
  }

  const result = await caseService.listCases(filters);

  if (!admin) {
    const accessibleIds = await getAccessibleProjectIds(userId, false);
    if (accessibleIds !== 'all') {
      const accessibleSet = new Set(accessibleIds);
      result.cases = result.cases.filter((c) => accessibleSet.has(c.project_id));
    }
  }

  return { cases: result.cases };
}

/**
 * GET /api/dashboard — server-side fan-in for the dashboard view.
 *
 * Replaces 4 separate client requests (myCases, needs_human_decision,
 * verification_pending, observatory) with a single round-trip. Each section
 * is settled independently, so one failing query does not fail the whole
 * response. Sections surface as `{ ok: true, data }` or `{ ok: false, error }`
 * and the hook/consumer decides how to render partial data.
 *
 * Auth + access control match the underlying per-section routes:
 *  - `/api/cases` for the 3 case lists (project-membership filtering)
 *  - `/api/observatory` for the metrics/activity aggregate
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const admin = await checkIsAdmin(auth.userId);

    const [myCases, needsHumanDecision, verificationPending, observatory] = await Promise.allSettled([
      loadCases({ owner_user_id: auth.userId }, auth.userId, admin),
      loadCases({ status: 'needs_human_decision' }, auth.userId, admin),
      loadCases({ status: 'verification_pending' }, auth.userId, admin),
      buildObservatoryAggregate(auth.userId, admin, null),
    ]);

    const payload: DashboardAggregate = {
      myCases: myCases.status === 'fulfilled'
        ? { ok: true, data: myCases.value }
        : { ok: false, error: errorMessage(myCases.reason) },
      needs_human_decision: needsHumanDecision.status === 'fulfilled'
        ? { ok: true, data: needsHumanDecision.value }
        : { ok: false, error: errorMessage(needsHumanDecision.reason) },
      verification_pending: verificationPending.status === 'fulfilled'
        ? { ok: true, data: verificationPending.value }
        : { ok: false, error: errorMessage(verificationPending.reason) },
      observatory: observatory.status === 'fulfilled'
        ? { ok: true, data: observatory.value }
        : { ok: false, error: errorMessage(observatory.reason) },
    };

    return NextResponse.json(payload);
  } catch (error) {
    return handleError(error);
  }
}
