import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// POST /api/signals wiring: the route is a thin adapter over
// `ingestSessionSignalBatch` (tested at the service seam in
// packages/backend/src/services/session/__tests__/session-signal-service.test.ts).
// These tests cover only what the route itself is responsible for: envelope
// shape checking, auth, status code, and passing the service result through.
// ---------------------------------------------------------------------------

const { ingestSessionSignalBatch, ensureObservedCaseForSignal } = vi.hoisted(() => ({
  ingestSessionSignalBatch: vi.fn(),
  ensureObservedCaseForSignal: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({ ingestSessionSignalBatch, ensureObservedCaseForSignal }));

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));

// Full replacement (not `importActual`): api-helpers' other exports pull in
// `@arbitra/backend` at module scope too, which would drag the real backend
// package (and its `sanitize-html` CJS/ESM-incompatible dependency) into this
// unit test. `validationErrorResponse`/`invalidJsonResponse` are trivial
// enough to restate directly.
vi.mock('@/lib/api-helpers', () => ({
  authenticate,
  invalidJsonResponse: () =>
    NextResponse.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } }, { status: 400 }),
  validationErrorResponse: (message: string) =>
    NextResponse.json({ error: { code: 'VALIDATION_ERROR', message } }, { status: 400 }),
  handleError: (error: unknown) =>
    NextResponse.json(
      { error: { message: error instanceof Error ? error.message : String(error) } },
      { status: 500 },
    ),
}));

import { POST } from './route';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/signals', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_1', email: 'a@b.c', authType: 'token' });
  ensureObservedCaseForSignal.mockResolvedValue(null);
});

describe('POST /api/signals', () => {
  it('returns 202 with the per-item ingest result on a valid batch', async () => {
    // Reverting the `{ status: 202 }` option on the NextResponse.json call in
    // route.ts would make this assertion on `res.status` fail.
    ingestSessionSignalBatch.mockResolvedValue({
      accepted: 1,
      duplicate: 0,
      rejected: 0,
      results: [{ index: 0, event_id: 'evt_1', status: 'accepted' }],
    });

    const res = await POST(
      makeReq({
        events: [
          {
            event_id: 'evt_1',
            schema_version: 1,
            event_type: 'session_start',
            agent_name: 'claude-code',
            repository: 'repo_1',
            branch: 'main',
            session_id: 'sess_1',
          },
        ],
      }),
    );

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(1);
    expect(ingestSessionSignalBatch).toHaveBeenCalledTimes(1);
  });

  it('threads the authenticated caller into ingestSessionSignalBatch as userId (issue #990)', async () => {
    // Reverting the `{ userId: auth.userId }` option passed to
    // `ingestSessionSignalBatch` in route.ts (e.g. calling it with just the
    // events array again) would make this assertion on the second call
    // argument fail.
    ingestSessionSignalBatch.mockResolvedValue({
      accepted: 1,
      duplicate: 0,
      rejected: 0,
      results: [{ index: 0, event_id: 'evt_1', status: 'accepted' }],
    });

    await POST(
      makeReq({
        events: [
          {
            event_id: 'evt_1', schema_version: 1, event_type: 'session_start',
            agent_name: 'claude-code', repository: 'repo_1', branch: 'main', session_id: 'sess_1',
          },
        ],
      }),
    );

    expect(ingestSessionSignalBatch).toHaveBeenCalledWith(expect.any(Array), { userId: 'usr_1' });
  });

  it('rejects a request whose body has no events array before calling the service', async () => {
    // Reverting the `sessionSignalBatchSchema.safeParse` guard in route.ts
    // (calling the service unconditionally) would make
    // `ingestSessionSignalBatch` get called here, failing this assertion.
    const res = await POST(makeReq({ not_events: [] }));

    expect(res.status).toBe(400);
    expect(ingestSessionSignalBatch).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    // Reverting the `await authenticate(request)` call in route.ts would let
    // this request through without ever rejecting, failing this assertion.
    authenticate.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));

    const res = await POST(
      makeReq({
        events: [
          {
            event_id: 'evt_1',
            schema_version: 1,
            event_type: 'session_start',
            agent_name: 'claude-code',
            repository: 'repo_1',
            branch: 'main',
            session_id: 'sess_1',
          },
        ],
      }),
    );

    expect(res.status).toBe(500); // handleError's generic mapping in this test double
    expect(ingestSessionSignalBatch).not.toHaveBeenCalled();
  });

  it('triggers Observed Case resolution once per distinct branch among accepted events, after the 202 is decided', async () => {
    // Reverting the `outcome.status !== 'accepted'` skip in route.ts would
    // call `ensureObservedCaseForSignal` for the duplicate event too, failing
    // the call-count assertion below.
    ingestSessionSignalBatch.mockResolvedValue({
      accepted: 2,
      duplicate: 1,
      rejected: 0,
      results: [
        { index: 0, event_id: 'evt_1', status: 'accepted' },
        { index: 1, event_id: 'evt_1', status: 'duplicate' },
        { index: 2, event_id: 'evt_2', status: 'accepted' },
      ],
    });

    const res = await POST(
      makeReq({
        events: [
          {
            event_id: 'evt_1', schema_version: 1, event_type: 'session_start',
            agent_name: 'claude-code', repository: 'repo_1', branch: 'feat/foo', session_id: 'sess_1',
          },
          {
            event_id: 'evt_1', schema_version: 1, event_type: 'session_start',
            agent_name: 'claude-code', repository: 'repo_1', branch: 'feat/foo', session_id: 'sess_1',
          },
          {
            event_id: 'evt_2', schema_version: 1, event_type: 'heartbeat',
            agent_name: 'claude-code', repository: 'repo_1', branch: 'feat/foo', session_id: 'sess_1',
          },
        ],
      }),
    );

    expect(res.status).toBe(202);
    // Two accepted events, same (repository, branch) — one resolution call.
    expect(ensureObservedCaseForSignal).toHaveBeenCalledTimes(1);
    expect(ensureObservedCaseForSignal).toHaveBeenCalledWith({ repository: 'repo_1', branch: 'feat/foo' });
  });

  it('never awaits Observed Case resolution before responding', async () => {
    // Reverting the fire-and-forget call (awaiting `ensureObservedCaseForSignal`
    // before `NextResponse.json`) would make the 202 wait on this never-resolving
    // promise and the test would time out instead of completing.
    ingestSessionSignalBatch.mockResolvedValue({
      accepted: 1,
      duplicate: 0,
      rejected: 0,
      results: [{ index: 0, event_id: 'evt_1', status: 'accepted' }],
    });
    ensureObservedCaseForSignal.mockReturnValue(new Promise(() => {})); // never resolves

    const res = await POST(
      makeReq({
        events: [
          {
            event_id: 'evt_1', schema_version: 1, event_type: 'session_start',
            agent_name: 'claude-code', repository: 'repo_1', branch: 'feat/foo', session_id: 'sess_1',
          },
        ],
      }),
    );

    expect(res.status).toBe(202);
  });
});
