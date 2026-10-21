import type { UserRole } from '@arbitra/shared';
import { ForbiddenError } from '@arbitra/shared';
import { collections } from '../lib/firestore.js';

/**
 * Verifies the user holds at least one of `requiredRoles` and returns the
 * actor's full role list. Callers that need to pass the roles on to a
 * service (e.g. KnowledgeService) can use the return value instead of
 * issuing a second Firestore read. Returning `UserRole[]` is backward
 * compatible with existing `await requireRole(...)` usages.
 */
export async function requireRole(
  userId: string,
  requiredRoles: UserRole[],
): Promise<UserRole[]> {
  const userDoc = await collections.users().doc(userId).get();
  if (!userDoc.exists) {
    throw new ForbiddenError('User not found');
  }

  const user = userDoc.data()!;
  const hasRole = user.roles.some((role) => requiredRoles.includes(role));

  if (!hasRole) {
    throw new ForbiddenError(`Required role: ${requiredRoles.join(' or ')}`, {
      required_roles: requiredRoles,
      user_roles: user.roles,
    });
  }

  return user.roles;
}
