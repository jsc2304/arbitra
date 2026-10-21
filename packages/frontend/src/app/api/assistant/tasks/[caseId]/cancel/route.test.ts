import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { cancel } = vi.hoisted(() => ({ cancel: vi.fn() }));

vi.mock('@arbitra/backend', () => ({
  AssistantCancellationService: class {
    cancel = cancel;
  },
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T =>
    schema.parse(body),
}));

const { authenticate, requireCaseAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireCaseAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', () => ({
  authenticate,
  requireCaseAccess,
  handleError: (error: unknown) => {
    const validation = error instanceof Error && 'issues' in error;
    const status = validation ? 400 : (error as { statusCode?: number })?.statusCode ?? 500;
    const code = validation
      ? 'VALIDATION_ERROR'
      : (error as { code?: string })?.code ?? 'INTERNAL_ERROR';
    const message = validation
      ? 'Invalid request payload'
      : error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: { code, message } }, { status });
  },
}));

import { POST } from './route';

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/assistant/tasks/case_1/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const routeContext = { params: Promise.resolve({ caseId: 'case_1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireCaseAccess.mockResolvedValue(null);
  cancel.mockResolvedValue({
    case: {
      case_id: 'case_1',
      status: 'rejected',
      assistant_cancel_intent: {
        revision: 3,
        requested_at: '2026-08-05T09:00:00.000Z',
        requested_by: 'user_1',
      },
    },
    target_run_id: 'run_2',
    revision: 3,
    run_ids: ['run_1', 'run_2'],
    pending_reconciliation_run_ids: ['run_1'],
    replayed: false,
  });
});

describe('POST /api/assistant/tasks/:caseId/cancel', () => {
  it('authenticates before resolving case access or cancelling', async () => {
    authenticate.mockRejectedValueOnce(Object.assign(new Error('Authentication required'), {
      code: 'UNAUTHORIZED',
      statusCode: 401,
    }));

    const response = await POST(request({ run_id: 'run_2' }), routeContext);

    expect(response.status).toBe(401);
    expect(requireCaseAccess).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('returns the access denial before parsing or cancelling', async () => {
    requireCaseAccess.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const response = await POST(request({ run_id: 'run_2' }), routeContext);

    expect(response.status).toBe(404);
    expect(requireCaseAccess).toHaveBeenCalledWith('case_1', 'user_1');
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([
    ['missing run_id', {}],
    ['empty run_id', { run_id: '' }],
    ['unknown fields', { run_id: 'run_2', case_id: 'case_forged' }],
  ])('rejects a strict body with %s', async (_label, body) => {
    const response = await POST(request(body), routeContext);

    expect(response.status).toBe(400);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('preserves a stale-attempt conflict as 409', async () => {
    cancel.mockRejectedValueOnce(Object.assign(
      new Error('The selected Clerk attempt is no longer active.'),
      {
        code: 'ASSISTANT_CANCELLATION_CONFLICT',
        statusCode: 409,
      },
    ));

    const response = await POST(request({ run_id: 'run_stale' }), routeContext);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe('ASSISTANT_CANCELLATION_CONFLICT');
    expect(cancel).toHaveBeenCalledWith('case_1', 'user_1', 'run_stale');
  });

  it('cancels the exact named run and returns the stable cancellation receipt', async () => {
    const response = await POST(request({ run_id: 'run_2' }), routeContext);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(requireCaseAccess).toHaveBeenCalledWith('case_1', 'user_1');
    expect(cancel).toHaveBeenCalledWith('case_1', 'user_1', 'run_2');
    expect(body).toEqual({
      case_id: 'case_1',
      target_run_id: 'run_2',
      cancelled_run_ids: ['run_1', 'run_2'],
      pending_reconciliation_run_ids: ['run_1'],
      status: 'rejected',
      cancel_revision: 3,
      requested_at: '2026-08-05T09:00:00.000Z',
      requested_by: 'user_1',
      replayed: false,
    });
  });
});
