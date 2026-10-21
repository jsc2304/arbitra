import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { requireRole, republishCommitStatus } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  republishCommitStatus: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  requireRole,
  republishCommitStatus,
}));

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    handleError: (err: unknown) => {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status });
    },
    invalidJsonResponse: (message = 'Request body must be valid JSON') =>
      NextResponse.json({ error: { code: 'INVALID_JSON', message } }, { status: 400 }),
    validationErrorResponse: (message: string) =>
      NextResponse.json({ error: { code: 'VALIDATION_ERROR', message } }, { status: 400 }),
  };
});

import { POST } from './route';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/commit-status/republish', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/commit-status/republish', () => {
  it('401 when unauthenticated', async () => {
    authenticate.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 401 }));
    const res = await POST(makeReq({ pr_url: 'https://github.com/acme/demo/pull/1' }));
    expect(res.status).toBe(401);
    expect(republishCommitStatus).not.toHaveBeenCalled();
  });

  it('403 when not admin', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_1' });
    requireRole.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { statusCode: 403 }));
    const res = await POST(makeReq({ pr_url: 'https://github.com/acme/demo/pull/1' }));
    expect(res.status).toBe(403);
    expect(republishCommitStatus).not.toHaveBeenCalled();
  });

  it('400 on an invalid body', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    const res = await POST(makeReq({ foo: 'bar' }));
    expect(res.status).toBe(400);
    expect(republishCommitStatus).not.toHaveBeenCalled();
  });

  it('accepts { pr_url } and forwards it, stamping the caller as actor', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    republishCommitStatus.mockResolvedValueOnce({
      ok: true,
      prUrl: 'https://github.com/acme/demo/pull/1',
      caseId: 'case_1',
      state: 'success',
      auditEventId: 'event_1',
    });

    const res = await POST(makeReq({ pr_url: 'https://github.com/acme/demo/pull/1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      pr_url: 'https://github.com/acme/demo/pull/1',
      case_id: 'case_1',
      state: 'success',
      audit_event_id: 'event_1',
    });
    expect(republishCommitStatus).toHaveBeenCalledWith(
      { prUrl: 'https://github.com/acme/demo/pull/1' },
      'usr_admin',
    );
  });

  it('accepts { owner, repo, pr_number } and forwards it', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    republishCommitStatus.mockResolvedValueOnce({
      ok: true,
      prUrl: 'https://github.com/acme/demo/pull/9',
      caseId: null,
      state: 'success',
      auditEventId: 'wsevent_1',
    });

    const res = await POST(makeReq({ owner: 'acme', repo: 'demo', pr_number: 9 }));
    expect(res.status).toBe(200);
    expect(republishCommitStatus).toHaveBeenCalledWith(
      { owner: 'acme', repo: 'demo', prNumber: 9 },
      'usr_admin',
    );
  });

  it('422 when the underlying re-publish fails', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    republishCommitStatus.mockResolvedValueOnce({
      ok: false,
      reason: 'no_head_sha',
      prUrl: 'https://github.com/acme/demo/pull/1',
    });

    const res = await POST(makeReq({ pr_url: 'https://github.com/acme/demo/pull/1' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.message).toBe('no_head_sha');
  });
});
