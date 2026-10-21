import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';
import type { Case } from '@arbitra/shared';

export const dynamic = 'force-dynamic';

interface RelatedCaseGroup {
  relation: 'branch' | 'repository' | 'project' | 'owner';
  label: string;
  value: string;
  cases: Case[];
}

export async function GET(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const { caseId } = params;

    const auth = await authenticate(request);
    const denied = await requireCaseAccess(caseId, auth.userId);
    if (denied) return denied;

    // Production: query Firestore for related cases
    const { CaseRepository } = await import('@arbitra/backend');
    const caseRepo = new CaseRepository();
    const current = await caseRepo.getById(caseId);
    const groups: RelatedCaseGroup[] = [];

    const queries = await Promise.all([
      current.current_branch
        ? caseRepo.list({ current_branch: current.current_branch, limit: 20 })
        : null,
      current.repository_id
        ? caseRepo.list({ repository_id: current.repository_id, limit: 20 })
        : null,
      current.project_id
        ? caseRepo.list({ project_id: current.project_id, limit: 20 })
        : null,
    ]);

    if (queries[0] && current.current_branch) {
      const filtered = queries[0].cases.filter((c) => c.case_id !== caseId);
      if (filtered.length > 0) {
        groups.push({ relation: 'branch', label: 'Same Branch', value: current.current_branch, cases: filtered });
      }
    }

    if (queries[1] && current.repository_id) {
      const filtered = queries[1].cases.filter((c) => c.case_id !== caseId);
      if (filtered.length > 0) {
        groups.push({ relation: 'repository', label: 'Same Repository', value: current.repository_id, cases: filtered });
      }
    }

    if (queries[2] && current.project_id) {
      const filtered = queries[2].cases.filter((c) => c.case_id !== caseId);
      if (filtered.length > 0) {
        groups.push({ relation: 'project', label: 'Same Project', value: current.project_id, cases: filtered });
      }
    }

    return NextResponse.json({ groups });
  } catch (error) {
    return handleError(error);
  }
}
