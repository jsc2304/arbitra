import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Case } from '@arbitra/shared';

// ── Firestore stub: `collections.cases().where(...).where(...).get()` ──
//
// Mirrors the stub in branch-uniqueness.test.ts: the resolver runs two
// chained equality `.where()` calls (repository_id, current_branch) then
// `.get()`. We simulate Firestore's equality filtering client-side.

interface WhereFilter {
  field: string;
  value: unknown;
}

const state: { cases: Case[] } = { cases: [] };

function setCases(cases: Case[]) {
  state.cases = cases;
}

function buildQueryChain(filters: WhereFilter[]): {
  where: (field: string, op: string, value: unknown) => ReturnType<typeof buildQueryChain>;
  get: () => Promise<{ docs: { data: () => Case }[] }>;
} {
  return {
    where: (field: string, _op: string, value: unknown) =>
      buildQueryChain([...filters, { field, value }]),
    get: async () => {
      const matching = state.cases.filter((c) =>
        filters.every((f) => (c as unknown as Record<string, unknown>)[f.field] === f.value),
      );
      return { docs: matching.map((c) => ({ data: () => c })) };
    },
  };
}

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    cases: () => buildQueryChain([]),
  },
}));

import { resolveCaseByBranch } from './branch-resolution.js';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_default',
    title: 'Test',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'p1',
    repository_id: 'repo_X',
    owner_user_id: 'usr_owner',
    status: 'in_build',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    current_branch: 'feat/foo',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Case;
}

describe('resolveCaseByBranch', () => {
  beforeEach(() => {
    setCases([]);
  });

  it('returns the bound case for a branch with exactly one non-terminal case', async () => {
    // Reverting the `current_branch` equality filter (branch-resolution.ts
    // `.where('current_branch', '==', branch)`) would make this see an
    // empty match set and return case: null instead.
    setCases([
      makeCase({ case_id: 'case_A', repository_id: 'repo_X', current_branch: 'feat/foo' }),
      makeCase({ case_id: 'case_other', repository_id: 'repo_X', current_branch: 'feat/bar' }),
    ]);

    const result = await resolveCaseByBranch({ repositoryId: 'repo_X', branch: 'feat/foo' });

    expect(result.case?.case_id).toBe('case_A');
    expect(result.ambiguous).toBe(false);
  });

  it('returns no case (not an error) for an unknown branch', async () => {
    // Reverting the `candidates.length === 0` early return in
    // branch-resolution.ts would make this throw or return a stale value
    // instead of a clean `{ case: null }`.
    setCases([makeCase({ case_id: 'case_A', repository_id: 'repo_X', current_branch: 'feat/foo' })]);

    const result = await resolveCaseByBranch({ repositoryId: 'repo_X', branch: 'feat/unknown' });

    expect(result).toEqual({ case: null, ambiguous: false });
  });

  it('resolves two different branches of the same repository concurrently to different cases', async () => {
    // Exercises the "no shared mutable state" requirement directly: two
    // concurrent calls must not clobber each other's result. Reverting the
    // per-call `candidates`/`pool` locals in branch-resolution.ts to a
    // shared/module-level variable would make one call's result leak into
    // the other under concurrency.
    setCases([
      makeCase({ case_id: 'case_A', repository_id: 'repo_X', current_branch: 'feat/foo' }),
      makeCase({ case_id: 'case_B', repository_id: 'repo_X', current_branch: 'feat/bar' }),
    ]);

    const [resultA, resultB] = await Promise.all([
      resolveCaseByBranch({ repositoryId: 'repo_X', branch: 'feat/foo' }),
      resolveCaseByBranch({ repositoryId: 'repo_X', branch: 'feat/bar' }),
    ]);

    expect(resultA.case?.case_id).toBe('case_A');
    expect(resultB.case?.case_id).toBe('case_B');
  });

  it('ignores soft-deleted cases when resolving', async () => {
    // Reverting the `!c.deleted_at` filter in branch-resolution.ts would
    // make this resolve to the soft-deleted case instead of reporting none.
    setCases([
      makeCase({
        case_id: 'case_deleted',
        repository_id: 'repo_X',
        current_branch: 'feat/foo',
        deleted_at: '2026-01-02T00:00:00Z',
      }),
    ]);

    const result = await resolveCaseByBranch({ repositoryId: 'repo_X', branch: 'feat/foo' });

    expect(result).toEqual({ case: null, ambiguous: false });
  });

  it('picks the most recently updated case and flags ambiguity when two non-terminal cases share a branch', async () => {
    // Reverting the `nonTerminal.length > 1` ambiguity check, or the
    // updated_at sort in branch-resolution.ts, would make this either miss
    // the ambiguous flag or return the wrong (older) case.
    setCases([
      makeCase({
        case_id: 'case_old',
        repository_id: 'repo_X',
        current_branch: 'feat/foo',
        status: 'in_build',
        updated_at: '2026-01-01T00:00:00Z',
      }),
      makeCase({
        case_id: 'case_new',
        repository_id: 'repo_X',
        current_branch: 'feat/foo',
        status: 'in_review',
        updated_at: '2026-01-05T00:00:00Z',
      }),
    ]);

    const result = await resolveCaseByBranch({ repositoryId: 'repo_X', branch: 'feat/foo' });

    expect(result.case?.case_id).toBe('case_new');
    expect(result.ambiguous).toBe(true);
  });

  it('prefers a non-terminal case over a terminal one sharing the same branch, without flagging ambiguity', async () => {
    // Reverting the `nonTerminal.length > 0 ? nonTerminal : candidates` pool
    // selection in branch-resolution.ts would make this pick whichever case
    // is most recently updated regardless of status, and could wrongly
    // resolve to the done case even though an active case also owns the
    // branch.
    setCases([
      makeCase({
        case_id: 'case_done',
        repository_id: 'repo_X',
        current_branch: 'feat/foo',
        status: 'done',
        updated_at: '2026-01-10T00:00:00Z',
      }),
      makeCase({
        case_id: 'case_active',
        repository_id: 'repo_X',
        current_branch: 'feat/foo',
        status: 'in_build',
        updated_at: '2026-01-02T00:00:00Z',
      }),
    ]);

    const result = await resolveCaseByBranch({ repositoryId: 'repo_X', branch: 'feat/foo' });

    expect(result.case?.case_id).toBe('case_active');
    expect(result.ambiguous).toBe(false);
  });

  it('falls back to the most recently updated terminal case when no non-terminal case owns the branch', async () => {
    // Reverting the fallback-to-`candidates` branch (when nonTerminal is
    // empty) in branch-resolution.ts would make this return null instead
    // of the merged/done case still bound to the branch.
    setCases([
      makeCase({
        case_id: 'case_done_old',
        repository_id: 'repo_X',
        current_branch: 'feat/foo',
        status: 'rejected',
        updated_at: '2026-01-01T00:00:00Z',
      }),
      makeCase({
        case_id: 'case_done_new',
        repository_id: 'repo_X',
        current_branch: 'feat/foo',
        status: 'done',
        updated_at: '2026-01-05T00:00:00Z',
      }),
    ]);

    const result = await resolveCaseByBranch({ repositoryId: 'repo_X', branch: 'feat/foo' });

    expect(result.case?.case_id).toBe('case_done_new');
    expect(result.ambiguous).toBe(false);
  });

  it('returns no case when repositoryId is missing', async () => {
    // Reverting the `!repositoryId || !branch` guard in branch-resolution.ts
    // would make this attempt a Firestore query with an undefined filter
    // value instead of a clean early return.
    const result = await resolveCaseByBranch({ repositoryId: '', branch: 'feat/foo' });
    expect(result).toEqual({ case: null, ambiguous: false });
  });
});
