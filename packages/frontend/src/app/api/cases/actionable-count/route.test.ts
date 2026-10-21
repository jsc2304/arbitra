import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Hoisted mocks — wired before importing the route.
// ---------------------------------------------------------------------------

const {
  countByStatus,
  checkIsAdmin,
  getAccessibleProjectIds,
} = vi.hoisted(() => ({
  countByStatus: vi.fn(),
  checkIsAdmin: vi.fn(),
  getAccessibleProjectIds: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  CaseService: class {
    countByStatus = countByStatus;
  },
  checkIsAdmin,
  getAccessibleProjectIds,
}));

const { authenticate } = vi.hoisted(() => ({
  authenticate: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    handleError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'error';
      const status = err instanceof Error && 'status' in err ? (err as Error & { status: number }).status : 500;
      return NextResponse.json({ error: { message } }, { status });
    },
  };
});

import { GET } from './route';

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/cases/actionable-count', {
    method: 'GET',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  checkIsAdmin.mockResolvedValue(false);
  getAccessibleProjectIds.mockResolvedValue(['proj_a', 'proj_b']);
  countByStatus.mockResolvedValue(7);
});

describe('GET /api/cases/actionable-count', () => {
  it('returns the count from CaseService.countByStatus', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ count: 7 });
  });

  it('filters by the same statuses the launcher badge uses', async () => {
    await GET(makeReq());
    expect(countByStatus).toHaveBeenCalledOnce();
    const [statuses] = countByStatus.mock.calls[0]!;
    expect(statuses).toEqual(['needs_human_decision', 'verification_pending']);
  });

  it('scopes non-admin users to their accessible project IDs', async () => {
    checkIsAdmin.mockResolvedValue(false);
    getAccessibleProjectIds.mockResolvedValue(['proj_a', 'proj_b']);

    await GET(makeReq());

    const [, projectScope] = countByStatus.mock.calls[0]!;
    expect(projectScope).toEqual(['proj_a', 'proj_b']);
  });

  it('passes `undefined` project scope for admins (global count)', async () => {
    checkIsAdmin.mockResolvedValue(true);

    await GET(makeReq());

    const [, projectScope] = countByStatus.mock.calls[0]!;
    expect(projectScope).toBeUndefined();
    // Admins should not trigger the accessible-projects lookup at all.
    expect(getAccessibleProjectIds).not.toHaveBeenCalled();
  });

  it('passes `undefined` when getAccessibleProjectIds returns "all"', async () => {
    checkIsAdmin.mockResolvedValue(false);
    getAccessibleProjectIds.mockResolvedValue('all');

    await GET(makeReq());

    const [, projectScope] = countByStatus.mock.calls[0]!;
    expect(projectScope).toBeUndefined();
  });

  it('propagates authentication errors without calling CaseService', async () => {
    const authError = Object.assign(new Error('unauthorized'), { status: 401 });
    authenticate.mockRejectedValue(authError);

    const res = await GET(makeReq());

    expect(res.status).toBe(401);
    expect(countByStatus).not.toHaveBeenCalled();
  });
});
