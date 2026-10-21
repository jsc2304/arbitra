import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// POST /api/runs must reject callers who aren't effective members of
// the target case's project.
//
// Issue #1047 (door 2) — a review run's diff must be resolved SERVER-SIDE
// from the case's own PR/branch (`resolveAndRunReview`), never taken from
// the request body. The old contract accepted a fully caller-supplied
// `diff` with only size caps and fed it straight to `ReviewService`, so any
// project member could submit a benign diff, get a genuinely clean review,
// and satisfy the review gate for a change the review never saw. A body
// `diff` is now REJECTED with 400 (not silently dropped) — this route is
// unversioned/additive-only, so silently changing what
// a caller-supplied field does would be a breaking change in disguise.
// ---------------------------------------------------------------------------

const {
  createRun,
  completeRun,
  onRunCompleted,
  resolveAndRunReview,
  findingsWhere,
  findingsGet,
} = vi.hoisted(() => ({
  createRun: vi.fn(),
  completeRun: vi.fn(),
  onRunCompleted: vi.fn(),
  resolveAndRunReview: vi.fn(),
  findingsWhere: vi.fn(),
  findingsGet: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  FirestorePipelineAdapter: vi.fn().mockImplementation(() => ({
    createRun,
    completeRun,
    resolveAndRunReview,
  })),
  RunCompletionHandler: vi.fn().mockImplementation(() => ({
    onRunCompleted,
  })),
  collections: {
    findings: () => ({
      where: findingsWhere,
    }),
  },
}));

const { authenticate, requireCaseAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireCaseAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => ({
  authenticate,
  requireCaseAccess,
  // Mirrors the real `formatError`'s `ArbitraError` branch
  // (packages/backend/src/middleware/error-handler.ts:37-42): an error that
  // carries its own `statusCode` (401 from `authenticate`, 403 from
  // `requireCaseAccess`, etc.) is published at that status, not flattened to
  // 500. A version of this mock that hardcoded 500 regardless of the thrown
  // error made the "authenticates before touching the case" test below
  // trivially true — it asserted on a mock decision, not on real 401
  // behavior (issue #1054, "Test nit" bullet).
  handleError: (error: unknown) =>
    NextResponse.json(
      { error: { message: error instanceof Error ? error.message : String(error) } },
      { status: (error as { statusCode?: number } | null | undefined)?.statusCode ?? 500 },
    ),
}));

import { POST } from './route';

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/runs', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

// A finding as actually persisted (case_id, no run_id — see
// packages/shared/src/types/finding.ts / lib/finding-idempotency.ts).
const SEEDED_FINDING = {
  finding_id: 'finding_1',
  case_id: 'case_1',
  category: 'bug',
  severity: 'high',
  status: 'open',
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireCaseAccess.mockResolvedValue(null);
  createRun.mockResolvedValue({ run_id: 'run_1', case_id: 'case_1', status: 'pending' });
  completeRun.mockResolvedValue(undefined);
  onRunCompleted.mockResolvedValue({ transitions: [], final_status: 'in_review', next_actions: [] });
  resolveAndRunReview.mockResolvedValue({
    run: {
      run_id: 'run_2',
      case_id: 'case_1',
      run_type: 'review_run',
      status: 'completed',
    },
  });
  findingsWhere.mockReturnValue({ get: findingsGet });
  // Non-empty by default: a test that accidentally drops findings (e.g. a
  // query that can never match) must fail rather than pass vacuously.
  findingsGet.mockResolvedValue({ docs: [{ data: () => SEEDED_FINDING }] });
});

describe('POST /api/runs', () => {
  it('returns 404 and creates nothing when the caller is not a member of the case project', async () => {
    requireCaseAccess.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const response = await POST(
      makeReq({ case_id: 'case_1', run_type: 'build_run' }),
    );

    expect(response.status).toBe(404);
    expect(requireCaseAccess).toHaveBeenCalledWith('case_1', 'user_1');
    expect(createRun).not.toHaveBeenCalled();
    expect(resolveAndRunReview).not.toHaveBeenCalled();
  });

  it('creates a generic run for a case-project member (non-review run_type)', async () => {
    const response = await POST(
      makeReq({ case_id: 'case_1', run_type: 'build_run' }),
    );

    expect(response.status).toBe(201);
    expect(requireCaseAccess).toHaveBeenCalledWith('case_1', 'user_1');
    expect(createRun).toHaveBeenCalledWith('case_1', 'build_run', 'user_1');
  });

  // An assistant run is created unclaimed and then executed. This route creates
  // and completes a run in one breath, so minting one here would also make it
  // the case's latest assistant attempt — which both assistant preconditions
  // judge the case by, and which carries no `task_result`.
  it.each(['assistant_task_run', 'assistant_action_run'])(
    'refuses to create %s, which belongs to the assistant intake',
    async (runType) => {
      const response = await POST(makeReq({ case_id: 'case_1', run_type: runType }));

      expect(response.status).toBe(400);
      expect(createRun).not.toHaveBeenCalled();
      expect(resolveAndRunReview).not.toHaveBeenCalled();
    },
  );

  it('runs a review for a case-project member by resolving the diff server-side, returning the case\'s findings', async () => {
    const response = await POST(
      makeReq({ case_id: 'case_1', run_type: 'review_run' }),
    );

    expect(response.status).toBe(201);
    expect(requireCaseAccess).toHaveBeenCalledWith('case_1', 'user_1');
    // trigger_source is the calling user, not the diff — preserves the
    // audit trail for a manually-requested review (issue #1047 follow-up).
    expect(resolveAndRunReview).toHaveBeenCalledWith('case_1', 1, 'user_1');
    const body = await response.json();
    expect(body.run).toEqual({
      run_id: 'run_2',
      case_id: 'case_1',
      run_type: 'review_run',
      status: 'completed',
    });
  });

  // Findings regression test (review follow-up on #1047): a `run_id` filter
  // can never match — findings have no such field — so this route used to
  // always report `findings: []` regardless of what the review actually
  // found. Scoping by `case_id` (the run's case, mirroring
  // GET /api/cases/[caseId]/findings) is what makes the seeded finding above
  // actually come back. Reverting the query to `where('run_id', ...)` makes
  // this assertion fail.
  it('returns the findings the review produced (case_id-scoped, not a non-existent run_id field)', async () => {
    const response = await POST(
      makeReq({ case_id: 'case_1', run_type: 'review_run' }),
    );

    expect(response.status).toBe(201);
    expect(findingsWhere).toHaveBeenCalledWith('case_id', '==', 'case_1');
    const body = await response.json();
    expect(body.findings).toEqual([SEEDED_FINDING]);
  });

  // The core door-2 regression test: a caller-supplied `diff` must be
  // rejected, not silently dropped — a 201 with the diff quietly ignored
  // would let the caller believe it was reviewed. `resolveAndRunReview` must
  // never even be invoked once a body diff is present.
  it('rejects a caller-supplied diff with 400 instead of silently ignoring it', async () => {
    const attackerDiff = 'diff --git a/one-line.txt b/one-line.txt\n+totally benign change';

    const response = await POST(
      makeReq({ case_id: 'case_1', run_type: 'review_run', diff: attackerDiff }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(resolveAndRunReview).not.toHaveBeenCalled();
  });

  it('defaults to a review run when run_type is omitted (no diff supplied)', async () => {
    const response = await POST(
      makeReq({ case_id: 'case_1' }),
    );

    expect(response.status).toBe(201);
    expect(resolveAndRunReview).toHaveBeenCalledWith('case_1', 1, 'user_1');
  });

  it('rejects a body diff even when run_type is omitted', async () => {
    const response = await POST(
      makeReq({ case_id: 'case_1', diff: 'diff --git a/x b/x\n+line' }),
    );

    expect(response.status).toBe(400);
    expect(resolveAndRunReview).not.toHaveBeenCalled();
  });

  it('returns 400 NO_DIFF_SOURCE (no-reference message) when the case has no PR/branch to resolve a diff from', async () => {
    resolveAndRunReview.mockResolvedValueOnce({ run: null, failureReason: 'no_diff_source' });

    const response = await POST(
      makeReq({ case_id: 'case_1', run_type: 'review_run' }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('NO_DIFF_SOURCE');
    expect(body.error.message).toMatch(/no pr or branch reference/i);
  });

  // Issue #1054: a PR/branch reference IS set but GitHub would not give us
  // the diff (bad token, rate limit, PR/branch no longer exists) must NOT
  // read as "case has no PR or branch reference" — that sends the operator
  // to set a field that is already set.
  it('returns 400 NO_DIFF_SOURCE (fetch-failed message) when the diff could not be fetched from GitHub', async () => {
    resolveAndRunReview.mockResolvedValueOnce({ run: null, failureReason: 'diff_fetch_failed' });

    const response = await POST(
      makeReq({ case_id: 'case_1', run_type: 'review_run' }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('NO_DIFF_SOURCE');
    expect(body.error.message).toMatch(/could not be fetched from github/i);
    expect(body.error.message).not.toMatch(/no pr or branch reference/i);
  });

  it('authenticates before touching the case on a review-run request', async () => {
    authenticate.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));

    const response = await POST(
      makeReq({ case_id: 'case_1', run_type: 'review_run' }),
    );

    expect(authenticate).toHaveBeenCalled();
    expect(requireCaseAccess).not.toHaveBeenCalled();
    expect(resolveAndRunReview).not.toHaveBeenCalled();
    // Real 401 behavior, not the mock's old hardcoded 500 (issue #1054).
    expect(response.status).toBe(401);
  });
});
