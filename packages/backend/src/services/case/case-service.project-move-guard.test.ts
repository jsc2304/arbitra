/**
 * `PATCH /api/cases/:caseId` allows `project_id`
 * changes in early phases (`EARLY_PHASE_ONLY_FIELDS`), but `updateCase` never
 * checked the destination project existed or that the caller belonged to
 * it — a case owner could move their case into a project they have no
 * standing in, or into a nonexistent project_id and orphan it outright.
 * These tests pin the new guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError, NotFoundError, type Case, type Project } from '@arbitra/shared';

interface State {
  cases: Map<string, Case>;
  projects: Map<string, Project>;
  users: Map<string, { roles?: string[] }>;
}

const state: State = { cases: new Map(), projects: new Map(), users: new Map() };

function reset(): void {
  state.cases = new Map();
  state.projects = new Map();
  state.users = new Map();
}

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    cases: () => ({
      doc: (id: string) => ({
        get: async () => {
          const c = state.cases.get(id);
          return { exists: c !== undefined, data: () => c };
        },
        update: async (patch: Partial<Case>) => {
          const existing = state.cases.get(id);
          if (!existing) throw new Error(`no doc ${id}`);
          state.cases.set(id, { ...existing, ...patch });
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
  getDb: () => ({}),
}));

import { CaseService } from './case-service.js';
import { CaseRepository } from './case-repository.js';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'T',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_a',
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
    project_id: 'proj_b',
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

// EventService is injected as a no-op stub — this suite only exercises the
// project-move guard, not event emission/notification fan-out.
const stubEventService = { emit: vi.fn().mockResolvedValue(undefined) };

function makeService(): CaseService {
  return new CaseService(new CaseRepository(), stubEventService as never);
}

describe('CaseService.updateCase — project_id move guard', () => {
  beforeEach(() => {
    reset();
    stubEventService.emit.mockClear();
  });

  it('rejects an admin moving into a nonexistent destination project (404-shaped NotFoundError)', async () => {
    state.cases.set('case_1', makeCase({ project_id: 'proj_a' }));
    state.users.set('usr_admin', { roles: ['admin'] });
    const service = makeService();

    await expect(
      service.updateCase('case_1', { project_id: 'proj_missing' }, 'usr_admin'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects moving into a project the caller is not a member of', async () => {
    state.cases.set('case_1', makeCase({ project_id: 'proj_a' }));
    state.projects.set('proj_b', makeProject({ members: ['usr_someone_else'] }));
    state.users.set('usr_caller', { roles: [] });
    const service = makeService();

    await expect(
      service.updateCase('case_1', { project_id: 'proj_b' }, 'usr_caller'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('allows moving into a project the caller is an effective member of', async () => {
    state.cases.set('case_1', makeCase({ project_id: 'proj_a' }));
    state.projects.set('proj_b', makeProject({ members: ['usr_caller'] }));
    state.users.set('usr_caller', { roles: [] });
    const service = makeService();

    const updated = await service.updateCase('case_1', { project_id: 'proj_b' }, 'usr_caller');
    expect(updated.project_id).toBe('proj_b');
  });

  it('allows an admin to move a case into any existing project regardless of membership', async () => {
    state.cases.set('case_1', makeCase({ project_id: 'proj_a' }));
    state.projects.set('proj_b', makeProject({ members: [] }));
    state.users.set('usr_admin', { roles: ['admin'] });
    const service = makeService();

    const updated = await service.updateCase('case_1', { project_id: 'proj_b' }, 'usr_admin');
    expect(updated.project_id).toBe('proj_b');
  });

  it('does not check project access at all when project_id is unchanged', async () => {
    state.cases.set('case_1', makeCase({ project_id: 'proj_a', title: 'Old title' }));
    // No 'proj_a' entry in state.projects — if the guard ran, this would 404
    // even though the caller isn't actually changing the project.
    const service = makeService();

    const updated = await service.updateCase('case_1', { title: 'New title' }, 'usr_caller');
    expect(updated.title).toBe('New title');
    expect(updated.project_id).toBe('proj_a');
  });

  it('still enforces the early-phase gate on project_id ahead of the membership check', async () => {
    state.cases.set('case_1', makeCase({ project_id: 'proj_a', status: 'in_review' }));
    state.projects.set('proj_b', makeProject({ members: ['usr_caller'] }));
    const service = makeService();

    await expect(
      service.updateCase('case_1', { project_id: 'proj_b' }, 'usr_caller'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
