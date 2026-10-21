/**
 * `PATCH /api/users/:userId/roles` was flagged as missing a role gate, but
 * an inline admin gate + last-admin guard already exist (`route.ts`), so
 * they are NOT duplicated — this suite instead pins them (so a future refactor can't silently drop
 * them) and covers the one genuinely missing piece: Zod body validation
 * via `updateUserRolesSchema`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

interface UserDoc {
  roles?: string[];
}

const state: { users: Map<string, UserDoc> } = { users: new Map() };

function reset(): void {
  state.users = new Map();
}

const { targetUpdate } = vi.hoisted(() => ({ targetUpdate: vi.fn() }));

vi.mock('@arbitra/backend', () => ({
  collections: {
    users: () => ({
      doc: (id: string) => ({
        get: async () => {
          const u = state.users.get(id);
          return { exists: u !== undefined, data: () => u };
        },
        update: async (patch: Partial<UserDoc>) => {
          targetUpdate(id, patch);
          const existing = state.users.get(id) ?? {};
          state.users.set(id, { ...existing, ...patch });
        },
      }),
      get: async () => ({
        docs: [...state.users.entries()].map(([id, u]) => ({ id, data: () => u })),
      }),
    }),
  },
  // Mirrors the real `validateBody` contract (see tokens/route.test.ts):
  // real Zod schema, thrown error carries `statusCode` for `handleError`.
  validateBody: (schema: { safeParse: (data: unknown) => { success: true; data: unknown } | { success: false; error: { issues: unknown[] } } }, body: unknown) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw Object.assign(new Error('Invalid request payload'), { statusCode: 400, issues: parsed.error.issues });
    }
    return parsed.data;
  },
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

import { PATCH } from './route';

function patchReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/users/usr_target/roles', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const params = { params: Promise.resolve({ userId: 'usr_target' }) };

beforeEach(() => {
  vi.clearAllMocks();
  reset();
});

describe('PATCH /api/users/:userId/roles — inline admin gate (pinning)', () => {
  it('rejects a non-admin caller with 403', async () => {
    authenticate.mockResolvedValue({ userId: 'usr_caller' });
    state.users.set('usr_caller', { roles: ['developer'] });
    state.users.set('usr_target', { roles: ['developer'] });

    const res = await PATCH(patchReq({ roles: ['reviewer'] }), params);

    expect(res.status).toBe(403);
    expect(targetUpdate).not.toHaveBeenCalled();
  });

  it('allows an admin caller', async () => {
    authenticate.mockResolvedValue({ userId: 'usr_admin' });
    state.users.set('usr_admin', { roles: ['admin'] });
    state.users.set('usr_target', { roles: ['developer'] });

    const res = await PATCH(patchReq({ roles: ['reviewer'] }), params);

    expect(res.status).toBe(200);
    expect(targetUpdate).toHaveBeenCalledWith('usr_target', expect.objectContaining({ roles: ['reviewer'] }));
  });
});

describe('PATCH /api/users/:userId/roles — inline last-admin guard (pinning)', () => {
  beforeEach(() => {
    authenticate.mockResolvedValue({ userId: 'usr_admin' });
    state.users.set('usr_admin', { roles: ['admin'] });
  });

  it('rejects removing admin from the sole remaining admin (409)', async () => {
    // usr_admin is both the caller and the only admin in the system — patch
    // targets themselves.
    const res = await PATCH(patchReq({ roles: ['developer'] }), { params: Promise.resolve({ userId: 'usr_admin' }) });

    expect(res.status).toBe(409);
    expect(targetUpdate).not.toHaveBeenCalled();
  });

  it('allows removing admin when another admin remains', async () => {
    state.users.set('usr_target', { roles: ['admin'] });
    state.users.set('usr_other_admin', { roles: ['admin'] });

    const res = await PATCH(patchReq({ roles: ['developer'] }), { params: Promise.resolve({ userId: 'usr_target' }) });

    expect(res.status).toBe(200);
    expect(targetUpdate).toHaveBeenCalledWith('usr_target', expect.objectContaining({ roles: ['developer'] }));
  });
});

describe('PATCH /api/users/:userId/roles — updateUserRolesSchema wiring', () => {
  beforeEach(() => {
    authenticate.mockResolvedValue({ userId: 'usr_admin' });
    state.users.set('usr_admin', { roles: ['admin'] });
    state.users.set('usr_target', { roles: ['developer'] });
  });

  it('rejects an empty roles array with 400', async () => {
    const res = await PATCH(patchReq({ roles: [] }), params);
    expect(res.status).toBe(400);
    expect(targetUpdate).not.toHaveBeenCalled();
  });

  it('rejects an invalid role value with 400', async () => {
    const res = await PATCH(patchReq({ roles: ['superuser'] }), params);
    expect(res.status).toBe(400);
    expect(targetUpdate).not.toHaveBeenCalled();
  });

  it('rejects a non-array roles value with 400', async () => {
    const res = await PATCH(patchReq({ roles: 'admin' }), params);
    expect(res.status).toBe(400);
    expect(targetUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 when the target user does not exist', async () => {
    const res = await PATCH(patchReq({ roles: ['reviewer'] }), { params: Promise.resolve({ userId: 'usr_ghost' }) });
    expect(res.status).toBe(404);
  });
});
