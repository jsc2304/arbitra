/**
 * `POST /api/cases/:caseId/events` used to accept
 * a free-form `type`, letting any case member forge lifecycle-significant
 * events (e.g. `case_approved`) into the audit trail. These tests pin the
 * resulting allowlist: `pr_merged` (the existing manual "mark PR as merged"
 * fallback) is the sole client-emittable type; everything else — including
 * unknown/custom strings — is rejected with 403.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { emit, getHistory, onRunCompleted } = vi.hoisted(() => ({
  emit: vi.fn(),
  getHistory: vi.fn(),
  onRunCompleted: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  EventService: class {
    emit = emit;
    getHistory = getHistory;
  },
  FirestorePipelineAdapter: class {},
  RunCompletionHandler: class {
    onRunCompleted = onRunCompleted;
  },
}));

const { authenticate, requireCaseAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireCaseAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    requireCaseAccess,
    handleError: (err: unknown) => {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status });
    },
  };
});

import { POST } from './route';

function postReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/cases/case_1/events', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireCaseAccess.mockResolvedValue(null);
  onRunCompleted.mockResolvedValue(undefined);
  emit.mockResolvedValue({
    event_id: 'evt_1',
    case_id: 'case_1',
    type: 'pr_merged',
    actor_id: 'user_1',
    payload: {},
    created_at: '2026-07-22T00:00:00.000Z',
  });
});

describe('POST /api/cases/:caseId/events — event-type allowlist', () => {
  it('rejects a forged lifecycle event (case_approved) with 403', async () => {
    const res = await POST(postReq({ type: 'case_approved' }), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(403);
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    'case_approved',
    'human_decision_recorded',
    'gate_confirmed',
    'decision_created',
    'run_created',
    'case_completed',
    'case_rejected',
    'knowledge_asset_created',
  ])('rejects server-only type "%s" with 403', async (type) => {
    const res = await POST(postReq({ type }), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(403);
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized/custom type with 403 (fail closed)', async () => {
    const res = await POST(postReq({ type: 'totally_made_up_event' }), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(403);
    expect(emit).not.toHaveBeenCalled();
  });

  it('returns 400 (not 403) when type is missing entirely', async () => {
    const res = await POST(postReq({ payload: {} }), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(400);
    expect(emit).not.toHaveBeenCalled();
  });

  it('allows the pr_merged manual-mark-merged fallback', async () => {
    const res = await POST(
      postReq({ type: 'pr_merged', payload: { source: 'manual' } }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );
    expect(res.status).toBe(201);
    expect(emit).toHaveBeenCalledWith('case_1', 'pr_merged', { source: 'manual' }, 'user_1');
  });
});
