/**
 * Tests for `commit-status-service.ts` (issue #988: merge-time enforcement
 * via GitHub status check).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case, Evidence } from '@arbitra/shared';

// ── Firestore double ─────────────────────────────────────────────────────
// `collections.evidence()` backs the completeness read; `collections.cases()`
// backs the approval-pin write (issue #1045).
const state: {
  evidence: Evidence[];
  casePatches: Array<{ id: string; patch: Record<string, unknown> }>;
  casePatchThrows: boolean;
} = { evidence: [], casePatches: [], casePatchThrows: false };
vi.mock('../../lib/firestore.js', () => ({
  collections: {
    evidence: () => ({
      where: () => ({
        get: async () => ({ docs: state.evidence.map((e) => ({ data: () => e })) }),
      }),
    }),
    cases: () => ({
      doc: (id: string) => ({
        async update(patch: Record<string, unknown>) {
          if (state.casePatchThrows) throw new Error('firestore down');
          state.casePatches.push({ id, patch });
        },
      }),
    }),
    // No stored evidence policy → CompletenessEvaluator falls back to its
    // built-in default policy for the case's (risk_level, validation_track).
    evidencePolicies: () => ({
      where: () => ({
        get: async () => ({ empty: true, docs: [] }),
      }),
    }),
  },
}));

const {
  computeCommitStatusVerdict,
  applyApprovalCommitPin,
  isEnforcedCase,
  publishCaseCommitStatus,
  publishNoCaseCommitStatus,
  ARBITRA_COMMIT_STATUS_CONTEXT,
} = await import('./commit-status-service.js');

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Test Case',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'usr_owner',
    status: 'in_build',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    case_type: 'bugfix',
    current_pr_ref: 'https://github.com/acme/demo/pull/7',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: true,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  state.evidence = [];
  state.casePatches = [];
  state.casePatchThrows = false;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env['GITHUB_TOKEN'] = 'test-token';
  delete process.env['ARBITRA_URL'];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['GITHUB_TOKEN'];
  delete process.env['ARBITRA_URL'];
});

// ── isEnforcedCase ───────────────────────────────────────────────────────

describe('isEnforcedCase', () => {
  it('is true for a manual case_type (bugfix)', () => {
    // Revert line: `case_.case_type === undefined || !SCOPED_CASE_TYPES.has(...)`
    // → `false` would make this fail.
    expect(isEnforcedCase({ case_type: 'bugfix' })).toBe(true);
  });

  it('is true for undefined case_type (legacy/manual cases)', () => {
    expect(isEnforcedCase({ case_type: undefined })).toBe(true);
  });

  it('is false for an observed case', () => {
    // Revert line: the guard's `!SCOPED_CASE_TYPES.has(case_.case_type)` — a
    // reverted guard (e.g. always `true`) makes this assertion fail.
    expect(isEnforcedCase({ case_type: 'observed' })).toBe(false);
  });

  it('is false for an assistant_task case', () => {
    expect(isEnforcedCase({ case_type: 'assistant_task' })).toBe(false);
  });
});

// ── computeCommitStatusVerdict ──────────────────────────────────────────

describe('computeCommitStatusVerdict', () => {
  it('is failure with the missing evidence types named, for in_build with missing evidence', () => {
    // Revert line: `if (missing.length > 0) { reasons.push(...) }` removed
    // → description would not name the missing evidence.
    const verdict = computeCommitStatusVerdict('in_build', ['ci_result', 'unit_test_result']);
    expect(verdict.state).toBe('failure');
    expect(verdict.description).toContain('ci_result');
    expect(verdict.description).toContain('unit_test_result');
  });

  it('is success for approved with no missing evidence', () => {
    // Revert line: `status === 'approved' ... → success` branch removed
    // → this would fall through to the failure/pending branch below.
    const verdict = computeCommitStatusVerdict('approved', []);
    expect(verdict).toEqual({ state: 'success', description: 'case approved' });
  });

  it('is success for pending_merge and done', () => {
    expect(computeCommitStatusVerdict('pending_merge', []).state).toBe('success');
    expect(computeCommitStatusVerdict('done', []).state).toBe('success');
  });

  it('is failure for rejected regardless of evidence', () => {
    // Revert line: `if (status === 'rejected') return { state: 'failure', ... }`
    const verdict = computeCommitStatusVerdict('rejected', []);
    expect(verdict).toEqual({ state: 'failure', description: 'case rejected' });
  });

  it('is failure for needs_human_decision even with no missing evidence (AC: awaiting approval fails the check)', () => {
    // Revert line: `blocking = ... || status === 'needs_human_decision' ...`
    const verdict = computeCommitStatusVerdict('needs_human_decision', []);
    expect(verdict.state).toBe('failure');
    expect(verdict.description).toContain('awaiting human decision');
  });

  it('is failure for verification_pending even with no missing evidence', () => {
    const verdict = computeCommitStatusVerdict('verification_pending', []);
    expect(verdict.state).toBe('failure');
    expect(verdict.description).toContain('awaiting manual verification');
  });

  it('is pending for in_review with no missing evidence', () => {
    // Revert line: `blocking` including `in_review` would flip this to failure.
    const verdict = computeCommitStatusVerdict('in_review', []);
    expect(verdict.state).toBe('pending');
    expect(verdict.description).toContain('review in progress');
  });

  it('is pending for in_build with no missing evidence', () => {
    const verdict = computeCommitStatusVerdict('in_build', []);
    expect(verdict.state).toBe('pending');
  });

  it('truncates the description to the GitHub 140-char limit', () => {
    const manyTypes = Array.from({ length: 20 }, (_, i) => `evidence_type_number_${i}`);
    const verdict = computeCommitStatusVerdict('in_build', manyTypes);
    expect(verdict.description.length).toBeLessThanOrEqual(140);
  });
});

// ── publishCaseCommitStatus ──────────────────────────────────────────────

describe('publishCaseCommitStatus', () => {
  it('publishes success ("observed — not enforced") for an Observed Case — issue #1024', async () => {
    // Revert line: the `!isEnforcedCase(case_)` branch skipping the GitHub
    // call entirely (pre-#1024 behavior) would make this fail — a required
    // `arbitra/case` check would then block an Observed-Case PR forever.
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    const case_ = makeCase({ case_type: 'observed' });
    const result = await publishCaseCommitStatus(case_, {}, { headSha: 'sha123' });
    expect(result).toEqual({ published: true, state: 'success' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.state).toBe('success');
    expect(body.description).toBe('observed — not enforced');
    expect(body.context).toBe(ARBITRA_COMMIT_STATUS_CONTEXT);
  });

  it('publishes success ("not enforced") for an Assistant Task case — issue #1024', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    const case_ = makeCase({ case_type: 'assistant_task' });
    const result = await publishCaseCommitStatus(case_, {}, { headSha: 'sha456' });
    expect(result).toEqual({ published: true, state: 'success' });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.description).toBe('not enforced');
  });

  it('publishes a failure status for an Enforced Case missing evidence', async () => {
    state.evidence = []; // nothing registered → all required evidence missing
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    const case_ = makeCase({ case_type: 'bugfix', status: 'in_build', risk_level: 'high' });

    const completenessEvaluator = {
      evaluate: vi.fn().mockResolvedValue({
        satisfied: false,
        required: ['ci_result'],
        present: [],
        missing: ['ci_result'],
        optional_present: [],
        four_eyes_required: false,
        allow_self_approval: true,
      }),
    };

    const result = await publishCaseCommitStatus(
      case_,
      { completenessEvaluator: completenessEvaluator as never },
      { headSha: 'sha_abc' },
    );

    expect(result).toEqual({ published: true, state: 'failure' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/acme/demo/statuses/sha_abc');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.state).toBe('failure');
    expect(body.description).toContain('ci_result');
    expect(body.context).toBe(ARBITRA_COMMIT_STATUS_CONTEXT);
  });

  it('publishes a success status when the case is approved AND the pin covers this commit', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    // `approved_head_sha` matches the SHA being published (issue #1045):
    // this is the reviewed commit, so the approval genuinely applies to it.
    const case_ = makeCase({ case_type: 'bugfix', status: 'approved', approved_head_sha: 'sha_ok' });

    const completenessEvaluator = {
      evaluate: vi.fn().mockResolvedValue({
        satisfied: true,
        required: [],
        present: [],
        missing: [],
        optional_present: [],
        four_eyes_required: false,
        allow_self_approval: true,
      }),
    };

    const result = await publishCaseCommitStatus(
      case_,
      { completenessEvaluator: completenessEvaluator as never },
      { headSha: 'sha_ok' },
    );

    expect(result).toEqual({ published: true, state: 'success' });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.state).toBe('success');
  });

  it('does not break the caller when the GitHub publish call throws', async () => {
    // Revert line: removing the outer try/catch around the whole function
    // body would let this rejection propagate instead of being swallowed.
    fetchMock.mockRejectedValue(new Error('network down'));
    const case_ = makeCase({ status: 'approved' });

    await expect(
      publishCaseCommitStatus(case_, {}, { headSha: 'sha_x' }),
    ).resolves.toEqual({ published: false, reason: 'exception' });
  });

  it('fetches the PR head SHA from GitHub when no headSha option is given', async () => {
    // Revert line: `options.headSha ?? (await fetchPullRequestHeadSha(...))`
    // — hardcoding to `options.headSha` only would make this call publish
    // nothing (no_head_sha) instead of resolving the SHA itself.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/pulls/7') && !url.includes('/pulls/7/')) {
        return { ok: true, status: 200, json: async () => ({ head: { sha: 'resolved_sha' } }) };
      }
      return { ok: true, status: 201 };
    });
    const case_ = makeCase({ status: 'approved', approved_head_sha: 'resolved_sha' });

    const result = await publishCaseCommitStatus(case_);

    expect(result).toEqual({ published: true, state: 'success' });
    const statusCall = fetchMock.mock.calls.find(([url]: [string]) =>
      url.includes('/statuses/'),
    );
    expect(statusCall![0]).toBe('https://api.github.com/repos/acme/demo/statuses/resolved_sha');
  });

  it('publishes nothing when the case has no PR ref and no override is given', async () => {
    const case_ = makeCase({ current_pr_ref: undefined });
    const result = await publishCaseCommitStatus(case_);
    expect(result).toEqual({ published: false, reason: 'no_pr_ref' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('issue #1032 — publishes onto prRefOverride when the case has no current_pr_ref of its own', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    const case_ = makeCase({ case_type: 'bugfix', status: 'rejected', current_pr_ref: undefined });

    const result = await publishCaseCommitStatus(case_, {}, {
      headSha: 'sha_override',
      prRefOverride: 'https://github.com/acme/demo/pull/99',
    });

    // The verdict is still the REAL mapping's own output (rejected →
    // failure) — only the publish target changed, not the computation.
    expect(result).toEqual({ published: true, state: 'failure' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/acme/demo/statuses/sha_override');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.state).toBe('failure');
    expect(body.description).toBe('case rejected');
  });

  it('prRefOverride takes priority over a case that DOES have a current_pr_ref', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    const case_ = makeCase({ current_pr_ref: 'https://github.com/acme/demo/pull/1' });

    await publishCaseCommitStatus(case_, {}, {
      headSha: 'sha_x',
      prRefOverride: 'https://github.com/other-owner/other-repo/pull/42',
    });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/other-owner/other-repo/statuses/sha_x');
  });
});

// ── applyApprovalCommitPin (issue #1045) ─────────────────────────────────

describe('applyApprovalCommitPin', () => {
  const success = { state: 'success' as const, description: 'case approved' };

  it('lets a success through when the pin IS the commit being published', () => {
    expect(
      applyApprovalCommitPin(success, { status: 'approved', approved_head_sha: 'sha_a' }, 'sha_a'),
    ).toEqual(success);
  });

  it('downgrades to failure when a later commit is published against an approved case', () => {
    // Revert line: the `pinned !== publishedSha` branch — the headline
    // #1045 defect. Without it `sha_b` (never reviewed) carries `success`.
    const verdict = applyApprovalCommitPin(
      success,
      { status: 'approved', approved_head_sha: 'sha_aaaaaaa1' },
      'sha_bbbbbbb2',
    );
    expect(verdict.state).toBe('failure');
    expect(verdict.description).toContain('superseded');
    expect(verdict.description).toContain('sha_bbb'); // the unreviewed commit
    expect(verdict.description).toContain('sha_aaa'); // the approved one
  });

  it('applies to pending_merge and done, not only approved', () => {
    for (const status of ['pending_merge', 'done'] as const) {
      expect(
        applyApprovalCommitPin(success, { status, approved_head_sha: 'sha_a' }, 'sha_b').state,
      ).toBe('failure');
    }
  });

  it('fails closed when the case carries no pin at all (legacy / never approved)', () => {
    const verdict = applyApprovalCommitPin(success, { status: 'approved' }, 'sha_any');
    expect(verdict.state).toBe('failure');
    expect(verdict.description).toContain('not pinned');
  });

  it('never upgrades: a failing or pending verdict passes through untouched', () => {
    const rejected = { state: 'failure' as const, description: 'case rejected' };
    const pending = { state: 'pending' as const, description: 'review in progress' };
    expect(applyApprovalCommitPin(rejected, { status: 'rejected' }, 'sha_a')).toEqual(rejected);
    expect(applyApprovalCommitPin(pending, { status: 'in_review' }, 'sha_a')).toEqual(pending);
  });

  it('leaves statuses outside the pinned set alone even with a stale pin', () => {
    // An `in_review` case that was previously approved still carries its old
    // pin; the pin must not turn its `pending` into anything else.
    const pending = { state: 'pending' as const, description: 'review in progress' };
    expect(
      applyApprovalCommitPin(pending, { status: 'in_review', approved_head_sha: 'sha_old' }, 'sha_new'),
    ).toEqual(pending);
  });

  it('keeps the description within the GitHub 140-char limit', () => {
    const verdict = applyApprovalCommitPin(
      success,
      { status: 'approved', approved_head_sha: 'a'.repeat(200) },
      'b'.repeat(200),
    );
    expect(verdict.description.length).toBeLessThanOrEqual(140);
  });
});

// ── publishCaseCommitStatus × the approval pin (issue #1045) ─────────────

describe('publishCaseCommitStatus — approval pin', () => {
  const satisfiedEvaluator = {
    evaluate: vi.fn().mockResolvedValue({
      satisfied: true,
      required: [],
      present: [],
      missing: [],
      optional_present: [],
      four_eyes_required: false,
      allow_self_approval: true,
    }),
  };

  it('publishes FAILURE on a head SHA the approval does not cover — the #1045 scenario', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    const case_ = makeCase({
      case_type: 'bugfix',
      status: 'approved',
      approved_head_sha: 'SHA_A_REVIEWED',
    });

    const result = await publishCaseCommitStatus(
      case_,
      { completenessEvaluator: satisfiedEvaluator as never },
      { headSha: 'SHA_B_UNREVIEWED' },
    );

    expect(result).toEqual({ published: true, state: 'failure' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/acme/demo/statuses/SHA_B_UNREVIEWED');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.state).toBe('failure');
    expect(body.description).toContain('superseded');
  });

  it('writes NOTHING to the case document — the pin is written transactionally', async () => {
    // Revert line: reintroducing a pin write inside the publish path. The
    // pin belongs to `applyTransitionInTransaction`, committed with the
    // status change that earns it; writing it here would make it depend on
    // a fire-and-forget notification and race the auto `approved →
    // pending_merge` publish.
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    const case_ = makeCase({
      case_type: 'bugfix',
      status: 'approved',
      approved_head_sha: 'SHA_A_REVIEWED',
    });

    await publishCaseCommitStatus(
      case_,
      { completenessEvaluator: satisfiedEvaluator as never },
      { headSha: 'SHA_A_REVIEWED' },
    );

    expect(state.casePatches).toEqual([]);
  });

  it('never gates an unenforced case (Observed / Assistant Task) on a pin', async () => {
    // These were never gated on a review, so an absent pin must not turn
    // their unconditional #1024 success into a failure.
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    const case_ = makeCase({ case_type: 'observed', status: 'done' });

    const result = await publishCaseCommitStatus(case_, {}, { headSha: 'sha_whatever' });

    expect(result).toEqual({ published: true, state: 'success' });
    expect(state.casePatches).toEqual([]);
  });
});

// ── publishNoCaseCommitStatus (issue #1024) ───────────────────────────────

describe('publishNoCaseCommitStatus', () => {
  it('publishes success ("no case — not enforced") for a PR with no matching case at all', async () => {
    // AC: "A PR with no case carries `arbitra/case: success`" — without this
    // a required `arbitra/case` check would block every unlinked PR forever.
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    const result = await publishNoCaseCommitStatus('https://github.com/acme/demo/pull/7', {
      headSha: 'sha_nocase',
    });
    expect(result).toEqual({ published: true, state: 'success' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/acme/demo/statuses/sha_nocase');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.state).toBe('success');
    expect(body.description).toBe('no case — not enforced');
    expect(body.context).toBe(ARBITRA_COMMIT_STATUS_CONTEXT);
  });

  it('resolves the head SHA from GitHub when no headSha option is given', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/pulls/7') && !url.includes('/pulls/7/')) {
        return { ok: true, status: 200, json: async () => ({ head: { sha: 'resolved_sha' } }) };
      }
      return { ok: true, status: 201 };
    });
    const result = await publishNoCaseCommitStatus('https://github.com/acme/demo/pull/7');
    expect(result).toEqual({ published: true, state: 'success' });
    const statusCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes('/statuses/'));
    expect(statusCall![0]).toBe('https://api.github.com/repos/acme/demo/statuses/resolved_sha');
  });

  it('returns unparsable_pr_ref for a PR URL that cannot be parsed', async () => {
    const result = await publishNoCaseCommitStatus('not-a-url');
    expect(result).toEqual({ published: false, reason: 'unparsable_pr_ref' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not throw when the GitHub publish call throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(
      publishNoCaseCommitStatus('https://github.com/acme/demo/pull/7', { headSha: 'sha_x' }),
    ).resolves.toEqual({ published: false, reason: 'exception' });
  });
});
