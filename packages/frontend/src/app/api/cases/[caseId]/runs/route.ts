import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const { caseId } = params;
    const status = request.nextUrl.searchParams.get('status');

    // Production: authenticate + access check
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(caseId, auth.userId);
    if (denied) return denied;

    const { collections } = await import('@arbitra/backend');
    let query = collections.runs().where('case_id', '==', caseId);
    if (status) {
      query = query.where('status', '==', status);
    }
    const snap = await query.orderBy('created_at', 'desc').get();
    const runs = snap.docs.map((d) => d.data());

    return NextResponse.json({ runs });
  } catch (error) {
    return handleError(error);
  }
}
