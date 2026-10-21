import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import { buildObservatoryAggregate } from './observatory-helpers';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const daysParam = request.nextUrl.searchParams.get('days');
  const days = daysParam ? parseInt(daysParam, 10) : null;
  const validDays = days && !isNaN(days) && days > 0 ? days : null;

  try {
    const auth = await authenticate(request);
    const { checkIsAdmin } = await import('@arbitra/backend');
    const admin = await checkIsAdmin(auth.userId);
    return NextResponse.json(await buildObservatoryAggregate(auth.userId, admin, validDays));
  } catch (error) {
    return handleError(error);
  }
}
