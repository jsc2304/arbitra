/**
 * Tests for `/api/auth/connect/token` — the device polling endpoint.
 *
 * Covers the matrix from `docs/specs/device-flow-and-per-tool-tokens.md` §I.1:
 * all five RFC 8628 §3.5 error states, slow-down strike accounting, the
 * 3-strike → access_denied promotion, idempotency on `consumed`, and the
 * transactional mint-and-flip path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { hashDeviceCode } from '../_helpers';

const {
  deviceCodeDocGet,
  deviceCodeDocUpdate,
  deviceCodeDocDelete,
  tokenDocSet,
  projectDocGet,
  runTransaction,
  generatePATMock,
} = vi.hoisted(() => ({
  deviceCodeDocGet: vi.fn(),
  deviceCodeDocUpdate: vi.fn(),
  deviceCodeDocDelete: vi.fn(),
  tokenDocSet: vi.fn(),
  projectDocGet: vi.fn(),
  runTransaction: vi.fn(),
  generatePATMock: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  collections: {
    deviceCodes: () => ({
      doc: () => ({
        get: deviceCodeDocGet,
        update: deviceCodeDocUpdate,
        delete: deviceCodeDocDelete,
      }),
    }),
    tokens: () => ({
      doc: () => ({ set: tokenDocSet }),
    }),
    projects: () => ({
      doc: () => ({ get: projectDocGet }),
    }),
  },
  getDb: () => ({
    runTransaction: (cb: (tx: unknown) => Promise<unknown>) => runTransaction(cb),
  }),
  generatePAT: generatePATMock,
  formatError: (error: unknown) => ({
    status: 500,
    body: { error: { message: error instanceof Error ? error.message : 'error' } },
  }),
}));

// Sentinel returned by our mocked FieldValue.increment — tests check the
// shape `{ __increment: <n> }` instead of comparing object identity.
// `getFirestore` is referenced transitively by some Next.js init paths; stub
// it as a no-op so the import resolves.
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    increment: (n: number) => ({ __increment: n }),
    delete: () => ({ __delete: true }),
    serverTimestamp: () => ({ __serverTimestamp: true }),
  },
  getFirestore: () => ({}),
  Timestamp: { now: () => ({ toMillis: () => Date.now() }) },
}));

import { POST } from './route';

const RAW_DEVICE_CODE = 'abc123-device-code-raw';
const HASHED_ID = hashDeviceCode(RAW_DEVICE_CODE);
void HASHED_ID; // consumed implicitly via the route's hash lookup

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/auth/connect/token', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function pendingDoc(overrides: Record<string, unknown> = {}) {
  return {
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
}

beforeEach(() => {
  vi.clearAllMocks();
  generatePATMock.mockReturnValue({ raw: 'arb_rawtoken', hash: 'hashhash', prefix: 'arb_rawt...oken' });
  projectDocGet.mockResolvedValue({ exists: true, data: () => ({ name: 'arbitra-app' }) });
  // The route does `ref.delete().catch(...)` — give the mock a Promise return.
  deviceCodeDocDelete.mockResolvedValue(undefined);
  deviceCodeDocUpdate.mockResolvedValue(undefined);
});

describe('POST /api/auth/connect/token — grant_type and lookup', () => {
  it('rejects missing grant_type', async () => {
    const res = await POST(makeRequest({ device_code: RAW_DEVICE_CODE }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('unsupported_grant_type');
  });

  it('returns invalid_grant for unknown device_code', async () => {
    deviceCodeDocGet.mockResolvedValueOnce({ exists: false });
    const res = await POST(makeRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: RAW_DEVICE_CODE }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_grant');
  });
});

describe('POST /api/auth/connect/token — RFC 8628 §3.5 states', () => {
  it('returns authorization_pending when status is pending', async () => {
    deviceCodeDocGet.mockResolvedValueOnce({ exists: true, data: () => pendingDoc() });
    const res = await POST(makeRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: RAW_DEVICE_CODE }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('authorization_pending');
    // Should bump last_polled_at so subsequent polls can be checked for slow_down.
    expect(deviceCodeDocUpdate).toHaveBeenCalledWith(expect.objectContaining({ last_polled_at: expect.any(String) }));
  });

  it('returns expired_token when expires_at < now', async () => {
    deviceCodeDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => pendingDoc({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    });
    const res = await POST(makeRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: RAW_DEVICE_CODE }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('expired_token');
    expect(deviceCodeDocDelete).toHaveBeenCalled();
  });

  it('returns access_denied when status is denied', async () => {
    deviceCodeDocGet.mockResolvedValueOnce({ exists: true, data: () => pendingDoc({ status: 'denied' }) });
    const res = await POST(makeRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: RAW_DEVICE_CODE }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('access_denied');
  });

  it('returns invalid_grant (idempotent) when status is consumed', async () => {
    deviceCodeDocGet.mockResolvedValueOnce({ exists: true, data: () => pendingDoc({ status: 'consumed' }) });
    const res = await POST(makeRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: RAW_DEVICE_CODE }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_grant');
    expect(deviceCodeDocUpdate).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/connect/token — slow-down enforcement', () => {
  it('returns slow_down and bumps interval when polled within interval', async () => {
    deviceCodeDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => pendingDoc({
        last_polled_at: new Date(Date.now() - 1000).toISOString(), // 1s ago, well below 5s
        poll_interval_seconds: 5,
        slow_down_strikes: 0,
      }),
    });
    const res = await POST(makeRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: RAW_DEVICE_CODE }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('slow_down');
    // Strikes are now applied via FieldValue.increment to avoid lost-update
    // under concurrent fast polls. Interval bump is also atomic.
    expect(deviceCodeDocUpdate).toHaveBeenCalledWith(expect.objectContaining({
      poll_interval_seconds: { __increment: 5 }, // SLOW_DOWN_INTERVAL_BUMP_SECONDS
      slow_down_strikes: { __increment: 1 },
    }));
  });

  it('promotes the doc to denied after 3 strikes', async () => {
    deviceCodeDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => pendingDoc({
        last_polled_at: new Date(Date.now() - 500).toISOString(),
        poll_interval_seconds: 10,
        slow_down_strikes: 2,
      }),
    });
    const res = await POST(makeRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: RAW_DEVICE_CODE }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('access_denied');
    expect(deviceCodeDocUpdate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'denied',
      slow_down_strikes: { __increment: 1 },
    }));
  });

  it('does not strike when polled at or after the configured interval', async () => {
    deviceCodeDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => pendingDoc({
        last_polled_at: new Date(Date.now() - 6000).toISOString(), // 6s ago > 5s interval
        poll_interval_seconds: 5,
        slow_down_strikes: 0,
      }),
    });
    const res = await POST(makeRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: RAW_DEVICE_CODE }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('authorization_pending');
    // last_polled_at bump only — no slow-down fields touched.
    const callArg = deviceCodeDocUpdate.mock.calls[0]![0];
    expect(callArg.slow_down_strikes).toBeUndefined();
  });
});

describe('POST /api/auth/connect/token — mint and flip on approved', () => {
  it('mints a PAT and returns the token bundle inside a transaction', async () => {
    deviceCodeDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => pendingDoc({
        status: 'approved',
        user_id: 'user_42',
        project_id: 'proj_99',
        client_name: 'cursor',
        client_version: '0.42.3',
        device_id: 'd_abc',
        device_label: 'Alexs-MacBook',
      }),
    });
    // The route runs `db.runTransaction(cb)` — invoke the callback with a
    // tx stub whose `get` returns the still-approved snapshot and whose
    // `set`/`update` record the writes.
    const txSet = vi.fn();
    const txUpdate = vi.fn();
    runTransaction.mockImplementationOnce(async (cb) => cb({
      get: async () => ({
        exists: true,
        data: () => pendingDoc({
          status: 'approved',
          user_id: 'user_42',
          project_id: 'proj_99',
          client_name: 'cursor',
          client_version: '0.42.3',
          device_id: 'd_abc',
          device_label: 'Alexs-MacBook',
        }),
      }),
      set: txSet,
      update: txUpdate,
    }));

    const res = await POST(makeRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: RAW_DEVICE_CODE }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token).toBe('arb_rawtoken');
    expect(json.token_type).toBe('Bearer');
    expect(json.project_id).toBe('proj_99');
    expect(json.project_name).toBe('arbitra-app');

    expect(runTransaction).toHaveBeenCalledOnce();
    // The transaction must perform both writes — a PAT row and the doc flip.
    expect(txSet).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledWith(expect.anything(), { status: 'consumed' });
    const writtenToken = txSet.mock.calls[0]![1];
    expect(writtenToken.client_name).toBe('cursor');
    expect(writtenToken.client_version).toBe('0.42.3');
    expect(writtenToken.device_id).toBe('d_abc');
    expect(writtenToken.device_label).toBe('Alexs-MacBook');
    expect(writtenToken.created_via).toBe('unified_connect');
    expect(writtenToken.name).toBe('cursor on Alexs-MacBook');
  });

  it('returns invalid_grant if the doc is consumed inside the transaction (racing poll)', async () => {
    deviceCodeDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => pendingDoc({
        status: 'approved',
        user_id: 'user_42',
        project_id: 'proj_99',
      }),
    });
    runTransaction.mockImplementationOnce(async (cb) => cb({
      // Re-read shows the racing poll already flipped to consumed.
      get: async () => ({
        exists: true,
        data: () => pendingDoc({ status: 'consumed', user_id: 'user_42', project_id: 'proj_99' }),
      }),
      set: vi.fn(),
      update: vi.fn(),
    }));

    const res = await POST(makeRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: RAW_DEVICE_CODE }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_grant');
  });
});

describe('POST /api/auth/connect/token — fast-poll on already-approved doc (review-finding #2)', () => {
  // Regression: previously the slow-down check ran before the `approved`
  // branch, so a client fast-polling an already-approved code would
  // accumulate strikes and get permanently denied — the legitimate device
  // never received its token.
  it('returns 200 + token on fast polls when the doc is already approved (no strikes)', async () => {
    const approvedData = () => pendingDoc({
      status: 'approved',
      user_id: 'user_42',
      project_id: 'proj_99',
      // Fast-poll signal: last poll was 500ms ago, well under the 5s interval.
      last_polled_at: new Date(Date.now() - 500).toISOString(),
      slow_down_strikes: 0,
    });

    for (let i = 0; i < 5; i++) {
      deviceCodeDocGet.mockResolvedValueOnce({ exists: true, data: approvedData });
      runTransaction.mockImplementationOnce(async (cb) => cb({
        get: async () => ({ exists: true, data: approvedData }),
        set: vi.fn(),
        update: vi.fn(),
      }));
      const res = await POST(makeRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: RAW_DEVICE_CODE }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.access_token).toBe('arb_rawtoken');
      expect(json.error).toBeUndefined();
    }

    // Critically: no strike updates were ever applied to the approved doc.
    // The only writes happen inside the mint-and-flip transaction.
    expect(deviceCodeDocUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/connect/token — concurrent slow-down strikes are transactional (review-finding #2)', () => {
  // Regression: the pre-fix code read `slow_down_strikes`, added 1 in JS,
  // and wrote the literal back. Three racing fast polls each see strikes=0
  // and write strikes=1 (lost update), so the device never crossed the
  // 3-strike denial threshold.
  //
  // The fix uses `FieldValue.increment(1)` — an atomic server-side counter.
  // We assert the write SHAPE: each call must send the increment sentinel
  // rather than a literal number. Firestore then sums them server-side and
  // the device denies on the 3rd strike regardless of read interleaving.
  it('every fast-poll update writes FieldValue.increment(1), not a literal strike count', async () => {
    const fastPollData = () => pendingDoc({
      status: 'pending',
      last_polled_at: new Date(Date.now() - 500).toISOString(),
      poll_interval_seconds: 5,
      slow_down_strikes: 0,
    });

    // Three sequential fast polls — concurrent invocation isn't observable
    // through the mock layer (mocks resolve synchronously), and the
    // important assertion is on the WRITE shape, not runtime interleaving.
    for (let i = 0; i < 3; i++) {
      deviceCodeDocGet.mockResolvedValueOnce({ exists: true, data: fastPollData });
      const res = await POST(makeRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: RAW_DEVICE_CODE }));
      const json = await res.json();
      expect(json.error).toBe('slow_down');
    }

    // Each call wrote an atomic increment of 1 — not a literal `1`. Firestore
    // would sum these to `slow_down_strikes = 3` server-side, regardless of
    // what value any individual poll read pre-fix.
    expect(deviceCodeDocUpdate).toHaveBeenCalledTimes(3);
    for (const call of deviceCodeDocUpdate.mock.calls) {
      expect(call[0]).toMatchObject({
        slow_down_strikes: { __increment: 1 },
        poll_interval_seconds: { __increment: 5 },
      });
      // Critically: NOT a literal number — that would be the lost-update bug.
      expect(typeof call[0].slow_down_strikes).not.toBe('number');
    }
  });
});
