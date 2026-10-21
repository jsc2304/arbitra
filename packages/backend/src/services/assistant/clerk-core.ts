import { createHash } from 'node:crypto';

/**
 * Deterministic document ids for one user's Clerk core (the private `Clerk`
 * project, its placeholder repository, and its evidence policy).
 *
 * **This convention is shared with `scripts/setup-clerk-core.ts`** — that script
 * provisions the three documents, this module resolves them at intake time.
 * Both halves derive the ids from the user id alone, so neither has to store a
 * pointer to the other; the flip side is that any change to the salt, the
 * digest, the suffix length, or the prefixes must land in BOTH places or intake
 * starts writing cases against a project that was never provisioned.
 * `clerk-core.test.ts` pins the derived values against golden ids and pins the
 * script's literals, so a one-sided change fails the suite instead of failing
 * in production.
 *
 * Shape (verbatim from the script): the sha256 of `<salt>\0<userId>`, hex,
 * first 24 characters, behind a per-entity prefix. The NUL separator keeps the
 * salt and the user id from being ambiguously concatenable.
 */
export const CLERK_CORE_ID_SALT = 'arbitra-clerk-core';

/** Hex characters of the digest that end up in the document id. */
export const CLERK_CORE_ID_SUFFIX_LENGTH = 24;

export interface ClerkCoreIds {
  projectId: string;
  repositoryId: string;
  policyId: string;
}

/**
 * The user is identified by Firestore document id / Firebase UID, never by
 * email: project access checks use that immutable id, and an email can be
 * reassigned — which would silently re-point a data-protection boundary.
 */
export function clerkCoreIds(userId: string): ClerkCoreIds {
  const suffix = createHash('sha256')
    .update(`${CLERK_CORE_ID_SALT}\0${userId}`)
    .digest('hex')
    .slice(0, CLERK_CORE_ID_SUFFIX_LENGTH);

  return {
    projectId: `proj_clerk_${suffix}`,
    repositoryId: `repo_clerk_${suffix}`,
    policyId: `ep_clerk_${suffix}`,
  };
}
