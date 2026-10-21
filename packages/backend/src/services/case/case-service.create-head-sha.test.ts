/**
 * Issue #1079: `CaseService.createCase` never persisted the commit SHA the
 * caller passed in `git_context.commit_sha` as `current_head_sha`. When a
 * case was created for a branch that already had an open PR, the
 * autonomous pipeline could run its approval before any webhook had a
 * chance to observe a head SHA, so `approval-pin.ts` had nothing to pin —
 * the approval was written unpinned and the next push failed the
 * `arbitra/case` required check closed (see #1079 and PR #1077).
 *
 * Scope: only the `create_case` persistence fix. Pipeline refusal
 * behaviour and GitHub-backfill are separate concerns, not covered
 * here (see #1079's "Expected" section).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case, CreateCaseInput } from '@arbitra/shared';

const state: { cases: Map<string, Case> } = { cases: new Map() };

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    cases: () => ({
      doc: (id: string) => ({
        get: async () => {
          const c = state.cases.get(id);
          return { exists: c !== undefined, data: () => c };
        },
        set: async (data: Case) => {
          state.cases.set(id, data);
        },
        update: async (patch: Partial<Case>) => {
          const existing = state.cases.get(id);
          if (!existing) throw new Error(`no doc ${id}`);
          state.cases.set(id, { ...existing, ...patch });
        },
      }),
    }),
    projects: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }),
    repositories: () => ({
      where: () => ({
        limit: () => ({ get: async () => ({ docs: [] }) }),
      }),
    }),
    users: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }),
  },
  getDb: () => ({}),
}));

const { CaseService } = await import('./case-service.js');
const { CaseRepository } = await import('./case-repository.js');

function baseInput(overrides: Partial<CreateCaseInput> = {}): CreateCaseInput {
  return {
    title: 'Fix deploy path risk pattern',
    description: '',
    source_type: 'manual',
    project_id: 'proj_demo',
    repository_id: 'repo_demo',
    risk_level: 'medium',
    priority: 'normal',
    ...overrides,
  };
}

const stubEventService = { emit: vi.fn().mockResolvedValue(undefined) };

function makeService() {
  return new CaseService(new CaseRepository(), stubEventService as never);
}

beforeEach(() => {
  state.cases = new Map();
  stubEventService.emit.mockClear();
});

describe('CaseService.createCase — current_head_sha (#1079)', () => {
  it('persists git_context.commit_sha as current_head_sha', async () => {
    const service = makeService();
    const created = await service.createCase(
      baseInput({
        git_context: {
          branch: 'fix/deploy-path-risk-pattern',
          remote_url: 'https://github.com/acme/primary.git',
          commit_sha: '41ecf2aa',
        },
      }),
      'usr_owner',
    );

    expect(created.current_head_sha).toBe('41ecf2aa');
    // Persisted, not just returned in-memory.
    const stored = state.cases.get(created.case_id);
    expect(stored?.current_head_sha).toBe('41ecf2aa');
  });

  it('leaves current_head_sha absent when no commit_sha is provided', async () => {
    const service = makeService();
    const created = await service.createCase(baseInput(), 'usr_owner');

    expect(created.current_head_sha).toBeUndefined();
    const stored = state.cases.get(created.case_id);
    expect(stored?.current_head_sha).toBeUndefined();
  });
});
