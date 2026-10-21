/**
 * #1030 / #1040: `POST /api/cases` blocks the internal-only
 * case types (`observed`, `assistant_task`) with a value guard
 * (packages/frontend/src/lib/case-type-guard.ts). The equivalent guard on
 * `PATCH /api/cases/:id` cannot be a value guard — the case-detail edit
 * modal resubmits the case's current, unchanged `case_type` on every save
 * (case-header-edit-modal.tsx), so a value guard would reject something as
 * ordinary as renaming an already-`observed` case's title. `CaseService.
 * updateCase` guards the TRANSITION instead: reject only when `case_type`
 * both changes and lands on an internal-only value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidationError, type Case } from '@arbitra/shared';

interface State {
  cases: Map<string, Case>;
}

const state: State = { cases: new Map() };

function reset(): void {
  state.cases = new Map();
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
    projects: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }),
    users: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }),
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

// EventService is injected as a no-op stub — this suite only exercises the
// internal-only case_type transition guard, not event emission.
const stubEventService = { emit: vi.fn().mockResolvedValue(undefined) };

function makeService(): CaseService {
  return new CaseService(new CaseRepository(), stubEventService as never);
}

describe('CaseService.updateCase — internal-only case_type transition guard (#1030)', () => {
  beforeEach(() => {
    reset();
    stubEventService.emit.mockClear();
  });

  it('allows resubmitting an unchanged case_type on an already-observed case (title-only edit)', async () => {
    state.cases.set('case_1', makeCase({ case_type: 'observed', title: 'Old title' }));
    const service = makeService();

    const updated = await service.updateCase(
      'case_1',
      { title: 'New title', case_type: 'observed' },
      'usr_caller',
    );

    expect(updated.title).toBe('New title');
    expect(updated.case_type).toBe('observed');
  });

  it('allows resubmitting an unchanged case_type on an already-assistant_task case', async () => {
    state.cases.set('case_1', makeCase({ case_type: 'assistant_task', title: 'Old title' }));
    const service = makeService();

    const updated = await service.updateCase(
      'case_1',
      { title: 'New title', case_type: 'assistant_task' },
      'usr_caller',
    );

    expect(updated.case_type).toBe('assistant_task');
  });

  it('rejects moving a publicly-created case to case_type observed', async () => {
    state.cases.set('case_1', makeCase({ case_type: 'bugfix' }));
    const service = makeService();

    await expect(
      service.updateCase('case_1', { case_type: 'observed' }, 'usr_caller'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects moving a publicly-created case to case_type assistant_task', async () => {
    state.cases.set('case_1', makeCase({ case_type: 'bugfix' }));
    const service = makeService();

    await expect(
      service.updateCase('case_1', { case_type: 'assistant_task' }, 'usr_caller'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects flipping an observed case directly to assistant_task', async () => {
    state.cases.set('case_1', makeCase({ case_type: 'observed' }));
    const service = makeService();

    await expect(
      service.updateCase('case_1', { case_type: 'assistant_task' }, 'usr_caller'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('still allows changing between two publicly-creatable case types', async () => {
    state.cases.set('case_1', makeCase({ case_type: 'bugfix' }));
    const service = makeService();

    const updated = await service.updateCase('case_1', { case_type: 'refactoring' }, 'usr_caller');
    expect(updated.case_type).toBe('refactoring');
  });

  it('still allows an update that omits case_type entirely', async () => {
    state.cases.set('case_1', makeCase({ case_type: 'observed', title: 'Old title' }));
    const service = makeService();

    const updated = await service.updateCase('case_1', { title: 'New title' }, 'usr_caller');
    expect(updated.title).toBe('New title');
    expect(updated.case_type).toBe('observed');
  });
});
