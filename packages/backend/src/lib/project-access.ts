import type { Project } from '@arbitra/shared';
import { collections } from './firestore.js';

/** Outcome of {@link checkArtifactCaseAccess}. */
export type ArtifactCaseAccessDecision = 'allowed' | 'not_found' | 'requester_only';

/** Returns deduplicated list of all user IDs with effective access to a project. */
export function getEffectiveMembers(project: Project): string[] {
  const set = new Set<string>();
  for (const m of project.members ?? []) set.add(m);
  for (const r of project.reviewer_pool) set.add(r);
  for (const t of project.tech_leads) set.add(t);
  if (project.owner_user_id) set.add(project.owner_user_id);
  return [...set];
}

/** Checks whether a user is an effective member of a project. */
export function isEffectiveMember(project: Project, userId: string): boolean {
  if (project.owner_user_id === userId) return true;
  if ((project.members ?? []).includes(userId)) return true;
  if (project.reviewer_pool.includes(userId)) return true;
  if (project.tech_leads.includes(userId)) return true;
  return false;
}

/**
 * Returns the projects the user has access to, or 'all' for admins.
 *
 * Same authority as `getAccessibleProjectIds` — that function is this one with
 * the documents thrown away. Callers that need more than the ids (a name, an
 * evidence policy) should use this instead of reading the collection a second
 * time: the read below is unbounded, so doing it twice per request doubles a
 * cost that already grows with the number of projects in the workspace.
 */
export async function getAccessibleProjects(userId: string, isAdmin: boolean): Promise<Project[] | 'all'> {
  if (isAdmin) return 'all';
  const snapshot = await collections.projects().get();
  return snapshot.docs.map((d) => d.data()).filter((p) => isEffectiveMember(p, userId));
}

/** Returns project IDs the user has access to, or 'all' for admins. */
export async function getAccessibleProjectIds(userId: string, isAdmin: boolean): Promise<string[] | 'all'> {
  const projects = await getAccessibleProjects(userId, isAdmin);
  return projects === 'all' ? 'all' : projects.map((p) => p.project_id);
}

/** Checks if a user has admin role in Firestore. */
export async function checkIsAdmin(userId: string): Promise<boolean> {
  const userDoc = await collections.users().doc(userId).get();
  return userDoc.exists ? (userDoc.data()!.roles ?? []).includes('admin') : false;
}

/**
 * Verifies a user has access to a case's project. Returns true if allowed.
 * Use this in individual case routes (GET/PATCH /api/cases/:id, sub-routes).
 */
export async function checkCaseAccess(caseId: string, userId: string): Promise<boolean> {
  const isAdmin = await checkIsAdmin(userId);
  if (isAdmin) return true;

  const caseDoc = await collections.cases().doc(caseId).get();
  // Issue #749 item 2: this used to `return true` on a missing case ("let
  // the route handle 404"), on the assumption every caller re-checked
  // existence before acting. `POST /api/cases/:caseId/artifacts` and
  // `POST /api/cases/:caseId/comments` both gate solely on this function
  // (via `requireCaseAccess`) and write unconditionally once it passes, so a
  // fail-open here let any authenticated user — not just a project member —
  // create an artifact or comment under a fabricated case id and read it
  // back via `GET /api/artifacts/:artifactId/content` (which shares this
  // gate through `checkArtifactCaseAccess`). Mirrors the orphaned-project
  // deny-by-default fix a few lines below.
  if (!caseDoc.exists) return false;

  // Soft-deleted cases should 404 for every sub-resource access too. Returning
  // false here causes `requireCaseAccess` to emit 404, matching the behavior
  // of `CaseRepository.getById` on the primary route.
  if (caseDoc.data()!.deleted_at) return false;

  const projectId = caseDoc.data()!.project_id;
  if (!projectId) return true; // no project = unrestricted

  const projectDoc = await collections.projects().doc(projectId).get();
  // This used to `return true` here ("orphaned
  // case = allow"), which meant ANY authenticated user — not just members —
  // got full read/write on a case whose project had been deleted (the only
  // real trigger: `DELETE /api/projects/:id`, admin-only, which deletes the
  // project + its repositories but never cascades to the cases that
  // reference it). No test or documented recovery flow relied on the
  // fail-open behavior, and admins already bypass via the `isAdmin` check
  // above, so flipping to deny-by-default closes a cross-tenant exposure
  // with no loss of legitimate access: a case orphaned by project deletion
  // now requires an admin to re-home it (see `CaseService.updateCase`'s
  // project_id-change guard) instead of being world-readable in the
  // meantime.
  if (!projectDoc.exists) return false;

  return isEffectiveMember(projectDoc.data()!, userId);
}

/**
 * Access policy for artifact CONTENT, specifically GET
 * `/api/artifacts/:artifactId/content`: this is the single place that decides
 * whether a caller may read the decoded bytes behind an artifact's case.
 *
 * `checkCaseAccess` still gates the base question — "does this caller have
 * any relationship to this case at all" — first, and a caller it denies gets
 * exactly the same denial as before this policy existed (a stranger with no
 * project relationship stays a 404, not a new 403 that would disclose the
 * case exists and is a Clerk task).
 *
 * On top of that base grant, a private Clerk (`case_type: 'assistant_task'`)
 * case's answer is not an operator surface: `AssistantFollowUpService`'s
 * `assertRequester` (see `services/assistant/assistant-follow-up-service.ts`)
 * already denies admins the same content on the thread API by design — "a
 * private Clerk project is not an impersonation surface for an operator
 * account". So for an `assistant_task` case, a caller who is not the
 * requester is downgraded from the base grant to `requester_only`,
 * regardless of `deleted_at`: `checkCaseAccess`'s admin bypass grants base
 * access to a soft-deleted case unconditionally (it checks `isAdmin` before
 * `deleted_at`), and deleting is not a route to the same content an admin is
 * otherwise refused — soft-deleting the case must not reopen the bypass this
 * function exists to close. The requester keeps access exactly as before.
 * Every non-`assistant_task` case keeps exactly `checkCaseAccess`'s behavior
 * (admin bypass included) — this is not a blanket change to case access,
 * only to this one read path for this one case type.
 */
export async function checkArtifactCaseAccess(
  caseId: string,
  userId: string,
): Promise<ArtifactCaseAccessDecision> {
  const baseAllowed = await checkCaseAccess(caseId, userId);
  if (!baseAllowed) return 'not_found';

  const caseDoc = await collections.cases().doc(caseId).get();
  const case_ = caseDoc.exists ? caseDoc.data()! : undefined;
  if (case_?.case_type === 'assistant_task') {
    const isRequester = case_.owner_user_id === userId
      && case_.assistant_context?.requester_user_id === userId;
    if (!isRequester) return 'requester_only';
  }

  return 'allowed';
}

/**
 * Verifies a user has access to a project. Returns true if allowed.
 * Use this in project sub-routes (repositories, etc.) and in every route that
 * gates a CREATE against a caller-supplied `project_id` before this function
 * ever runs `isEffectiveMember` on the referenced project.
 *
 * Issue #749 item 1: this used to `return true` when the project doc was
 * missing ("let the route handle 404"), on the assumption every caller had
 * its own follow-up existence check. Three create routes didn't —
 * `rule-sets/route.ts` POST, `rules/route.ts` POST, and
 * `rules/overrides/route.ts` POST all resolve their project-scoped role gate
 * through this function (via `requireProjectScopedRole` /
 * `requireProjectAccess`, `lib/api-helpers.ts`) and then write a new
 * rule/rule-set/override doc pointing at whatever `project_id` the caller
 * supplied, with no other check that the project exists — an authenticated
 * user (or, for the `rules`/`rule-sets` branches, one merely holding the
 * global `tech_lead` role) could create a resource scoped to a project id
 * that has never existed. Flipping to deny-by-default here (mirroring
 * `checkCaseAccess`'s orphaned-project fix above) closes that for every current and
 * future caller in one place, rather than requiring each new create route to
 * remember its own existence check (`knowledge/route.ts`'s
 * `requireKnowledgeScopeAccess` already does its own explicit check ahead of
 * calling this function — that check is now redundant, not contradicted, by
 * this default).
 *
 * Every caller was audited for this flip (full list, see PR body): route
 * handlers gating a create/mutate against a *caller-supplied* `project_id`
 * (`cases/route.ts` POST, `projects/[projectId]/repositories/route.ts`,
 * `evidence-policies/route.ts` POST, `llm/test/route.ts` POST) only ever
 * expect `true` for a project that exists, so a nonexistent project now
 * correctly 404s instead of silently succeeding. Routes that load a stored
 * resource FIRST and re-check the *resource's own* `project_id`
 * (`rule-sets/[ruleSetId]/route.ts`, `rules/[ruleId]/route.ts`,
 * `evidence-policies/[policyId]/route.ts` PATCH/DELETE) only hit the missing
 * branch if that project was deleted after the resource was created — same
 * orphaned-reference shape `checkCaseAccess` already deny-by-defaults, so
 * this keeps the two functions' policies consistent instead of only fixing
 * half of that pattern.
 */
export async function checkProjectAccess(projectId: string, userId: string): Promise<boolean> {
  const isAdmin = await checkIsAdmin(userId);
  if (isAdmin) return true;

  const projectDoc = await collections.projects().doc(projectId).get();
  if (!projectDoc.exists) return false;

  return isEffectiveMember(projectDoc.data()!, userId);
}
