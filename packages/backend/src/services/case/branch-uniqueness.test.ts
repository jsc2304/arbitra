import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case } from '@arbitra/shared';

// ── Firestore stub: `collections.cases().where(...).where(...).get()` ──
//
// The guard calls two chained .where() invocations then .get(). We return
// whatever `mockCases` currently holds, filtered to simulate the two equality
// constraints (repository_id, current_branch) Firestore would have applied.

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

import { assertBranchUniqueForCase, BranchConflictError } from './branch-uniqueness.js';

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

describe('assertBranchUniqueForCase', () => {
  beforeEach(() => {
    setCases([]);
  });

  it('rejects when another non-terminal case already owns the branch in the same repo', async () => {
    const other = makeCase({
      case_id: 'case_A',
      status: 'in_build',
      current_branch: 'feat/foo',
      repository_id: 'repo_X',
    });
    setCases([other]);

    await expect(
      assertBranchUniqueForCase({
        caseId: 'case_B',
        repositoryId: 'repo_X',
        branch: 'feat/foo',
      }),
    ).rejects.toMatchObject({
      name: 'BranchConflictError',
      code: 'BRANCH_CONFLICT',
      statusCode: 409,
      branch: 'feat/foo',
      conflictingCaseId: 'case_A',
      conflictingCaseStatus: 'in_build',
      currentCaseId: 'case_B',
    });
  });

  it('includes agent guidance in the thrown error details', async () => {
    setCases([
      makeCase({ case_id: 'case_A', status: 'in_build', current_branch: 'feat/foo' }),
    ]);

    let caught: unknown;
    try {
      await assertBranchUniqueForCase({
        caseId: 'case_B',
        repositoryId: 'repo_X',
        branch: 'feat/foo',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BranchConflictError);
    expect((caught as BranchConflictError).details).toMatchObject({
      code: 'BRANCH_CONFLICT',
      branch: 'feat/foo',
      repository_id: 'repo_X',
      conflicting_case_id: 'case_A',
      conflicting_case_status: 'in_build',
      current_case_id: 'case_B',
    });
    expect((caught as BranchConflictError).details?.guidance).toEqual(
      expect.stringContaining('One case, one branch'),
    );
  });

  it('allows reuse when the conflicting case is done (terminal)', async () => {
    setCases([
      makeCase({
        case_id: 'case_A',
        status: 'done',
        current_branch: 'feat/foo',
        repository_id: 'repo_X',
      }),
    ]);

    await expect(
      assertBranchUniqueForCase({
        caseId: 'case_B',
        repositoryId: 'repo_X',
        branch: 'feat/foo',
      }),
    ).resolves.toBeUndefined();
  });

  it('allows reuse when the conflicting case is rejected (terminal)', async () => {
    setCases([
      makeCase({
        case_id: 'case_A',
        status: 'rejected',
        current_branch: 'feat/foo',
        repository_id: 'repo_X',
      }),
    ]);

    await expect(
      assertBranchUniqueForCase({
        caseId: 'case_B',
        repositoryId: 'repo_X',
        branch: 'feat/foo',
      }),
    ).resolves.toBeUndefined();
  });

  it('allows the same branch across different repositories', async () => {
    setCases([
      makeCase({
        case_id: 'case_A',
        status: 'in_build',
        current_branch: 'feat/foo',
        repository_id: 'repo_X',
      }),
    ]);

    await expect(
      assertBranchUniqueForCase({
        caseId: 'case_B',
        repositoryId: 'repo_Y', // different repo
        branch: 'feat/foo',
      }),
    ).resolves.toBeUndefined();
  });

  it('allows the same case to progress through statuses on its own branch', async () => {
    // Firestore returns the case itself when querying; the guard must skip
    // self-matches so progressing case_A through in_build → in_validation
    // etc. never trips over itself.
    setCases([
      makeCase({
        case_id: 'case_A',
        status: 'in_build',
        current_branch: 'feat/foo',
        repository_id: 'repo_X',
      }),
    ]);

    await expect(
      assertBranchUniqueForCase({
        caseId: 'case_A',
        repositoryId: 'repo_X',
        branch: 'feat/foo',
      }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when branch is missing', async () => {
    setCases([
      makeCase({
        case_id: 'case_A',
        status: 'in_build',
        current_branch: 'feat/foo',
      }),
    ]);

    await expect(
      assertBranchUniqueForCase({
        caseId: 'case_B',
        repositoryId: 'repo_X',
        branch: undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when repositoryId is missing', async () => {
    await expect(
      assertBranchUniqueForCase({
        caseId: 'case_B',
        repositoryId: null,
        branch: 'feat/foo',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects when one of multiple cases on the branch is non-terminal', async () => {
    setCases([
      makeCase({
        case_id: 'case_old',
        status: 'done',
        current_branch: 'feat/foo',
        repository_id: 'repo_X',
      }),
      makeCase({
        case_id: 'case_active',
        status: 'in_review',
        current_branch: 'feat/foo',
        repository_id: 'repo_X',
      }),
    ]);

    await expect(
      assertBranchUniqueForCase({
        caseId: 'case_new',
        repositoryId: 'repo_X',
        branch: 'feat/foo',
      }),
    ).rejects.toMatchObject({
      code: 'BRANCH_CONFLICT',
      conflictingCaseId: 'case_active',
    });
  });
});
