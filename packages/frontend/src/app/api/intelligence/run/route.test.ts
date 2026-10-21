import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { IntelligenceServiceMock, runMock, LockHeldErrorMock, verifyIdTokenMock } = vi.hoisted(() => {
  const runMock = vi.fn();
  class IntelligenceServiceMock {
    run = runMock;
  }
  class LockHeldErrorMock extends Error {
    readonly code = 'LOCK_HELD';
    constructor(message = 'intelligence_run_in_progress') {
      super(message);
      this.name = 'IntelligenceLockHeldError';
    }
  }
  const verifyIdTokenMock = vi.fn();
  return { IntelligenceServiceMock, runMock, LockHeldErrorMock, verifyIdTokenMock };
});

vi.mock('@arbitra/backend', () => ({
  IntelligenceService: IntelligenceServiceMock,
  ALL_DETECTORS: [],
  IntelligenceLockHeldError: LockHeldErrorMock,
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

const SCHEDULER_SA = 'arbitra-scheduler@demo-arbitra.iam.gserviceaccount.com';
const AUDIENCE = 'https://arbitra.example.com/api/intelligence/run';

function makeReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/intelligence/run', {
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

describe('POST /api/intelligence/run — OIDC auth', () => {
  function oidcHeaders(token = 'valid.token.here') {
    return { authorization: `Bearer ${token}` };
  }

  it('accepts a valid OIDC token and runs', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: AUDIENCE, email: SCHEDULER_SA, email_verified: true }),
    });
    runMock.mockResolvedValueOnce([]);
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(200);
    expect(runMock).toHaveBeenCalledTimes(1);
    // The verifier now passes an array of allowed audiences (multi-audience
    // support — see scheduler-auth.ts). With only the singular env var set
    // the array contains exactly one entry.
    expect(verifyIdTokenMock).toHaveBeenCalledWith({ idToken: 'valid.token.here', audience: [AUDIENCE] });
  });

  it('rejects a request without an Authorization header', async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('rejects a token with the wrong audience', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: 'https://evil.example.com/', email: SCHEDULER_SA, email_verified: true }),
    });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('rejects a token with the wrong service-account email', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: AUDIENCE, email: 'someone-else@example.com', email_verified: true }),
    });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed Bearer header', async () => {
    const res = await POST(makeReq({ authorization: 'NotBearer foo' }));
    expect(res.status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it('rejects when token verification throws', async () => {
    verifyIdTokenMock.mockRejectedValueOnce(new Error('bad signature'));
    const res = await POST(makeReq(oidcHeaders('garbage')));
    expect(res.status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('rejects when email_verified is false', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: AUDIENCE, email: SCHEDULER_SA, email_verified: false }),
    });
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('returns 500 when OIDC env vars are unset, even with a syntactically valid token', async () => {
    delete process.env['SCHEDULER_SA_EMAIL'];
    delete process.env['SCHEDULER_OIDC_AUDIENCE'];
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('SERVER_MISCONFIGURED');
    expect(runMock).not.toHaveBeenCalled();
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/intelligence/run — route behavior', () => {
  function oidcHeaders() {
    return { authorization: 'Bearer valid.token.here' };
  }

  function mockValidOidc() {
    verifyIdTokenMock.mockResolvedValueOnce({
      getPayload: () => ({ aud: AUDIENCE, email: SCHEDULER_SA, email_verified: true }),
    });
  }

  it('returns 409 with `intelligence_run_in_progress` when the lock is held', async () => {
    mockValidOidc();
    runMock.mockRejectedValueOnce(new LockHeldErrorMock());
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: 'intelligence_run_in_progress' });
  });

  it('invokes IntelligenceService.run and returns per-detector summaries', async () => {
    mockValidOidc();
    runMock.mockResolvedValueOnce([
      { detector: 'aging-pending-merge', cases_created: 2, cases_skipped_existing: 1, duration_ms: 10 },
      { detector: 'stale-open', cases_created: 0, cases_skipped_existing: 0, duration_ms: 3, error: 'boom' },
    ]);
    const res = await POST(makeReq(oidcHeaders()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.summaries).toHaveLength(2);
    expect(body.total).toEqual({ cases_created: 2, cases_skipped_existing: 1, errors: 1 });
    expect(runMock).toHaveBeenCalledTimes(1);
  });
});
