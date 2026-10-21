import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { RunSweepServiceMock, sweepMock, verifyIdTokenMock } = vi.hoisted(() => {
  const sweepMock = vi.fn();
  class RunSweepServiceMock {
    sweep = sweepMock;
  }
  const verifyIdTokenMock = vi.fn();
  return { RunSweepServiceMock, sweepMock, verifyIdTokenMock };
});

vi.mock('@arbitra/backend', () => ({
  RunSweepService: RunSweepServiceMock,
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

import { POST } from './route';

const ORIGINAL_SA = process.env['SCHEDULER_SA_EMAIL'];
const ORIGINAL_AUD = process.env['SCHEDULER_OIDC_AUDIENCE'];

const SCHEDULER_SA = 'arbitra-run-sweeper@demo-arbitra.iam.gserviceaccount.com';
const AUDIENCE = 'https://arbitra.example.com/api/runs/sweep';

function makeReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/runs/sweep', {
    method: 'POST',
    headers,
  });
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

describe('POST /api/runs/sweep — OIDC auth', () => {
  function oidcHeaders(token = 'valid.token.here') {
    return { authorization: `Bearer ${token}` };
  }

  it('accepts a valid OIDC token and runs the sweep', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: AUDIENCE, email: SCHEDULER_SA, email_verified: true }),
    });
    sweepMock.mockResolvedValueOnce({ swept: [], skipped_completed: 0, retries_dispatched: [], skipped_locked: false });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(200);
    expect(sweepMock).toHaveBeenCalledTimes(1);
    expect(verifyIdTokenMock).toHaveBeenCalledWith({ idToken: 'valid.token.here', audience: [AUDIENCE] });
  });

  it('rejects a request without an Authorization header', async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('rejects a token with the wrong audience', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: 'https://evil.example.com/', email: SCHEDULER_SA, email_verified: true }),
    });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('rejects a token with the wrong service-account email', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: AUDIENCE, email: 'someone-else@example.com', email_verified: true }),
    });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed Bearer header', async () => {
    const res = await POST(makeReq({ authorization: 'NotBearer foo' }));
    expect(res.status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it('rejects when token verification throws', async () => {
    verifyIdTokenMock.mockRejectedValueOnce(new Error('bad signature'));
    const res = await POST(makeReq(oidcHeaders('garbage')));
    expect(res.status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('rejects when email_verified is false', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: AUDIENCE, email: SCHEDULER_SA, email_verified: false }),
    });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('returns 500 when OIDC env vars are unset, even with a syntactically valid token', async () => {
    delete process.env['SCHEDULER_SA_EMAIL'];
    delete process.env['SCHEDULER_OIDC_AUDIENCE'];
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('SERVER_MISCONFIGURED');
    expect(sweepMock).not.toHaveBeenCalled();
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/runs/sweep — route behavior', () => {
  function oidcHeaders() {
    return { authorization: 'Bearer valid.token.here' };
  }

  function mockValidOidc() {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: AUDIENCE, email: SCHEDULER_SA, email_verified: true }),
    });
  }

  it('returns the swept-run summary on success', async () => {
    mockValidOidc();
    sweepMock.mockResolvedValueOnce({
      swept: [{ run_id: 'run_1', case_id: 'case_1', run_type: 'review_run', reason: 'lease_expired' }],
      skipped_completed: 0,
      retries_dispatched: [],
      skipped_locked: false,
    });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.swept_count).toBe(1);
    expect(body.swept).toHaveLength(1);
    expect(body.skipped_locked).toBe(false);
  });

  it('surfaces skipped_completed and retries_dispatched (durable-retry backstop, CRITICAL/HIGH fix-up)', async () => {
    mockValidOidc();
    sweepMock.mockResolvedValueOnce({
      swept: [],
      skipped_completed: 2,
      retries_dispatched: [{ run_id: 'run_2', case_id: 'case_2', run_type: 'review_run' }],
      skipped_locked: false,
    });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped_completed).toBe(2);
    expect(body.retries_dispatched_count).toBe(1);
    expect(body.retries_dispatched).toHaveLength(1);
  });

  it('reports each assistant recovery counter from its matching result list', async () => {
    mockValidOidc();
    const repaired = { run_id: 'run_repaired', case_id: 'case_a', run_type: 'assistant_task_run', attempt: 1 };
    const outstanding = { run_id: 'run_outstanding', case_id: 'case_b', run_type: 'assistant_task_run', attempt: 2 };
    sweepMock.mockResolvedValueOnce({
      swept: [],
      skipped_completed: 0,
      retries_dispatched: [],
      skipped_locked: false,
      assistant: {
        claimed: [],
        reattempted: [],
        exhausted: [],
        failures_repaired: [repaired],
        failures_outstanding: [outstanding],
        cancellations_reconciled: [],
        cancellations_outstanding: [],
        skipped_claimed: 0,
        skipped_completed: 0,
        skipped_locked: false,
      },
    });

    const res = await POST(makeReq(oidcHeaders()));
    const body = await res.json();

    expect(body.assistant.failures_repaired_count).toBe(1);
    expect(body.assistant.failures_repaired).toEqual([repaired]);
    expect(body.assistant.failures_outstanding_count).toBe(1);
    expect(body.assistant.failures_outstanding).toEqual([outstanding]);
  });

  it('surfaces skipped_locked without treating it as an error', async () => {
    mockValidOidc();
    sweepMock.mockResolvedValueOnce({ swept: [], skipped_completed: 0, retries_dispatched: [], skipped_locked: true });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped_locked).toBe(true);
    expect(body.swept_count).toBe(0);
  });

  it('returns 500 when the sweep itself throws', async () => {
    mockValidOidc();
    sweepMock.mockRejectedValueOnce(new Error('firestore unavailable'));
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(500);
  });
});
