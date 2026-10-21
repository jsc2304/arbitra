import { NextRequest, NextResponse } from 'next/server';
import { collections } from '@arbitra/backend';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, props: { params: Promise<{ caseId: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;
    const snapshot = await collections.findings().where('case_id', '==', params.caseId).get();
    const findings = snapshot.docs.map((doc) => doc.data());
    return NextResponse.json({ findings, count: findings.length });
  } catch (error) {
    return handleError(error);
  }
}
