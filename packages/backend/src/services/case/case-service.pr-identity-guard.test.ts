/**
 * Issue #1045, secondary hardening: `CaseService.updateCase` must not let a
 * DECIDED case be re-pointed at a different PR or branch. "Case C approves
 * PR #42" is the claim `arbitra/case` publishes; moving `current_pr_ref`
 * afterwards would move that published claim onto a PR nobody reviewed.
 *
 * Deliberately NOT implemented by extending `EARLY_PHASE_ONLY_FIELDS` — a
 * branch and PR legitimately first appear DURING `in_build`/`in_review`, so
 * an early-phase gate would break the normal agent workflow. The tests below
 * pin both halves: refused once decided, allowed while the work is live.
 *
 * Defence in depth only. The webhook writes through `caseRepo` and never
 * reaches this service, which is why `Case.approved_head_sha` is the primary
 * guard — see `commit-status-service.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError, type Case, type CaseStatus } from '@arbitra/shared';

const state: { cases: Map<string, Case> } = { cases: new Map() };

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

const { CaseService } = await import('./case-service.js');
const { CaseRepository } = await import('./case-repository.js');

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
    status: 'approved',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    current_branch: 'feat/reviewed-work',
    current_pr_ref: 'https://github.com/acme/primary/pull/42',
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

const stubEventService = { emit: vi.fn().mockResolvedValue(undefined) };

function makeService() {
  return new CaseService(new CaseRepository(), stubEventService as never);
}

beforeEach(() => {
  state.cases = new Map();
  stubEventService.emit.mockClear();
});

describe('CaseService.updateCase — PR identity is locked once a case is decided (#1045)', () => {
  const decided: CaseStatus[] = ['approved', 'pending_merge', 'done', 'rejected'];

  for (const status of decided) {
    it(`refuses to re-point current_pr_ref on a '${status}' case`, async () => {
      state.cases.set('case_1', makeCase({ status }));
      const service = makeService();

      await expect(
        service.updateCase(
          'case_1',
          { current_pr_ref: 'https://github.com/acme/primary/pull/99' },
          'usr_owner',
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(state.cases.get('case_1')!.current_pr_ref).toBe(
        'https://github.com/acme/primary/pull/42',
      );
    });
  }

  it('refuses to re-point current_branch on a decided case', async () => {
    state.cases.set('case_1', makeCase({ status: 'approved' }));
    const service = makeService();

    await expect(
      service.updateCase('case_1', { current_branch: 'feat/other-work' }, 'usr_owner'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('names both fields when both are re-pointed at once', async () => {
    state.cases.set('case_1', makeCase({ status: 'approved' }));
    const service = makeService();

    await expect(
      service.updateCase(
        'case_1',
        {
          current_branch: 'feat/other-work',
          current_pr_ref: 'https://github.com/acme/primary/pull/99',
        },
        'usr_owner',
      ),
    ).rejects.toThrow(/current_pr_ref.*current_branch|current_branch.*current_pr_ref/);
  });

  it('allows resubmitting the SAME values on a decided case (no-op edit)', async () => {
    // Mirrors the `case_type` guard: an edit form that resubmits every field
    // must not be rejected for fields it did not change.
    state.cases.set('case_1', makeCase({ status: 'approved' }));
    const service = makeService();

    const updated = await service.updateCase(
      'case_1',
      {
        priority: 'high',
        current_branch: 'feat/reviewed-work',
        current_pr_ref: 'https://github.com/acme/primary/pull/42',
      },
      'usr_owner',
    );

    expect(updated.priority).toBe('high');
    expect(updated.current_pr_ref).toBe('https://github.com/acme/primary/pull/42');
  });

  for (const status of ['in_build', 'in_validation', 'in_review'] as CaseStatus[]) {
    it(`still allows setting the branch and PR while the case is '${status}'`, async () => {
      // Revert line: adding these fields to `EARLY_PHASE_ONLY_FIELDS` instead
      // of gating on decided statuses — that would fail here and break the
      // ordinary "create case, then push a branch" agent workflow.
      state.cases.set(
        'case_1',
        makeCase({ status, current_branch: undefined, current_pr_ref: undefined }),
      );
      const service = makeService();

      const updated = await service.updateCase(
        'case_1',
        {
          current_branch: 'feat/fresh-branch',
          current_pr_ref: 'https://github.com/acme/primary/pull/7',
        },
        'usr_owner',
      );

      expect(updated.current_branch).toBe('feat/fresh-branch');
      expect(updated.current_pr_ref).toBe('https://github.com/acme/primary/pull/7');
    });
  }
});
