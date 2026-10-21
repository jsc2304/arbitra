/**
 * Tests for `/api/projects` POST (create) and `/api/projects/[projectId]`
 * PATCH (update), focused on `default_language` boundary validation:
 * a valid 'de' is persisted; an invalid value is rejected with 400 before
 * the write. Unwired/unvalidated fields are a known recurring bug class in
 * this repo, so the guard is asserted at the route boundary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  projectsSet,
  projectsDocGet,
  projectsUpdate,
  usersDocGet,
  authenticate,
} = vi.hoisted(() => ({
  projectsSet: vi.fn(),
  projectsDocGet: vi.fn(),
  projectsUpdate: vi.fn(),
  usersDocGet: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  collections: {
    projects: () => ({
      doc: () => ({
        set: projectsSet,
        get: projectsDocGet,
        update: projectsUpdate,
      }),
    }),
    users: () => ({
      doc: () => ({ get: usersDocGet }),
    }),
  },
  generateId: vi.fn((entityType: string) => `${entityType === 'project' ? 'proj_' : `${entityType}_`}abcdefgh12345678`),
  // `route.ts` POST calls `validateBody` directly (not the `validate`
  // wrapper below) to avoid the `.default()`-field generics quirk
  // documented at its call site — same statusCode-400-on-failure shape.
  validateBody: <T>(schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false } }, body: unknown): T => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const err = new Error('Invalid request payload') as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    return parsed.data;
  },
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    handleError: (err: unknown) => {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status });
    },
    // Real schema.safeParse behavior wrapped just enough to reach
    // `handleError`'s statusCode-driven 400 the same way the real
    // `validate()` (-> `validateBody` -> `ValidationError`, statusCode 400)
    // does — the routes under test don't inspect anything else on failure.
    validate: <T>(schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false } }, body: unknown): T => {
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        const err = new Error('Invalid request payload') as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      }
      return parsed.data;
    },
    validationErrorResponse: (message: string) =>
      NextResponse.json({ error: { code: 'VALIDATION_ERROR', message } }, { status: 400 }),
  };
});

import { generateId } from '@arbitra/backend';
import { POST } from './route';
import { PATCH } from './[projectId]/route';

function makePost(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function makePatch(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/projects/proj_1', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1', email: 'u@x' });
});

describe('POST /api/projects — default_language validation', () => {
  it("persists a valid default_language ('de')", async () => {
    const res = await POST(makePost({ name: 'P', default_language: 'de' }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.default_language).toBe('de');
    expect(projectsSet).toHaveBeenCalledTimes(1);
    expect(projectsSet.mock.calls[0]?.[0].default_language).toBe('de');
  });

  it('omits default_language when not provided', async () => {
    const res = await POST(makePost({ name: 'P' }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.default_language).toBeUndefined();
  });

  it('returns 400 for an invalid default_language', async () => {
    const res = await POST(makePost({ name: 'P', default_language: 'fr' }));
    expect(res.status).toBe(400);
    expect(projectsSet).not.toHaveBeenCalled();
  });
});

describe('POST /api/projects — createProjectSchema wiring (issue #1070)', () => {
  it('returns 400 when reviewer_pool is not an array of strings', async () => {
    const res = await POST(makePost({ name: 'P', reviewer_pool: 'not-an-array' }));
    expect(res.status).toBe(400);
    expect(projectsSet).not.toHaveBeenCalled();
  });

  it('returns 400 when tech_leads contains a non-string element', async () => {
    const res = await POST(makePost({ name: 'P', tech_leads: [123] }));
    expect(res.status).toBe(400);
    expect(projectsSet).not.toHaveBeenCalled();
  });

  it('returns 400 when members is not an array', async () => {
    const res = await POST(makePost({ name: 'P', members: { a: 1 } }));
    expect(res.status).toBe(400);
    expect(projectsSet).not.toHaveBeenCalled();
  });

  it('returns 400 on an unknown top-level key (schema is .strict())', async () => {
    const res = await POST(makePost({ name: 'P', not_a_real_field: 'x' }));
    expect(res.status).toBe(400);
    expect(projectsSet).not.toHaveBeenCalled();
  });

  it('persists a valid body with reviewer_pool/tech_leads/members', async () => {
    const res = await POST(makePost({
      name: 'P',
      reviewer_pool: ['user_a'],
      tech_leads: ['user_b'],
      members: ['user_c'],
    }));
    expect(res.status).toBe(201);
    expect(projectsSet).toHaveBeenCalledTimes(1);
    const written = projectsSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.reviewer_pool).toEqual(['user_a']);
    expect(written.tech_leads).toEqual(['user_b']);
    expect(written.members).toEqual(['user_c']);
  });
});

describe('POST /api/projects — id generation (A8a)', () => {
  it('mints project_id via generateId("project") instead of `proj_${Date.now()}`', async () => {
    // Regression guard: two same-millisecond POSTs used to silently
    // overwrite each other via Firestore `.set()` because the id was
    // time-derived.
    const res = await POST(makePost({ name: 'P' }));
    expect(res.status).toBe(201);
    expect(generateId).toHaveBeenCalledWith('project');
    const written = projectsSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.project_id).toMatch(/^proj_[A-Za-z0-9_-]+$/);
    expect(written.project_id).not.toMatch(/^proj_\d+$/);
  });
});

describe('PATCH /api/projects/[projectId] — default_language validation', () => {
  beforeEach(() => {
    projectsDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        project_id: 'proj_1',
        name: 'P',
        owner_user_id: 'user_1',
        reviewer_pool: [],
        tech_leads: [],
      }),
    });
    usersDocGet.mockResolvedValue({ exists: true, data: () => ({ roles: [] }) });
    projectsUpdate.mockResolvedValue(undefined);
  });

  it("stores a valid default_language ('de')", async () => {
    // After update, the re-read returns the patched doc.
    projectsDocGet
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({
          project_id: 'proj_1',
          name: 'P',
          owner_user_id: 'user_1',
          reviewer_pool: [],
          tech_leads: [],
        }),
      })
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({ project_id: 'proj_1', name: 'P', default_language: 'de' }),
      });

    const res = await PATCH(makePatch({ default_language: 'de' }), {
      params: Promise.resolve({ projectId: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.default_language).toBe('de');
    expect(projectsUpdate).toHaveBeenCalledTimes(1);
    expect(projectsUpdate.mock.calls[0]?.[0].default_language).toBe('de');
  });

  it('returns 400 for an invalid default_language and does not update', async () => {
    const res = await PATCH(makePatch({ default_language: 'fr' }), {
      params: Promise.resolve({ projectId: 'proj_1' }),
    });
    expect(res.status).toBe(400);
    expect(projectsUpdate).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/projects/[projectId] — updateProjectSchema wiring (issue #1070)', () => {
  beforeEach(() => {
    projectsDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        project_id: 'proj_1',
        name: 'P',
        owner_user_id: 'user_1',
        reviewer_pool: [],
        tech_leads: [],
      }),
    });
    usersDocGet.mockResolvedValue({ exists: true, data: () => ({ roles: [] }) });
    projectsUpdate.mockResolvedValue(undefined);
  });

  it('returns 400 when reviewer_pool is not an array of strings', async () => {
    const res = await PATCH(makePatch({ reviewer_pool: 'not-an-array' }), {
      params: Promise.resolve({ projectId: 'proj_1' }),
    });
    expect(res.status).toBe(400);
    expect(projectsUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when members contains a non-string element', async () => {
    const res = await PATCH(makePatch({ members: [42] }), {
      params: Promise.resolve({ projectId: 'proj_1' }),
    });
    expect(res.status).toBe(400);
    expect(projectsUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 on an unknown top-level key (schema is .strict())', async () => {
    const res = await PATCH(makePatch({ not_a_real_field: 'x' }), {
      params: Promise.resolve({ projectId: 'proj_1' }),
    });
    expect(res.status).toBe(400);
    expect(projectsUpdate).not.toHaveBeenCalled();
  });

  it('persists a valid body with reviewer_pool/tech_leads/members', async () => {
    const res = await PATCH(makePatch({
      reviewer_pool: ['user_a'],
      tech_leads: ['user_b'],
      members: ['user_c'],
    }), { params: Promise.resolve({ projectId: 'proj_1' }) });

    expect(res.status).toBe(200);
    expect(projectsUpdate).toHaveBeenCalledTimes(1);
    const written = projectsUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.reviewer_pool).toEqual(['user_a']);
    expect(written.tech_leads).toEqual(['user_b']);
    expect(written.members).toEqual(['user_c']);
  });

  it('rejects a whitespace-only name instead of silently persisting it (tightened by #1070)', async () => {
    // Pre-#1070 the route spread the raw body straight onto the Firestore
    // doc with no shape check at all, so `name: '  '` was persisted as-is.
    const res = await PATCH(makePatch({ name: '  ' }), { params: Promise.resolve({ projectId: 'proj_1' }) });
    expect(res.status).toBe(400);
    expect(projectsUpdate).not.toHaveBeenCalled();
  });
});
