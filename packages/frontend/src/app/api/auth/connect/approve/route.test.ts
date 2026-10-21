/**
 * Tests for `/api/auth/connect/approve`.
 *
 * Covers the spec §I.1 matrix: non-member project rejection (403),
 * double-approve idempotency, and the cancelled-then-approve 409 path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  deviceCodesQueryGet,
  deviceCodesUpdate,
  projectsDocGet,
  isEffectiveMemberMock,
  authenticate,
  runTransaction,
} = vi.hoisted(() => ({
  deviceCodesQueryGet: vi.fn(),
  deviceCodesUpdate: vi.fn(),
  projectsDocGet: vi.fn(),
  isEffectiveMemberMock: vi.fn(),
  authenticate: vi.fn(),
  runTransaction: vi.fn(),
}));

vi.mock('@arbitra/backend', () => {
  const queryChain = () => {
    const obj: Record<string, unknown> = {
      where: () => obj,
      limit: () => obj,
      get: deviceCodesQueryGet,
    };
    return obj;
  };
  return {
    collections: {
      deviceCodes: () => queryChain(),
      projects: () => ({ doc: () => ({ get: projectsDocGet }) }),
    },
    isEffectiveMember: isEffectiveMemberMock,
    getDb: () => ({
      runTransaction: (cb: (tx: unknown) => Promise<unknown>) => runTransaction(cb),
    }),
    formatError: (error: unknown) => ({
      status: 500,
      body: { error: { message: error instanceof Error ? error.message : 'error' } },
    }),
  };
});

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

import { POST } from './route';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/auth/connect/approve', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Tracks the most recently constructed pending snap so the default
 * `runTransaction` stub can re-read the same data inside the transaction
 * callback. Tests that need a different in-transaction status (e.g. the
 * concurrent-race test) override `runTransaction` directly with
 * `mockImplementationOnce`.
 */
let latestSnapData: Record<string, unknown> = { status: 'pending' };

function pendingSnap(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    user_code: 'WDJB-MJHT',
    status: 'pending',
    client_name: 'cursor',
    device_label: 'Alexs-MacBook',
    poll_interval_seconds: 5,
    slow_down_strikes: 0,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
  latestSnapData = data;
  return {
    empty: false,
    docs: [{
      ref: { update: deviceCodesUpdate },
      data: () => data,
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  latestSnapData = { status: 'pending' };
  authenticate.mockResolvedValue({ userId: 'user_1', email: 'u@x' });
  projectsDocGet.mockResolvedValue({
    exists: true,
    data: () => ({
      project_id: 'proj_99',
      name: 'arbitra-app',
      members: ['user_1'],
      reviewer_pool: [],
      tech_leads: [],
    }),
  });
  isEffectiveMemberMock.mockReturnValue(true);
  deviceCodesUpdate.mockResolvedValue(undefined);

  // Default transaction stub: re-reads the snapshot the test queued via
  // `pendingSnap(...)`, treats it as still-pending, and routes writes
  // through deviceCodesUpdate so existing assertions on
  // `deviceCodesUpdate.toHaveBeenCalledWith(...)` keep working.
  runTransaction.mockImplementation(async (cb) => {
    const tx = {
      get: async () => ({ exists: true, data: () => latestSnapData }),
      update: (_ref: unknown, payload: Record<string, unknown>) => {
        deviceCodesUpdate(payload);
      },
    };
    return cb(tx);
  });
});

describe('POST /api/auth/connect/approve — happy path', () => {
  it('flips the doc to approved and stores user/project/device_label', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce(pendingSnap());
    const res = await POST(makeRequest({ user_code: 'WDJB-MJHT', project_id: 'proj_99', device_label: 'Edited-Label' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.approved).toBe(true);
    expect(json.project_name).toBe('arbitra-app');
    expect(deviceCodesUpdate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'approved',
      user_id: 'user_1',
      project_id: 'proj_99',
      device_label: 'Edited-Label',
    }));
  });
});

describe('POST /api/auth/connect/approve — access control', () => {
  it('returns 403 when the user is not an effective member of the project', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce(pendingSnap());
    isEffectiveMemberMock.mockReturnValueOnce(false);
    const res = await POST(makeRequest({ user_code: 'WDJB-MJHT', project_id: 'proj_99' }));
    expect(res.status).toBe(403);
    expect(deviceCodesUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 when the project does not exist', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce(pendingSnap());
    projectsDocGet.mockResolvedValueOnce({ exists: false });
    const res = await POST(makeRequest({ user_code: 'WDJB-MJHT', project_id: 'proj_missing' }));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/auth/connect/approve — idempotency and conflicts', () => {
  it('is idempotent when the same user re-approves the same code for the same project', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce(pendingSnap({
      status: 'approved',
      user_id: 'user_1',
      project_id: 'proj_99',
    }));
    const res = await POST(makeRequest({ user_code: 'WDJB-MJHT', project_id: 'proj_99' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.approved).toBe(true);
    // No second update — the doc is already approved for this caller.
    expect(deviceCodesUpdate).not.toHaveBeenCalled();
  });

  it('returns 409 when approving a code that was already cancelled', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce(pendingSnap({ status: 'denied' }));
    const res = await POST(makeRequest({ user_code: 'WDJB-MJHT', project_id: 'proj_99' }));
    expect(res.status).toBe(409);
    expect(deviceCodesUpdate).not.toHaveBeenCalled();
  });

  it('returns 409 when approving an already-consumed code', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce(pendingSnap({ status: 'consumed' }));
    const res = await POST(makeRequest({ user_code: 'WDJB-MJHT', project_id: 'proj_99' }));
    expect(res.status).toBe(409);
  });

  it('returns 400 when the code has expired', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce(pendingSnap({
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }));
    const res = await POST(makeRequest({ user_code: 'WDJB-MJHT', project_id: 'proj_99' }));
    expect(res.status).toBe(400);
    expect(deviceCodesUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 when the user_code is unknown', async () => {
    deviceCodesQueryGet.mockResolvedValueOnce({ empty: true, docs: [] });
    const res = await POST(makeRequest({ user_code: 'XXXX-XXXX', project_id: 'proj_99' }));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/auth/connect/approve — validation', () => {
  it('rejects missing user_code', async () => {
    const res = await POST(makeRequest({ project_id: 'proj_99' }));
    expect(res.status).toBe(400);
  });

  it('rejects missing project_id', async () => {
    const res = await POST(makeRequest({ user_code: 'WDJB-MJHT' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/connect/approve — concurrent race serialized via transaction (review-finding #3)', () => {
  // Regression: previously approve did `read → check pending → update`
  // outside any transaction. Two browsers both saw `pending` and last-write
  // wins on `user_id` / `project_id`. The transactional version makes the
  // second writer observe `status !== 'pending'` and return 409.
  it('exactly one of two concurrent approve calls succeeds; the other returns 409', async () => {
    // Both browser calls hit the same pending doc. We simulate the race by
    // letting the transaction-stub mutate `latestSnapData` mid-test: after
    // the first transaction commits, subsequent reads see `status:approved`.
    //
    // This drives the deterministic, observable side of the race: the SECOND
    // POST must re-read the doc inside its transaction (the whole point of
    // the fix) and bail with 409 — proving the route can no longer last-
    // write-wins past a stale pre-transaction snapshot.
    deviceCodesQueryGet.mockImplementation(async () => pendingSnap({ status: latestSnapData.status ?? 'pending' }));

    let authCount = 0;
    authenticate.mockImplementation(async () => {
      authCount += 1;
      return authCount === 1
        ? { userId: 'user_a', email: 'a@x' }
        : { userId: 'user_b', email: 'b@x' };
    });

    runTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async () => ({
          exists: true,
          // Each tx re-read sees the LATEST shared state, mirroring real
          // Firestore semantics where the second tx will observe the
          // first's commit.
          data: () => ({ ...latestSnapData }),
        }),
        update: (_ref: unknown, payload: Record<string, unknown>) => {
          // Commit: mutate the shared snap state so the next reader sees it.
          Object.assign(latestSnapData, payload);
          deviceCodesUpdate(payload);
        },
      };
      return cb(tx);
    });

    // Run sequentially — the goal is to prove a SECOND approve after a
    // committed first observes `status='approved'` inside the transaction
    // and returns 409. Promise.all isn't meaningful with mocks (all I/O is
    // synchronous-ish) and the spec only requires that the race is
    // serialized correctly, not that the runtime is parallel.
    const resA = await POST(makeRequest({ user_code: 'WDJB-MJHT', project_id: 'proj_99' }));
    const resB = await POST(makeRequest({ user_code: 'WDJB-MJHT', project_id: 'proj_99' }));

    // Exactly one succeeds, the other returns 409 — confirming the
    // read-check-write is properly serialized via the Firestore transaction.
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(409);

    // The successful writer is `user_a` (first transaction). The doc's
    // final user_id matches the 200-returning call, not the loser.
    expect(deviceCodesUpdate).toHaveBeenCalledTimes(1);
    expect(deviceCodesUpdate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'approved',
      user_id: 'user_a',
      project_id: 'proj_99',
    }));
  });

  it('catches the interleaved race where both reads see pending but the tx re-read sees approved', async () => {
    // Tighter test: both POSTs make their outer query before either commits
    // (both see `pending`). Only inside the transaction does the second
    // writer observe `approved` — exactly the scenario the pre-fix code
    // could not handle because there was no re-read at all.
    deviceCodesQueryGet.mockResolvedValue(pendingSnap()); // both outer reads see pending

    authenticate
      .mockResolvedValueOnce({ userId: 'user_a', email: 'a@x' })
      .mockResolvedValueOnce({ userId: 'user_b', email: 'b@x' });

    let txCount = 0;
    runTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      txCount += 1;
      const observedStatus = txCount === 1 ? 'pending' : 'approved';
      const tx = {
        get: async () => ({
          exists: true,
          data: () => ({ ...latestSnapData, status: observedStatus, user_id: txCount === 1 ? undefined : 'user_a' }),
        }),
        update: (_ref: unknown, payload: Record<string, unknown>) => {
          deviceCodesUpdate(payload);
        },
      };
      return cb(tx);
    });

    const resA = await POST(makeRequest({ user_code: 'WDJB-MJHT', project_id: 'proj_99' }));
    const resB = await POST(makeRequest({ user_code: 'WDJB-MJHT', project_id: 'proj_99' }));

    expect(resA.status).toBe(200);
    // The tx re-read shows approved → route throws TX_ALREADY_CONSUMED → 409.
    expect(resB.status).toBe(409);
    expect(txCount).toBe(2); // both POSTs reached the transaction
    expect(deviceCodesUpdate).toHaveBeenCalledTimes(1); // only the first writes
  });
});
