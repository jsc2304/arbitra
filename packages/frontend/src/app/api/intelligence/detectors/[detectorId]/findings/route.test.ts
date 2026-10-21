import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Firestore query-chain stub
// ---------------------------------------------------------------------------
//
// The route builds a single query chain:
//   db.collection(...).where(...).where(...).orderBy(...).orderBy(...).limit(...).get()
//
// We capture the arguments passed at each step so the test can assert on the
// prefix range without a real Firestore connection.

const { captured, getMock } = vi.hoisted(() => {
  const captured = {
    collection: '' as string,
    whereCalls: [] as Array<[string, string, unknown]>,
    orderByCalls: [] as Array<[string, string]>,
    limit: 0 as number,
  };
  const getMock = vi.fn();
  return { captured, getMock };
});

function makeChain() {
  const chain: {
    where: (f: string, op: string, v: unknown) => typeof chain;
    orderBy: (f: string, dir: string) => typeof chain;
    limit: (n: number) => typeof chain;
    get: () => unknown;
  } = {
    where(f, op, v) {
      captured.whereCalls.push([f, op, v]);
      return chain;
    },
    orderBy(f, dir) {
      captured.orderByCalls.push([f, dir]);
      return chain;
    },
    limit(n) {
      captured.limit = n;
      return chain;
    },
    get: getMock,
  };
  return chain;
}

const {
  requireRole,
  CaseRepositoryMock,
} = vi.hoisted(() => {
  class CaseRepositoryMock {
    getDb() {
      return {
        collection: (name: string) => {
          // Access the module-level `captured` via closure is impossible from
          // inside `vi.hoisted`; we stamp it onto a global instead.
          (globalThis as unknown as { __captured: { collection: string } }).__captured.collection = name;
          return (globalThis as unknown as { __makeChain: () => unknown }).__makeChain();
        },
      };
    }
  }
  return { requireRole: vi.fn(), CaseRepositoryMock };
});

vi.mock('@arbitra/backend', () => ({
  requireRole,
  CaseRepository: CaseRepositoryMock,
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
  };
});

import { GET } from './route';

// Expose `captured` + `makeChain` to the hoisted mock (closure workaround).
(globalThis as unknown as { __captured: typeof captured }).__captured = captured;
(globalThis as unknown as { __makeChain: typeof makeChain }).__makeChain = makeChain;

function makeReq(path = '/api/intelligence/detectors/det-a/findings'): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method: 'GET' });
}

function resetCaptured() {
  captured.collection = '';
  captured.whereCalls.length = 0;
  captured.orderByCalls.length = 0;
  captured.limit = 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCaptured();
  getMock.mockReset();
});

describe('GET /api/intelligence/detectors/:detectorId/findings', () => {
  it('401 when unauthenticated', async () => {
    authenticate.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 401 }));
    const res = await GET(makeReq(), { params: Promise.resolve({ detectorId: 'det-a' }) });
    expect(res.status).toBe(401);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('403 when authenticated but not admin', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_1' });
    requireRole.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { statusCode: 403 }),
    );
    const res = await GET(makeReq(), { params: Promise.resolve({ detectorId: 'det-a' }) });
    expect(res.status).toBe(403);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('200 + builds a prefix range on intelligence_signature, ordered by updated_at DESC', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    getMock.mockResolvedValueOnce({
      docs: [
        {
          data: () => ({
            case_id: 'case_1',
            title: 'Aging case',
            status: 'pending_merge',
            risk_level: 'medium',
            intelligence_signature: 'det-a:case:case_1',
            created_at: '2026-04-20T00:00:00.000Z',
            updated_at: '2026-04-22T00:00:00.000Z',
          }),
        },
      ],
    });

    const res = await GET(makeReq(), { params: Promise.resolve({ detectorId: 'det-a' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({
      case_id: 'case_1',
      title: 'Aging case',
      intelligence_signature: 'det-a:case:case_1',
    });

    expect(captured.collection).toBe('cases');
    // Two where clauses: lower bound `>= "det-a:"`, upper bound `< "det-a:"`.
    expect(captured.whereCalls).toHaveLength(2);
    expect(captured.whereCalls[0]).toEqual(['intelligence_signature', '>=', 'det-a:']);
    expect(captured.whereCalls[1]?.[0]).toBe('intelligence_signature');
    expect(captured.whereCalls[1]?.[1]).toBe('<');
    const upper = captured.whereCalls[1]?.[2] as string;
    expect(upper.startsWith('det-a:')).toBe(true);
    expect(upper.charCodeAt(upper.length - 1)).toBe(0xf8ff);
    // Ordering: signature ASC (required because it's in a range filter) then updated_at DESC.
    expect(captured.orderByCalls).toEqual([
      ['intelligence_signature', 'asc'],
      ['updated_at', 'desc'],
    ]);
    expect(captured.limit).toBe(25);
  });

  it('handles empty result set', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    getMock.mockResolvedValueOnce({ docs: [] });

    const res = await GET(makeReq(), { params: Promise.resolve({ detectorId: 'det-b' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.findings).toEqual([]);
  });

  it('clamps limit to [1, 100]', async () => {
    authenticate.mockResolvedValueOnce({ userId: 'usr_admin' });
    requireRole.mockResolvedValueOnce(['admin']);
    getMock.mockResolvedValueOnce({ docs: [] });

    await GET(makeReq('/api/intelligence/detectors/det-a/findings?limit=9999'), {
      params: Promise.resolve({ detectorId: 'det-a' }),
    });
    expect(captured.limit).toBe(100);
  });
});
