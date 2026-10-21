/**
 * Issue #794 (timeline P1): `CaseService.updateCase` previously emitted an
 * audit event only for `risk_level` changes — editing title, description,
 * case_type, priority, or validation_track left no trail at all, so the
 * Timeline kept showing "Case Created" no matter how many edits followed.
 * These tests pin the new `case_updated` event: one per `updateCase` call,
 * diffed against the persisted doc (never the raw input) so re-submitting
 * an unchanged value emits nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case } from '@arbitra/shared';

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
    projects: () => ({
      doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
    }),
    users: () => ({
      doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
    }),
  },
  getDb: () => ({}),
}));

import { CaseService } from './case-service.js';
import { CaseRepository } from './case-repository.js';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Original title',
    description: 'Original description',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_a',
    repository_id: 'repo_1',
    owner_user_id: 'usr_owner',
    status: 'open',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    case_type: 'bugfix',
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

// EventService injected as a spy — these tests only pin what gets emitted,
// not notification fan-out (covered separately in event-notifier.test.ts).
const stubEventService = { emit: vi.fn().mockResolvedValue(undefined) };

function makeService(): CaseService {
  return new CaseService(new CaseRepository(), stubEventService as never);
}

/** Pulls just the `case_updated` emit calls, in call order. */
function caseUpdatedCalls() {
  return stubEventService.emit.mock.calls.filter(([, type]) => type === 'case_updated');
}

describe('CaseService.updateCase — case_updated event (issue #794)', () => {
  beforeEach(() => {
    reset();
    stubEventService.emit.mockClear();
  });

  it('emits case_updated with old->new values on a title change', async () => {
    state.cases.set('case_1', makeCase({ title: 'Old title' }));
    const service = makeService();

    await service.updateCase('case_1', { title: 'New title' }, 'usr_1');

    const calls = caseUpdatedCalls();
    expect(calls).toHaveLength(1);
    const [caseId, type, payload, actorId] = calls[0]!;
    expect(caseId).toBe('case_1');
    expect(type).toBe('case_updated');
    expect(actorId).toBe('usr_1');
    expect(payload).toEqual({
      changed: ['title'],
      title: { from: 'Old title', to: 'New title' },
    });
  });

  it('emits changed-field names with old->new for case_type, priority, and validation_track together', async () => {
    state.cases.set(
      'case_1',
      makeCase({ case_type: 'bugfix', priority: 'normal', validation_track: 'direct' }),
    );
    const service = makeService();

    await service.updateCase(
      'case_1',
      { case_type: 'refactoring', priority: 'urgent', validation_track: 'manual' },
      'usr_1',
    );

    const calls = caseUpdatedCalls();
    expect(calls).toHaveLength(1);
    const [, , payload] = calls[0]!;
    expect(payload).toEqual({
      changed: ['case_type', 'priority', 'validation_track'],
      case_type: { from: 'bugfix', to: 'refactoring' },
      priority: { from: 'normal', to: 'urgent' },
      validation_track: { from: 'direct', to: 'manual' },
    });
  });

  it('marks description as changed WITHOUT carrying the old or new body in the payload', async () => {
    state.cases.set('case_1', makeCase({ description: 'Old body with potentially sensitive detail' }));
    const service = makeService();

    await service.updateCase('case_1', { description: 'New body' }, 'usr_1');

    const calls = caseUpdatedCalls();
    expect(calls).toHaveLength(1);
    const [, , payload] = calls[0]!;
    expect(payload['changed']).toEqual(['description']);
    // No `description` key at all — free-text bodies never ride on the
    // audit event, only the fact that it changed.
    expect(Object.prototype.hasOwnProperty.call(payload, 'description')).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('Old body');
    expect(JSON.stringify(payload)).not.toContain('New body');
  });

  it('combines a short-field change and the description marker in one event', async () => {
    state.cases.set('case_1', makeCase({ title: 'Old title', description: 'Old body' }));
    const service = makeService();

    await service.updateCase('case_1', { title: 'New title', description: 'New body' }, 'usr_1');

    const calls = caseUpdatedCalls();
    expect(calls).toHaveLength(1);
    const [, , payload] = calls[0]!;
    expect(payload['changed']).toEqual(['title', 'description']);
    expect(payload['title']).toEqual({ from: 'Old title', to: 'New title' });
    expect(Object.prototype.hasOwnProperty.call(payload, 'description')).toBe(false);
  });

  it('does NOT emit case_updated when the submitted value equals the existing one (no-op PATCH)', async () => {
    state.cases.set('case_1', makeCase({ title: 'Same title' }));
    const service = makeService();

    await service.updateCase('case_1', { title: 'Same title' }, 'usr_1');

    expect(caseUpdatedCalls()).toHaveLength(0);
  });

  it('does NOT emit case_updated for fields outside the tracked set (e.g. current_pr_ref)', async () => {
    state.cases.set('case_1', makeCase());
    const service = makeService();

    await service.updateCase('case_1', { current_pr_ref: 'https://example.com/pr/1' }, 'usr_1');

    expect(caseUpdatedCalls()).toHaveLength(0);
  });

  it('does NOT emit case_updated when updateCase is called with no changes at all', async () => {
    state.cases.set('case_1', makeCase());
    const service = makeService();

    await service.updateCase('case_1', {}, 'usr_1');

    expect(caseUpdatedCalls()).toHaveLength(0);
    expect(stubEventService.emit).not.toHaveBeenCalled();
  });

  it('emits case_updated and risk_level_changed as two separate events when both change together', async () => {
    state.cases.set('case_1', makeCase({ title: 'Old title', risk_level: 'medium' }));
    const service = makeService();

    await service.updateCase('case_1', { title: 'New title', risk_level: 'high' }, 'usr_1');

    const riskCalls = stubEventService.emit.mock.calls.filter(([, type]) => type === 'risk_level_changed');
    expect(riskCalls).toHaveLength(1);
    expect(riskCalls[0]![2]).toEqual({ from: 'medium', to: 'high' });

    const updatedCalls = caseUpdatedCalls();
    expect(updatedCalls).toHaveLength(1);
    expect(updatedCalls[0]![2]).toEqual({
      changed: ['title'],
      title: { from: 'Old title', to: 'New title' },
    });
  });
});
