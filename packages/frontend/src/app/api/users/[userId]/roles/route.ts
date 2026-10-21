import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import { validateBody } from '@arbitra/backend';
import { updateUserRolesSchema } from '@arbitra/shared';

/**
 * PATCH /api/users/:userId/roles — Update a user's roles.
 * Requires the calling user to be an admin.
 *
 * The admin gate below and the last-admin guard further down are inline
 * checks (see `route.test.ts`'s pinning tests) — left as-is. This route was
 * missing Zod body validation; `updateUserRolesSchema` (PR #741) replaces
 * the hand-rolled array/enum check without changing its behavior.
 */
export async function PATCH(request: NextRequest, props: { params: Promise<{ userId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const { collections } = await import('@arbitra/backend');

    // Only admins can change roles
    const callerDoc = await collections.users().doc(auth.userId).get();
    const callerRoles: string[] = callerDoc.exists ? (callerDoc.data()!.roles ?? []) : [];
    if (!callerRoles.includes('admin')) {
      return NextResponse.json({ error: { message: 'Admin role required' } }, { status: 403 });
    }

    const body = await request.json();
    const { roles } = validateBody(updateUserRolesSchema, body);

    // Ensure the target user exists
    const targetRef = collections.users().doc(params.userId);
    const targetDoc = await targetRef.get();
    if (!targetDoc.exists) {
      return NextResponse.json({ error: { message: 'User not found' } }, { status: 404 });
    }

    // Prevent removing admin from the last remaining admin user
    const targetData = targetDoc.data()!;
    const isRemovingAdmin = targetData.roles?.includes('admin') && !roles.includes('admin');
    if (isRemovingAdmin) {
      const allUsersSnap = await collections.users().get();
      const adminCount = allUsersSnap.docs.filter(
        (d) => d.data().roles?.includes('admin'),
      ).length;
      if (adminCount <= 1) {
        return NextResponse.json(
          { error: { message: 'Cannot remove admin role from the last admin user' } },
          { status: 409 },
        );
      }
    }

    await targetRef.update({
      roles,
      updated_at: new Date().toISOString(),
    });

    const updated = await targetRef.get();
    return NextResponse.json(updated.data());
  } catch (error) {
    return handleError(error);
  }
}
