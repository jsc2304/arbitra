/**
 * Tests for `/api/tokens` — focused on the PR 2 additions:
 *   1. POST accepts optional `client_name` / `client_version` / `device_id` /
 *      `device_label` / `created_via` fields and persists them.
 *   2. DELETE accepts a `device_id` query param that bulk-revokes every token
 *      for the authenticated user with that device_id.
 *
 * The legacy single-token DELETE contract is also re-asserted as a regression
 * guard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  tokensDocSet,
  tokensDocGet,
  tokensDocDelete,
  tokensQueryGet,
  tokensRefDeletes,
  authenticate,
  generateId,
} = vi.hoisted(() => ({
  tokensDocSet: vi.fn(),
  tokensDocGet: vi.fn(),
  tokensDocDelete: vi.fn(),
  tokensQueryGet: vi.fn(),
  tokensRefDeletes: [] as Array<ReturnType<typeof vi.fn>>,
  authenticate: vi.fn(),
  // Real-shaped stub (not a fixed literal) so the id-format assertion below
  // is meaningful: `tok_${Date.now()}` was replaced with
  // `generateId('token')` — this mirrors the real `tok_<16 nanoid chars>`
  // shape without importing the actual ids module (which would pull in
  // firebase-admin init via the `@arbitra/backend` barrel).
  generateId: vi.fn((entityType: string) => `${entityType === 'token' ? 'tok_' : `${entityType}_`}abcdefgh12345678`),
}));

vi.mock('@arbitra/backend', () => {
  const queryChain = () => {
    const obj: Record<string, unknown> = {
      where: () => obj,
      limit: () => obj,
      get: tokensQueryGet,
    };
    return obj;
  };
  return {
    collections: {
      tokens: () => ({
        ...queryChain(),
        doc: () => ({
          set: tokensDocSet,
          get: tokensDocGet,
          delete: tokensDocDelete,
        }),
      }),
    },
    generateId,
    // Mirrors the real `validateBody` (packages/backend/src/middleware/
    // request-validator.ts) contract closely enough for `handleError` below
    // to map failures to 400: real Zod schema (createTokenSchema, unmocked
    // — imported for real from `@arbitra/shared`), thrown error carries
    // `statusCode`.
    validateBody: (schema: { safeParse: (data: unknown) => { success: true; data: unknown } | { success: false; error: { issues: unknown[] } } }, body: unknown) => {
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        const err = Object.assign(new Error('Invalid request payload'), {
          statusCode: 400,
          issues: parsed.error.issues,
        });
        throw err;
      }
      return parsed.data;
    },
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

import { POST, DELETE } from './route';

function postReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/tokens', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function deleteReq(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/tokens${query}`, { method: 'DELETE' });
}

beforeEach(() => {
  vi.clearAllMocks();
  tokensRefDeletes.length = 0;
  authenticate.mockResolvedValue({ userId: 'user_1', email: 'u@x' });
});

describe('POST /api/tokens — createTokenSchema wiring', () => {
  it('rejects a missing name with 400 (via createTokenSchema, not the old hand-rolled check)', async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
    expect(tokensDocSet).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only name with 400', async () => {
    const res = await POST(postReq({ name: '   ' }));
    expect(res.status).toBe(400);
    expect(tokensDocSet).not.toHaveBeenCalled();
  });

  it('coerces an empty client_name to undefined rather than rejecting (schema jsdoc contract)', async () => {
    const res = await POST(postReq({ name: 'CI Pipeline', client_name: '   ' }));
    expect(res.status).toBe(201);
    const written = tokensDocSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.client_name).toBeUndefined();
  });
});

describe('POST /api/tokens — per-tool / per-device metadata', () => {
  it('persists the new optional fields when provided', async () => {
    const res = await POST(postReq({
      name: 'CI Pipeline',
      client_name: 'ci',
      client_version: '1.0.0',
      device_id: 'd_abc123',
      device_label: 'gha-runner-42',
      created_via: 'ci_service',
    }));
    expect(res.status).toBe(201);
    expect(tokensDocSet).toHaveBeenCalledTimes(1);
    const written = tokensDocSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.client_name).toBe('ci');
    expect(written.client_version).toBe('1.0.0');
    expect(written.device_id).toBe('d_abc123');
    expect(written.device_label).toBe('gha-runner-42');
    expect(written.created_via).toBe('ci_service');
  });

  it('defaults created_via to "manual" when omitted', async () => {
    const res = await POST(postReq({ name: 'My token' }));
    expect(res.status).toBe(201);
    const written = tokensDocSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.created_via).toBe('manual');
  });

  it('clamps unknown created_via values back to "manual"', async () => {
    const res = await POST(postReq({ name: 'My token', created_via: 'whatever' }));
    expect(res.status).toBe(201);
    const written = tokensDocSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.created_via).toBe('manual');
  });

  it('mints token_id via generateId("token") instead of `tok_${Date.now()}` (A8a)', async () => {
    // Regression guard: two same-millisecond POSTs used to silently overwrite
    // each other via Firestore `.set()` because the id was time-derived.
    const res = await POST(postReq({ name: 'CI Pipeline' }));
    expect(res.status).toBe(201);
    expect(generateId).toHaveBeenCalledWith('token');
    const written = tokensDocSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.token_id).toMatch(/^tok_[A-Za-z0-9_-]+$/);
    expect(written.token_id).not.toMatch(/^tok_\d+$/);
  });

  it('clamps `unified_connect` to "manual" — that value is reserved for the server-side mint inside /api/auth/connect/token', async () => {
    // Regression guard for PR #586. The public POST
    // must not be able to produce tokens that masquerade as device-flow
    // verified — clamp silently rather than reject so an attacker can't probe
    // for the reserved value.
    const res = await POST(postReq({ name: 'My token', created_via: 'unified_connect' }));
    expect(res.status).toBe(201);
    const written = tokensDocSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.created_via).toBe('manual');
  });
});

describe('DELETE /api/tokens — single token (legacy contract)', () => {
  it('deletes by tokenId when the doc belongs to the caller', async () => {
    tokensDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ token_id: 'tok_x', user_id: 'user_1' }),
    });
    const res = await DELETE(deleteReq('?tokenId=tok_x'));
    expect(res.status).toBe(200);
    expect(tokensDocDelete).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the token belongs to a different user', async () => {
    tokensDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ token_id: 'tok_x', user_id: 'other' }),
    });
    const res = await DELETE(deleteReq('?tokenId=tok_x'));
    expect(res.status).toBe(404);
    expect(tokensDocDelete).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/tokens — bulk by device_id', () => {
  it('deletes every token row matching (user_id, device_id) for the caller', async () => {
    const delA = vi.fn();
    const delB = vi.fn();
    tokensQueryGet.mockResolvedValueOnce({
      empty: false,
      docs: [
        { ref: { delete: delA }, data: () => ({ token_id: 't1', user_id: 'user_1', device_id: 'd_mb' }) },
        { ref: { delete: delB }, data: () => ({ token_id: 't2', user_id: 'user_1', device_id: 'd_mb' }) },
      ],
    });

    const res = await DELETE(deleteReq('?device_id=d_mb'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deleted_count).toBe(2);
    expect(delA).toHaveBeenCalledTimes(1);
    expect(delB).toHaveBeenCalledTimes(1);
  });

  it('returns success with deleted_count=0 when no rows match (idempotent)', async () => {
    tokensQueryGet.mockResolvedValueOnce({ empty: true, docs: [] });
    const res = await DELETE(deleteReq('?device_id=d_missing'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deleted_count).toBe(0);
  });

  it('returns 400 when neither tokenId nor device_id is provided', async () => {
    const res = await DELETE(deleteReq(''));
    expect(res.status).toBe(400);
  });
});
