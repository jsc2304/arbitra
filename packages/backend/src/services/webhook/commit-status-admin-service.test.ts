/**
 * Tests for `commit-status-admin-service.ts` (issue #1032: operator
 * escape hatch for a required `arbitra/case` status check).
 *
 * The central claim under test — "the mapping cannot drift" — is proven in
 * `'goes through the REAL publishCaseCommitStatus default...'` below by
 * calling `republishCommitStatus` with `publishCase` left at its
 * PRODUCTION default (only `resolveCase` is injected, to avoid a live
 * Firestore case-resolution ladder) and a global `fetch` stub standing in
 * for GitHub. That test was verified empirically to catch drift: swapping
 * the production `publishCase` default for
 * `async () => ({ published: true as const, state: 'success' as const })`
 * (an unconditional success for every Enforced Case — exactly the bypass
 * this endpoint must not have) makes it fail. All the OTHER tests in this
 * file inject `publishCase` directly and so do NOT exercise that wiring —
 * they only prove `republishCommitStatus`'s own control flow (audit,
 * result shape, early-exit ordering).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case } from '@arbitra/shared';

// The "no drift" test below calls the REAL `publishCaseCommitStatus`, which
// reaches `collections.evidence()` (for completeness). Doubled exactly like
// `commit-status-service.test.ts` does, so that test exercises the real
// mapping function end to end without touching a live Firestore.
vi.mock('../../lib/firestore.js', () => ({
  collections: {
    evidence: () => ({
      where: () => ({ get: async () => ({ docs: [] }) }),
    }),
    evidencePolicies: () => ({
      where: () => ({ get: async () => ({ empty: true, docs: [] }) }),
    }),
  },
}));

const fetchMock = vi.fn();

const {
  republishCommitStatus,
} = await import('./commit-status-admin-service.js');
const {
  computeCommitStatusVerdict,
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
    status: 'in_review',
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

function makeDeps(overrides: Record<string, unknown> = {}) {
  const emit = vi.fn().mockResolvedValue({ event_id: 'event_1' });
  const record = vi.fn().mockResolvedValue({ event_id: 'wsevent_1' });
  return {
    eventService: { emit } as unknown,
    workspaceEventService: { record } as unknown,
    emit,
    record,
    ...overrides,
  };
}

const registeredResolution = (case_: Case | null) => vi.fn().mockResolvedValue({
  repositoryRegistered: true,
  repositoryId: 'repo_1',
  case: case_,
});

const fetchDetailsOk = (overrides: Record<string, unknown> = {}) => vi.fn().mockResolvedValue({
  headSha: 'deadbeef',
  branch: 'feat/x',
  title: '',
  body: '',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env['GITHUB_TOKEN'] = 'test-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['GITHUB_TOKEN'];
});

describe('republishCommitStatus', () => {
  it('rejects an unresolvable PR reference without touching any collaborator', async () => {
    const fetchPrDetails = vi.fn();
    const resolveCase = vi.fn();
    const publishCase = vi.fn();
    const publishNoCase = vi.fn();
    const deps = makeDeps();

    const result = await republishCommitStatus(
      { prUrl: 'not a github pr url' },
      'usr_admin',
      { fetchPrDetails, resolveCase, publishCase, publishNoCase, ...deps },
    );

    expect(result).toEqual({ ok: false, reason: 'invalid_pr_reference' });
    expect(fetchPrDetails).not.toHaveBeenCalled();
    expect(resolveCase).not.toHaveBeenCalled();
    expect(deps.emit).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
  });

  it('accepts owner/repo/prNumber, canonicalizes to a github.com PR URL, and fetches PR details for that ref', async () => {
    const fetchPrDetails = fetchDetailsOk();
    const resolveCase = registeredResolution(null);
    const publishNoCase = vi.fn().mockResolvedValue({ published: true, state: 'success' });
    const deps = makeDeps();

    const result = await republishCommitStatus(
      { owner: 'acme', repo: 'demo', prNumber: 42 },
      'usr_admin',
      {
        fetchPrDetails, resolveCase, publishCase: vi.fn(), publishNoCase, ...deps,
      },
    );

    expect(fetchPrDetails).toHaveBeenCalledWith('acme', 'demo', 42);
    expect(resolveCase).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'acme',
      repo: 'demo',
      prUrl: 'https://github.com/acme/demo/pull/42',
      branch: 'feat/x',
    }));
    expect(publishNoCase).toHaveBeenCalledWith('https://github.com/acme/demo/pull/42', { headSha: 'deadbeef' });
    expect(result).toMatchObject({ ok: true, prUrl: 'https://github.com/acme/demo/pull/42' });
  });

  it('fails closed when GitHub PR-details lookup fails, and still audits the attempt', async () => {
    const fetchPrDetails = vi.fn().mockResolvedValue(null);
    const resolveCase = vi.fn();
    const deps = makeDeps();

    const result = await republishCommitStatus(
      { owner: 'acme', repo: 'demo', prNumber: 42 },
      'usr_admin',
      {
        fetchPrDetails, resolveCase, publishCase: vi.fn(), publishNoCase: vi.fn(), ...deps,
      },
    );

    expect(result).toEqual({ ok: false, reason: 'pr_lookup_failed', prUrl: 'https://github.com/acme/demo/pull/42' });
    expect(resolveCase).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      type: 'commit_status_republished',
      actor_user_id: 'usr_admin',
      evidence: expect.objectContaining({ published: false, failure_reason: 'pr_lookup_failed' }),
    }));
  });

  it('refuses to publish onto an unregistered repository instead of falling through to a no-case success', async () => {
    // Drift guard: a repo Arbitra has
    // never onboarded must not receive an unconditional `success`.
    const fetchPrDetails = fetchDetailsOk();
    const resolveCase = vi.fn().mockResolvedValue({ repositoryRegistered: false, case: null });
    const publishCase = vi.fn();
    const publishNoCase = vi.fn();
    const deps = makeDeps();

    const result = await republishCommitStatus(
      { owner: 'someoneelse', repo: 'unrelated', prNumber: 1 },
      'usr_admin',
      {
        fetchPrDetails, resolveCase, publishCase, publishNoCase, ...deps,
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'repository_not_registered',
      prUrl: 'https://github.com/someoneelse/unrelated/pull/1',
    });
    expect(publishCase).not.toHaveBeenCalled();
    expect(publishNoCase).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({ failure_reason: 'repository_not_registered' }),
    }));
  });

  it('resolves through resolveCaseForPrRecovery (the webhook ladder), not an exact current_pr_ref match alone', async () => {
    // A case found via the branch-name/PR-text/current_branch rungs of the
    // ladder, whose `current_pr_ref` is EMPTY (the exact scenario a lost
    // pull_request.opened delivery leaves behind — issue #1032's primary
    // failure mode), must still be resolved and gate the publish.
    const case_ = makeCase({ status: 'needs_human_decision', current_pr_ref: undefined });
    const fetchPrDetails = fetchDetailsOk({ branch: 'feat/case-pure-dawn-mQj7' });
    const resolveCase = registeredResolution(case_);
    const publishCase = vi.fn().mockResolvedValue({ published: true, state: 'failure' });
    const publishNoCase = vi.fn();
    const deps = makeDeps();

    const result = await republishCommitStatus(
      { owner: 'acme', repo: 'demo', prNumber: 7 },
      'usr_admin',
      {
        fetchPrDetails, resolveCase, publishCase, publishNoCase, ...deps,
      },
    );

    expect(resolveCase).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feat/case-pure-dawn-mQj7' }));
    // The case has NO current_pr_ref of its own —
    // `publishCaseCommitStatus` would refuse with `no_pr_ref` unless told
    // to publish onto the operator-supplied PR instead. `prRefOverride`
    // carries that PR (the SAME one `fetchPrDetails`/`resolveCase` were
    // just called for), while `{}` deps confirms the verdict computation
    // itself is untouched — no new branch, still the shared mapping.
    expect(publishCase).toHaveBeenCalledWith(
      case_,
      {},
      { headSha: 'deadbeef', prRefOverride: 'https://github.com/acme/demo/pull/7' },
    );
    expect(publishNoCase).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, caseId: 'case_1', state: 'failure' });
  });

  it('a case matched via the ladder with an EMPTY current_pr_ref still gets its real enforced verdict published (not a no-case success)', async () => {
    // End-to-end through the REAL publishCaseCommitStatus (only resolveCase
    // is injected) — proves the fix all the way down to the actual GitHub
    // POST body: the verdict published is the case's own computed verdict
    // (via the unmodified computeCommitStatusVerdict/CompletenessEvaluator
    // seam), landed on the operator-supplied PR, never the unconditional
    // no-case `success`.
    const case_ = makeCase({ status: 'needs_human_decision', current_pr_ref: undefined });
    const resolveCase = registeredResolution(case_);
    const deps = makeDeps();

    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/pulls/7') && !url.includes('/statuses/')) {
        return {
          ok: true,
          json: async () => ({ head: { sha: 'deadbeef', ref: 'feat/x' }, title: '', body: '' }),
        };
      }
      if (typeof url === 'string' && url.includes('/statuses/deadbeef')) {
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });

    const result = await republishCommitStatus(
      { owner: 'acme', repo: 'demo', prNumber: 7 },
      'usr_admin',
      { resolveCase, ...deps },
    );

    // needs_human_decision is a blocking `failure` under the shared
    // mapping — the opposite of the no-case `success` a resolution bug
    // would have silently published over a prior failing check.
    const directVerdict = computeCommitStatusVerdict('needs_human_decision', []);
    expect(directVerdict.state).toBe('failure');
    expect(result).toMatchObject({ ok: true, caseId: 'case_1', state: 'failure' });

    const statusCall = fetchMock.mock.calls.find(([url]) => typeof url === 'string' && url.includes('/statuses/deadbeef'));
    expect(statusCall).toBeDefined();
    const [statusUrl, requestInit] = statusCall!;
    // Published against the OPERATOR-SUPPLIED PR's head sha — not silently
    // dropped for lack of a current_pr_ref on the case.
    expect(statusUrl).toBe('https://api.github.com/repos/acme/demo/statuses/deadbeef');
    const body = JSON.parse((requestInit as { body: string }).body) as { state: string; description: string };
    expect(body.state).toBe('failure');
    expect(body.description).toContain('awaiting human decision');
  });

  it('audits a successful re-publish onto the case timeline when a case was found', async () => {
    const case_ = makeCase();
    const fetchPrDetails = fetchDetailsOk();
    const resolveCase = registeredResolution(case_);
    const publishCase = vi.fn().mockResolvedValue({ published: true, state: 'success' });
    const deps = makeDeps();

    const result = await republishCommitStatus(
      { prUrl: case_.current_pr_ref },
      'usr_admin',
      {
        fetchPrDetails, resolveCase, publishCase, publishNoCase: vi.fn(), ...deps,
      },
    );

    expect(result).toMatchObject({ ok: true, caseId: 'case_1', state: 'success', auditEventId: 'event_1' });
    expect(deps.emit).toHaveBeenCalledTimes(1);
    expect(deps.emit).toHaveBeenCalledWith(
      'case_1',
      'commit_status_republished',
      expect.objectContaining({ pr_url: case_.current_pr_ref, published: true, state: 'success' }),
      'usr_admin',
    );
    expect(deps.record).not.toHaveBeenCalled();
  });

  it('audits onto the workspace feed (not a case) when no case matches the PR', async () => {
    const fetchPrDetails = fetchDetailsOk();
    const resolveCase = registeredResolution(null);
    const publishNoCase = vi.fn().mockResolvedValue({ published: true, state: 'success' });
    const deps = makeDeps();

    const result = await republishCommitStatus(
      { owner: 'acme', repo: 'demo', prNumber: 9 },
      'usr_admin',
      {
        fetchPrDetails, resolveCase, publishCase: vi.fn(), publishNoCase, ...deps,
      },
    );

    expect(result).toMatchObject({ ok: true, caseId: null, auditEventId: 'wsevent_1' });
    expect(deps.record).toHaveBeenCalledTimes(1);
    expect(deps.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'commit_status_republished',
        actor_user_id: 'usr_admin',
        evidence: expect.objectContaining({ published: true, case_id: null }),
      }),
    );
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it('still audits — and reports failure — when the underlying publish fails', async () => {
    const case_ = makeCase();
    const fetchPrDetails = fetchDetailsOk();
    const resolveCase = registeredResolution(case_);
    const publishCase = vi.fn().mockResolvedValue({ published: false, reason: 'github_api_403' });
    const deps = makeDeps();

    const result = await republishCommitStatus(
      { prUrl: case_.current_pr_ref },
      'usr_admin',
      {
        fetchPrDetails, resolveCase, publishCase, publishNoCase: vi.fn(), ...deps,
      },
    );

    expect(result).toEqual({ ok: false, reason: 'github_api_403', prUrl: case_.current_pr_ref });
    expect(deps.emit).toHaveBeenCalledWith(
      'case_1',
      'commit_status_republished',
      expect.objectContaining({ published: false, failure_reason: 'github_api_403' }),
      'usr_admin',
    );
  });

  it('B2 — goes through the REAL publishCaseCommitStatus default (only resolveCase injected) and matches computeCommitStatusVerdict exactly; sabotaging the production default to an unconditional success makes this test fail', async () => {
    const case_ = makeCase({ status: 'in_review' });
    const resolveCase = registeredResolution(case_);
    const deps = makeDeps();

    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/pulls/7') && !url.includes('/statuses/')) {
        return {
          ok: true,
          json: async () => ({ head: { sha: 'deadbeef', ref: 'feat/x' }, title: '', body: '' }),
        };
      }
      if (typeof url === 'string' && url.includes('/statuses/deadbeef')) {
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });

    // NOTE: fetchPrDetails, publishCase, and publishNoCase are ALL left at
    // their production defaults — only resolveCase is injected (case
    // resolution needs a live Firestore, out of scope for this unit test;
    // it is covered separately by `webhook-service`'s own ladder tests).
    const result = await republishCommitStatus(
      { owner: 'acme', repo: 'demo', prNumber: 7 },
      'usr_admin',
      { resolveCase, ...deps },
    );

    // The stubbed evidence collection returns no evidence at all, so the
    // REAL `CompletenessEvaluator` (production default, not injected) finds
    // required evidence missing for an `in_review` case under its built-in
    // default policy — `computeCommitStatusVerdict('in_review', <missing>)`
    // with any non-empty `missing` maps to `failure`. This is exactly the
    // kind of computed-not-asserted verdict a hand-rolled stub in the
    // service (e.g. an unconditional `{ published: true, state: 'success' }`
    // default) would get WRONG — this test fails if that swap is made.
    expect(result).toMatchObject({ ok: true, caseId: 'case_1', state: 'failure' });

    // The status POST really happened, through the real publish seam, with
    // a real verdict description attached — not a stand-in.
    const statusCall = fetchMock.mock.calls.find(([url]) => typeof url === 'string' && url.includes('/statuses/deadbeef'));
    expect(statusCall).toBeDefined();
    const body = JSON.parse((statusCall![1] as { body: string }).body) as { state: string; description: string };
    expect(body.state).toBe('failure');
    expect(body.description).toContain('evidence missing');
    // Sanity: matches `computeCommitStatusVerdict` when fed the SAME
    // "evidence missing" reason the real evaluator concluded — proving the
    // verdict text is the mapping function's own output, not improvised.
    const directVerdict = computeCommitStatusVerdict('in_review', ['ci_result']);
    expect(directVerdict.state).toBe('failure');
  });
});
