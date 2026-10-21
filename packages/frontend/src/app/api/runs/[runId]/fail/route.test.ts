import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// POST /api/runs/:runId/fail must resolve case access from the
// *stored* run doc's case_id, never from a client-supplied body.case_id.
// Also covers: unknown runId -> 404.
// ---------------------------------------------------------------------------

const { runDocGet, failRun, onRunCompleted } = vi.hoisted(() => ({
  runDocGet: vi.fn(),
  failRun: vi.fn(),
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
    failRun,
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
  return new NextRequest('http://localhost/api/runs/run_1/fail', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireCaseAccess.mockResolvedValue(null);
  runDocGet.mockResolvedValue({
    exists: true,
    data: () => ({ run_id: 'run_1', case_id: 'case_real', status: 'running' }),
  });
  failRun.mockResolvedValue({ run_id: 'run_1', case_id: 'case_real', status: 'failed' });
  onRunCompleted.mockResolvedValue({ transitions: [], final_status: 'needs_human_decision', next_actions: [] });
});

describe('POST /api/runs/:runId/fail', () => {
  it('returns 404 when the caller cannot access the run\'s actual case (ignores a spoofed body.case_id)', async () => {
    requireCaseAccess.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const response = await POST(
      makeReq({ error: 'boom', case_id: 'case_attacker_controls' }),
      { params: Promise.resolve({ runId: 'run_1' }) },
    );

    expect(response.status).toBe(404);
    expect(requireCaseAccess).toHaveBeenCalledWith('case_real', 'user_1');
    expect(failRun).not.toHaveBeenCalled();
  });

  it('fails the run for a member of the run\'s actual case project', async () => {
    const response = await POST(
      makeReq({ error: 'boom', case_id: 'case_attacker_controls' }),
      { params: Promise.resolve({ runId: 'run_1' }) },
    );

    expect(response.status).toBe(200);
    expect(requireCaseAccess).toHaveBeenCalledWith('case_real', 'user_1');
    // The resolved case_id from the run doc is used, not the body value.
    expect(failRun).toHaveBeenCalledWith('run_1', 'case_real', 'boom');
    expect(onRunCompleted).toHaveBeenCalledWith('case_real');
  });

  it('returns 404 for an unknown runId without checking case access', async () => {
    runDocGet.mockResolvedValueOnce({ exists: false, data: () => undefined });

    const response = await POST(
      makeReq({ error: 'boom' }),
      { params: Promise.resolve({ runId: 'run_missing' }) },
    );

    expect(response.status).toBe(404);
    expect(requireCaseAccess).not.toHaveBeenCalled();
    expect(failRun).not.toHaveBeenCalled();
  });

  // Issue #749 item 4: a run doc with no case_id used to reach
  // `requireCaseAccess` regardless, which — against the real
  // `checkCaseAccess` (mocked away here) — throws on Firestore's `.doc('')`
  // and surfaces as an ungraceful 500. Reverting the `!existingRun.case_id`
  // guard makes this assertion fail (the mocked `requireCaseAccess` would be
  // called with `undefined` and the route would fall through to `failRun`
  // instead of 404ing).
  it('returns 404 (not a 500) when the stored run doc has no case_id', async () => {
    runDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ run_id: 'run_1', status: 'running' }), // no case_id
    });

    const response = await POST(
      makeReq({ error: 'boom' }),
      { params: Promise.resolve({ runId: 'run_1' }) },
    );

    expect(response.status).toBe(404);
    expect(requireCaseAccess).not.toHaveBeenCalled();
    expect(failRun).not.toHaveBeenCalled();
  });
});
