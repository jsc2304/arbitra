import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const idsParam = request.nextUrl.searchParams.get('ids');
    const ids = idsParam ? idsParam.split(',').filter(Boolean) : undefined;

    // Production: authenticate all requests
    const auth = await authenticate(request);
    const { collections } = await import('@arbitra/backend');
    const usersCol = collections.users();

    if (ids && ids.length > 0) {
      // Batch lookup by IDs — available to any authenticated user
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += 30) {
        chunks.push(ids.slice(i, i + 30));
      }

      const users = [];
      for (const chunk of chunks) {
        const snapshot = await usersCol.where('user_id', 'in', chunk).get();
        users.push(...snapshot.docs.map((doc) => doc.data()));
      }
      return NextResponse.json({ users });
    }

    // No IDs specified — full user list requires admin role
    const callerDoc = await usersCol.doc(auth.userId).get();
    const callerRoles: string[] = callerDoc.exists ? (callerDoc.data()!.roles ?? []) : [];
    if (!callerRoles.includes('admin')) {
      return NextResponse.json(
        { error: { message: 'Admin role required to list all users' } },
        { status: 403 },
      );
    }

    const snapshot = await usersCol.get();
    return NextResponse.json({ users: snapshot.docs.map((doc) => doc.data()) });
  } catch (error) {
    return handleError(error);
  }
}
