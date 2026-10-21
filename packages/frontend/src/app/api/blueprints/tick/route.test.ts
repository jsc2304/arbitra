import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { BlueprintTickServiceMock, tickMock, verifyIdTokenMock, dispatchMock } = vi.hoisted(() => {
  const tickMock = vi.fn();
  class BlueprintTickServiceMock {
    tick = tickMock;
  }
  const verifyIdTokenMock = vi.fn();
  const dispatchMock = vi.fn();
  return { BlueprintTickServiceMock, tickMock, verifyIdTokenMock, dispatchMock };
});

vi.mock('@arbitra/backend', () => ({
  BlueprintTickService: BlueprintTickServiceMock,
  formatError: (error: unknown) => ({
    status: 500,
    body: { error: { code: 'INTERNAL', message: (error as Error).message ?? 'err' } },
  }),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = verifyIdTokenMock;
  },
}));

vi.mock('@/lib/assistant-run-dispatch', () => ({ scheduleAssistantRunDispatch: dispatchMock }));

import { POST } from './route';

const ORIGINAL_SA = process.env['SCHEDULER_SA_EMAIL'];
const ORIGINAL_AUD = process.env['SCHEDULER_OIDC_AUDIENCE'];

const SCHEDULER_SA = 'arbitra-blueprint-tick@demo-arbitra.iam.gserviceaccount.com';
const AUDIENCE = 'https://arbitra.example.com/api/blueprints/tick';

function makeReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/blueprints/tick', {
    method: 'POST',
    headers,
  });
}

function emptySummary() {
  return { due: 0, created: 0, skipped_overlap: 0, replayed: 0, errors: [], dispatches: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env['SCHEDULER_SA_EMAIL'] = SCHEDULER_SA;
  process.env['SCHEDULER_OIDC_AUDIENCE'] = AUDIENCE;
});

afterEach(() => {
  if (ORIGINAL_SA === undefined) delete process.env['SCHEDULER_SA_EMAIL'];
  else process.env['SCHEDULER_SA_EMAIL'] = ORIGINAL_SA;
  if (ORIGINAL_AUD === undefined) delete process.env['SCHEDULER_OIDC_AUDIENCE'];
  else process.env['SCHEDULER_OIDC_AUDIENCE'] = ORIGINAL_AUD;
});

describe('POST /api/blueprints/tick — OIDC auth', () => {
  function oidcHeaders(token = 'valid.token.here') {
    return { authorization: `Bearer ${token}` };
  }

  function mockValidOidc() {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: AUDIENCE, email: SCHEDULER_SA, email_verified: true }),
    });
  }

  it('accepts a valid OIDC token and runs the tick', async () => {
    mockValidOidc();
    tickMock.mockResolvedValueOnce(emptySummary());
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(200);
    expect(tickMock).toHaveBeenCalledTimes(1);
    expect(verifyIdTokenMock).toHaveBeenCalledWith({ idToken: 'valid.token.here', audience: [AUDIENCE] });
  });

  /** Reverting the `!result.ok` branch (or the auth call itself) would let this reach `tickMock` and touch Firestore. */
  it('rejects a request without an Authorization header — 401, tick and Firestore never touched', async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(tickMock).not.toHaveBeenCalled();
  });

  it('rejects a token with the wrong audience', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: 'https://evil.example.com/', email: SCHEDULER_SA, email_verified: true }),
    });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(401);
    expect(tickMock).not.toHaveBeenCalled();
  });

  it('rejects a token with the wrong service-account email', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: AUDIENCE, email: 'someone-else@example.com', email_verified: true }),
    });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(401);
    expect(tickMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed Bearer header', async () => {
    const res = await POST(makeReq({ authorization: 'NotBearer foo' }));
    expect(res.status).toBe(401);
    expect(tickMock).not.toHaveBeenCalled();
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it('rejects when token verification throws', async () => {
    verifyIdTokenMock.mockRejectedValueOnce(new Error('bad signature'));
    const res = await POST(makeReq(oidcHeaders('garbage')));
    expect(res.status).toBe(401);
    expect(tickMock).not.toHaveBeenCalled();
  });

  it('rejects when email_verified is false', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: AUDIENCE, email: SCHEDULER_SA, email_verified: false }),
    });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(401);
    expect(tickMock).not.toHaveBeenCalled();
  });

  it('returns 500 when OIDC env vars are unset, even with a syntactically valid token', async () => {
    delete process.env['SCHEDULER_SA_EMAIL'];
    delete process.env['SCHEDULER_OIDC_AUDIENCE'];
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('SERVER_MISCONFIGURED');
    expect(tickMock).not.toHaveBeenCalled();
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/blueprints/tick — route behavior', () => {
  function oidcHeaders() {
    return { authorization: 'Bearer valid.token.here' };
  }

  function mockValidOidc() {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: AUDIENCE, email: SCHEDULER_SA, email_verified: true }),
    });
  }

  /** Reverting the `for (const dispatch of summary.dispatches)` loop to a no-op would still 200 but never call dispatch. */
  it('returns 200 for a normally-empty tick and never dispatches', async () => {
    mockValidOidc();
    tickMock.mockResolvedValueOnce(emptySummary());
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok', due: 0, created: 0, skipped_overlap: 0, replayed: 0, errors: [] });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('summarizes due/created/skipped_overlap/replayed/errors from the service', async () => {
    mockValidOidc();
    tickMock.mockResolvedValueOnce({
      due: 3,
      created: 1,
      skipped_overlap: 1,
      replayed: 1,
      errors: [{ blueprint_id: 'bp_broken', message: 'boom' }],
      dispatches: [],
    });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 'ok',
      due: 3,
      created: 1,
      skipped_overlap: 1,
      replayed: 1,
      errors: [{ blueprint_id: 'bp_broken', message: 'boom' }],
    });
    // The internal `dispatches` payload (raw Case/Run objects) never leaves this route's response body.
    expect(body.dispatches).toBeUndefined();
  });

  /** Reverting `scheduleAssistantRunDispatch(dispatch.case, dispatch.run)` to omit args would fail the `toHaveBeenCalledWith` check. */
  it('fire-and-forget dispatches every created occurrence, mirroring run-now', async () => {
    mockValidOidc();
    const case1 = { case_id: 'case_1' };
    const run1 = { run_id: 'run_1' };
    const case2 = { case_id: 'case_2' };
    const run2 = { run_id: 'run_2' };
    tickMock.mockResolvedValueOnce({
      due: 2,
      created: 2,
      skipped_overlap: 0,
      replayed: 0,
      errors: [],
      dispatches: [
        { case: case1, run: run1 },
        { case: case2, run: run2 },
      ],
    });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock).toHaveBeenNthCalledWith(1, case1, run1);
    expect(dispatchMock).toHaveBeenNthCalledWith(2, case2, run2);
  });

  it('returns 500 when the tick service itself throws', async () => {
    mockValidOidc();
    tickMock.mockRejectedValueOnce(new Error('firestore unavailable'));
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(500);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
