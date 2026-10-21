import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// POST /api/runs/:runId/complete must resolve case access from the
// *stored* run doc's case_id, never from a client-supplied body.case_id.
// Also covers: unknown runId -> 404.
//
// Issue #1047 (door 1) — a `review_run` (and the worker-only assistant run
// types) must never be force-completable through this route. The old gate
// was `requireCaseAccess` alone: no `run_type` filter, no role check, no
// worker/lease check, so any project member could flip a `running`
// `review_run` straight to `completed` before the LLM call it was created
// for ever returned — satisfying `review_run_completed` /
// `auto_approve_criteria_met` on a review that never ran. See
// `isClientCompletableRunType` in `./route.ts`.
// ---------------------------------------------------------------------------

const { runDocGet, completeRun, onRunCompleted } = vi.hoisted(() => ({
  runDocGet: vi.fn(),
  completeRun: vi.fn(),
  onRunCompleted: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  collections: {
    runs: () => ({
      doc: (_id: string) => ({
        get: runDocGet,
      }),
    }),
  },
  FirestorePipelineAdapter: vi.fn().mockImplementation(() => ({
    completeRun,
  })),
  RunCompletionHandler: vi.fn().mockImplementation(() => ({
    onRunCompleted,
  })),
}));

const { authenticate, requireCaseAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireCaseAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => ({
  authenticate,
  requireCaseAccess,
  handleError: (error: unknown) =>
    NextResponse.json(
      { error: { message: error instanceof Error ? error.message : String(error) } },
      { status: 500 },
    ),
}));

import { POST } from './route';

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/runs/run_1/complete', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

/** Stubs the stored run doc `collections.runs().doc(runId).get()` resolves to. */
function stubRun(overrides: Record<string, unknown> = {}) {
  runDocGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ run_id: 'run_1', case_id: 'case_real', status: 'running', run_type: 'rule_run', ...overrides }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireCaseAccess.mockResolvedValue(null);
  runDocGet.mockResolvedValue({
    exists: true,
    data: () => ({ run_id: 'run_1', case_id: 'case_real', status: 'running', run_type: 'rule_run' }),
  });
  completeRun.mockResolvedValue({ run_id: 'run_1', case_id: 'case_real', status: 'completed' });
  onRunCompleted.mockResolvedValue({ transitions: [], final_status: 'in_review', next_actions: [] });
});

describe('POST /api/runs/:runId/complete', () => {
  it('returns 404 when the caller cannot access the run\'s actual case (ignores a spoofed body.case_id)', async () => {
    requireCaseAccess.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const response = await POST(
      // Attacker supplies a case_id they *do* have access to; the route must
      // still resolve access from the stored run doc's case_id (case_real).
      makeReq({ summary: 'done', case_id: 'case_attacker_controls' }),
      { params: Promise.resolve({ runId: 'run_1' }) },
    );

    expect(response.status).toBe(404);
    expect(requireCaseAccess).toHaveBeenCalledWith('case_real', 'user_1');
    expect(completeRun).not.toHaveBeenCalled();
  });

  it('completes a non-privileged run type (e.g. rule_run) for a member of the run\'s actual case project', async () => {
    const response = await POST(
      makeReq({ summary: 'done', case_id: 'case_attacker_controls' }),
      { params: Promise.resolve({ runId: 'run_1' }) },
    );

    expect(response.status).toBe(200);
    expect(requireCaseAccess).toHaveBeenCalledWith('case_real', 'user_1');
    // The resolved case_id from the run doc is used, not the body value.
    expect(completeRun).toHaveBeenCalledWith('run_1', 'case_real', 'done');
    expect(onRunCompleted).toHaveBeenCalledWith('case_real');
  });

  it('returns 404 for an unknown runId without checking case access', async () => {
    runDocGet.mockResolvedValueOnce({ exists: false, data: () => undefined });

    const response = await POST(
      makeReq({ summary: 'done' }),
      { params: Promise.resolve({ runId: 'run_missing' }) },
    );

    expect(response.status).toBe(404);
    expect(requireCaseAccess).not.toHaveBeenCalled();
    expect(completeRun).not.toHaveBeenCalled();
  });

  // Issue #749 item 4: a run doc with no case_id used to reach
  // `requireCaseAccess` regardless, which — against the real
  // `checkCaseAccess` (mocked away here) — throws on Firestore's `.doc('')`
  // and surfaces as an ungraceful 500. Reverting the `!existingRun.case_id`
  // guard makes this assertion fail (the mocked `requireCaseAccess` would be
  // called with `undefined` and the route would fall through to `completeRun`
  // instead of 404ing).
  it('returns 404 (not a 500) when the stored run doc has no case_id', async () => {
    runDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ run_id: 'run_1', status: 'running' }), // no case_id
    });

    const response = await POST(
      makeReq({ summary: 'done' }),
      { params: Promise.resolve({ runId: 'run_1' }) },
    );

    expect(response.status).toBe(404);
    expect(requireCaseAccess).not.toHaveBeenCalled();
    expect(completeRun).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Door 1 regression coverage — the actual bypass this issue closes.
  // -------------------------------------------------------------------------

  it('refuses to force-complete a review_run — the core review-gate bypass', async () => {
    stubRun({ run_type: 'review_run' });

    const response = await POST(
      makeReq({ summary: 'looks fine' }),
      { params: Promise.resolve({ runId: 'run_1' }) },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('RUN_TYPE_NOT_CLIENT_COMPLETABLE');
    expect(body.error.message).toMatch(/review_not_applicable/);
    // Case access was still resolved from the stored run's case_id first —
    // the run-type gate does not skip the access check.
    expect(requireCaseAccess).toHaveBeenCalledWith('case_real', 'user_1');
    expect(completeRun).not.toHaveBeenCalled();
    expect(onRunCompleted).not.toHaveBeenCalled();
  });

  it.each(['assistant_task_run', 'assistant_action_run'])(
    'refuses to force-complete a worker-owned %s',
    async (runType) => {
      stubRun({ run_type: runType });

      const response = await POST(
        makeReq({ summary: 'looks fine' }),
        { params: Promise.resolve({ runId: 'run_1' }) },
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe('RUN_TYPE_NOT_CLIENT_COMPLETABLE');
      expect(completeRun).not.toHaveBeenCalled();
    },
  );

  it('a non-member still gets 404 on a review_run, never learning the run-type gate exists', async () => {
    requireCaseAccess.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );
    stubRun({ run_type: 'review_run' });

    const response = await POST(
      makeReq({ summary: 'done' }),
      { params: Promise.resolve({ runId: 'run_1' }) },
    );

    expect(response.status).toBe(404);
    expect(completeRun).not.toHaveBeenCalled();
  });
});
