/**
 * `checkCaseAccess` used to fail OPEN when a
 * case's `project_id` pointed at a deleted/nonexistent project ("orphaned
 * case = allow"), granting ANY authenticated user — not just members — full
 * access to that case. These tests pin the flip to deny-by-default, and the
 * surrounding non-orphaned paths as a regression guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case, Project } from '@arbitra/shared';

const state: { cases: Map<string, Case>; projects: Map<string, Project>; users: Map<string, { roles?: string[] }> } = {
  cases: new Map(),
  projects: new Map(),
  users: new Map(),
};

function reset(): void {
  state.cases = new Map();
  state.projects = new Map();
  state.users = new Map();
}

vi.mock('./firestore.js', () => ({
  collections: {
    cases: () => ({
      doc: (id: string) => ({
        get: async () => {
          const c = state.cases.get(id);
          return { exists: c !== undefined, data: () => c };
        },
      }),
    }),
    projects: () => ({
      doc: (id: string) => ({
        get: async () => {
          const p = state.projects.get(id);
          return { exists: p !== undefined, data: () => p };
        },
      }),
    }),
    users: () => ({
      doc: (id: string) => ({
        get: async () => {
          const u = state.users.get(id);
          return { exists: u !== undefined, data: () => u };
        },
      }),
    }),
  },
}));

import { checkArtifactCaseAccess, checkCaseAccess, checkProjectAccess } from './project-access.js';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'T',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'usr_owner',
    status: 'open',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    deleted_by: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    project_id: 'proj_1',
    name: 'P',
    description: '',
    owner_user_id: 'usr_owner',
    reviewer_pool: [],
    tech_leads: [],
    members: [],
    default_evidence_policy_id: '',
    default_rule_set_refs: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('checkCaseAccess — orphaned-project fallback', () => {
  beforeEach(() => {
    reset();
  });

  it('denies a non-member when the case\'s project doc no longer exists (orphaned, was fail-open)', async () => {
    state.cases.set('case_1', makeCase({ project_id: 'proj_deleted' }));
    // No entry in state.projects for 'proj_deleted' — simulates the project
    // having been deleted via DELETE /api/projects/:id (which cascades to
    // repositories but not to cases).
    state.users.set('usr_random', { roles: [] });

    const allowed = await checkCaseAccess('case_1', 'usr_random');
    expect(allowed).toBe(false);
  });

  it('still allows an admin full access to an orphaned case', async () => {
    state.cases.set('case_1', makeCase({ project_id: 'proj_deleted' }));
    state.users.set('usr_admin', { roles: ['admin'] });

    const allowed = await checkCaseAccess('case_1', 'usr_admin');
    expect(allowed).toBe(true);
  });

  it('allows an effective member when the project still exists', async () => {
    state.cases.set('case_1', makeCase({ project_id: 'proj_1' }));
    state.projects.set('proj_1', makeProject({ members: ['usr_member'] }));
    state.users.set('usr_member', { roles: [] });

    const allowed = await checkCaseAccess('case_1', 'usr_member');
    expect(allowed).toBe(true);
  });

  it('denies a non-member when the project still exists', async () => {
    state.cases.set('case_1', makeCase({ project_id: 'proj_1' }));
    state.projects.set('proj_1', makeProject({ members: ['usr_member'] }));
    state.users.set('usr_stranger', { roles: [] });

    const allowed = await checkCaseAccess('case_1', 'usr_stranger');
    expect(allowed).toBe(false);
  });

  it('allows unrestricted access when the case has no project_id at all', async () => {
    state.cases.set('case_1', makeCase({ project_id: undefined as unknown as string }));
    state.users.set('usr_any', { roles: [] });

    const allowed = await checkCaseAccess('case_1', 'usr_any');
    expect(allowed).toBe(true);
  });
});

/**
 * Issue #749 item 2: `checkCaseAccess` used to `return true` when the case
 * doc itself did not exist ("let the route handle 404"), on the assumption
 * every caller re-checked existence before acting. `POST
 * /api/cases/:caseId/artifacts` and `POST /api/cases/:caseId/comments` gate
 * solely on this function (via `requireCaseAccess`) and write unconditionally
 * once it passes, so this let any authenticated user create an artifact or
 * comment under a fabricated case id. Mirrors the orphaned-project
 * deny-by-default fix above.
 */
describe('checkCaseAccess — nonexistent-case fallback (#749)', () => {
  beforeEach(() => {
    reset();
  });

  it('denies a non-admin when the case doc does not exist (was fail-open)', async () => {
    // No entry in state.cases for 'case_missing' — simulates a
    // caller-supplied case id that was typo'd, deleted, or never created.
    state.users.set('usr_random', { roles: [] });

    const allowed = await checkCaseAccess('case_missing', 'usr_random');
    expect(allowed).toBe(false);
  });

  it('still allows an admin when the case doc does not exist', async () => {
    state.users.set('usr_admin', { roles: ['admin'] });

    const allowed = await checkCaseAccess('case_missing', 'usr_admin');
    expect(allowed).toBe(true);
  });

  it('checkArtifactCaseAccess (GET /api/artifacts/:artifactId/content gate) inherits the deny', async () => {
    // checkArtifactCaseAccess defers its base grant entirely to
    // checkCaseAccess; this pins that a fabricated case id reaches
    // 'not_found' through that shared gate rather than falling through to
    // 'allowed' the way it would have before the fix above.
    state.users.set('usr_random', { roles: [] });

    const decision = await checkArtifactCaseAccess('case_missing', 'usr_random');
    expect(decision).toBe('not_found');
  });
});

/**
 * Issue #749 item 1: `checkProjectAccess` used to `return true` when the
 * referenced project doc was missing ("let the route handle 404"), on the
 * assumption every caller had its own follow-up existence check. Three
 * create routes didn't (`rule-sets`/`rules`/`rules/overrides` POST — see
 * `project-access.ts`'s doc comment for the full caller audit), letting an
 * authenticated caller create a resource scoped to a project id that never
 * existed. These tests pin the flip to deny-by-default, mirroring
 * `checkCaseAccess`'s orphaned-project tests above.
 */
describe('checkProjectAccess — nonexistent-project fallback (#749)', () => {
  beforeEach(() => {
    reset();
  });

  it('denies a non-admin when the project doc does not exist (was fail-open)', async () => {
    // No entry in state.projects for 'proj_missing' at all — simulates a
    // caller-supplied project_id that was typo'd, deleted, or never created.
    state.users.set('usr_random', { roles: [] });

    const allowed = await checkProjectAccess('proj_missing', 'usr_random');
    expect(allowed).toBe(false);
  });

  it('still allows an admin when the project doc does not exist', async () => {
    state.users.set('usr_admin', { roles: ['admin'] });

    const allowed = await checkProjectAccess('proj_missing', 'usr_admin');
    expect(allowed).toBe(true);
  });

  it('allows an effective member when the project exists', async () => {
    state.projects.set('proj_1', makeProject({ members: ['usr_member'] }));
    state.users.set('usr_member', { roles: [] });

    const allowed = await checkProjectAccess('proj_1', 'usr_member');
    expect(allowed).toBe(true);
  });

  it('denies a non-member when the project exists', async () => {
    state.projects.set('proj_1', makeProject({ members: ['usr_member'] }));
    state.users.set('usr_stranger', { roles: [] });

    const allowed = await checkProjectAccess('proj_1', 'usr_stranger');
    expect(allowed).toBe(false);
  });
});

/**
 * Issue #811 item 1: `checkArtifactCaseAccess` is the policy gate for GET
 * `/api/artifacts/:artifactId/content`. `checkCaseAccess` decides base access
 * first — a caller it denies gets the same denial as before this policy
 * existed, no new disclosure. On top of a base grant, an `assistant_task`
 * case enforces `AssistantFollowUpService.assertRequester`'s requester-only
 * rule with no admin bypass, including when the case has been soft-deleted
 * (admin bypass grants base access to a soft-deleted case unconditionally, so
 * the requester-only check must not skip a deleted case or that bypass
 * reopens). Every other case type keeps `checkCaseAccess`'s ordinary
 * project-membership behavior (admin bypass included).
 */
describe('checkArtifactCaseAccess — assistant-task requester-only policy (#811)', () => {
  beforeEach(() => {
    reset();
  });

  function assistantContext(requesterId: string) {
    return {
      channel: 'web',
      conversation_visibility: 'direct',
      requester_user_id: requesterId,
      risk_level: 'low',
      policy_version: 'assistant_policy:v1',
      prompt_version: 'assistant_task:v1',
    } as const;
  }

  it('denies an admin who is not the requester on an assistant_task case', async () => {
    // Reverting the `case_.case_type === 'assistant_task'` branch (falling
    // through to just `checkCaseAccess`'s result) makes this assertion fail:
    // `checkCaseAccess`'s admin bypass would leave the decision 'allowed'.
    state.cases.set('case_1', makeCase({
      case_type: 'assistant_task',
      owner_user_id: 'usr_requester',
      assistant_context: assistantContext('usr_requester'),
    }));
    state.users.set('usr_admin', { roles: ['admin'] });

    const decision = await checkArtifactCaseAccess('case_1', 'usr_admin');
    expect(decision).toBe('requester_only');
  });

  it('denies an admin who is not the requester even on a SOFT-DELETED assistant_task case', async () => {
    // Reverting the requester-only check to run only `if (!case_.deleted_at && ...)` (i.e.
    // skipping it once the case is soft-deleted) makes this assertion fail —
    // `checkCaseAccess`'s admin bypass grants base access to a soft-deleted
    // case unconditionally (it checks `isAdmin` before `deleted_at`), so the
    // decision would fall through to 'allowed'. An admin must not be able to
    // soft-delete an assistant_task case and read its private answer through
    // this route.
    state.cases.set('case_1', makeCase({
      case_type: 'assistant_task',
      owner_user_id: 'usr_requester',
      assistant_context: assistantContext('usr_requester'),
      deleted_at: '2026-08-05T12:00:00.000Z',
      deleted_by: 'usr_admin',
    }));
    state.users.set('usr_admin', { roles: ['admin'] });

    const decision = await checkArtifactCaseAccess('case_1', 'usr_admin');
    expect(decision).toBe('requester_only');
  });

  it('allows the exact requester on an assistant_task case', async () => {
    // Reverting the `isRequester` check to only compare `owner_user_id` (or
    // dropping the `assistant_context.requester_user_id` half) would still
    // pass here, but would wrongly flip the admin-denial test above to
    // 'allowed' if the check were dropped entirely — the two tests pin both
    // halves of the same branch. The requester is also made an effective
    // project member so the base `checkCaseAccess` grant (evaluated first) is
    // satisfied independently of the assistant-only rule this test targets.
    state.cases.set('case_1', makeCase({
      case_type: 'assistant_task',
      project_id: 'proj_1',
      owner_user_id: 'usr_requester',
      assistant_context: assistantContext('usr_requester'),
    }));
    state.projects.set('proj_1', makeProject({ members: ['usr_requester'] }));
    state.users.set('usr_requester', { roles: [] });

    const decision = await checkArtifactCaseAccess('case_1', 'usr_requester');
    expect(decision).toBe('allowed');
  });

  it('keeps the admin bypass unchanged for a non-assistant-task case', async () => {
    // Reverting `checkArtifactCaseAccess` to apply the requester-only rule to
    // every case (dropping the `case_type === 'assistant_task'` guard) makes
    // this assertion fail: the admin would get 'requester_only' instead.
    state.cases.set('case_1', makeCase({ case_type: 'bugfix', owner_user_id: 'usr_owner' }));
    state.users.set('usr_admin', { roles: ['admin'] });

    const decision = await checkArtifactCaseAccess('case_1', 'usr_admin');
    expect(decision).toBe('allowed');
  });

  it('keeps ordinary project-membership denial for a non-assistant-task case', async () => {
    state.cases.set('case_1', makeCase({ case_type: 'bugfix', project_id: 'proj_1' }));
    state.projects.set('proj_1', makeProject({ members: ['usr_member'] }));
    state.users.set('usr_stranger', { roles: [] });

    const decision = await checkArtifactCaseAccess('case_1', 'usr_stranger');
    expect(decision).toBe('not_found');
  });

  it('denies a stranger with no project relationship the same way on an assistant_task case (no new disclosure)', async () => {
    // Before this policy existed, a caller `checkCaseAccess` denies got a plain 404. Reverting
    // to the pre-fix-up structure (checking `case_type === 'assistant_task'`
    // before consulting `checkCaseAccess` at all) makes this assertion fail:
    // a stranger would get 'requester_only' (a 403) instead of 'not_found',
    // newly disclosing that the case exists and is a Clerk task to someone
    // with no relationship to it at all.
    state.cases.set('case_1', makeCase({
      case_type: 'assistant_task',
      project_id: 'proj_1',
      owner_user_id: 'usr_requester',
      assistant_context: assistantContext('usr_requester'),
    }));
    state.projects.set('proj_1', makeProject({ members: ['usr_requester'] }));
    state.users.set('usr_stranger', { roles: [] });

    const decision = await checkArtifactCaseAccess('case_1', 'usr_stranger');
    expect(decision).toBe('not_found');
  });
});
