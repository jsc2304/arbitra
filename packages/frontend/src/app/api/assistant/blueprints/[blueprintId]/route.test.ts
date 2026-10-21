/**
 * `GET`/`PATCH`/`DELETE /api/assistant/blueprints/[blueprintId]` — every
 * verb delegates ownership entirely to `TaskBlueprintService`, which this
 * test proves by making the service reject with the REAL `ForbiddenError`
 * (403) for a foreign blueprint and asserting the route surfaces exactly
 * that status, not a swallowed 500 or a leak-avoiding 404.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { get, update, archive, authenticate } = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock('@arbitra/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arbitra/backend')>();
  return {
    ...actual,
    TaskBlueprintService: class {
      get = get;
      update = update;
      archive = archive;
    },
  };
});

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    handleError: (error: unknown) =>
      NextResponse.json(
        {
          error: {
            code: (error as { code?: string })?.code ?? 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        },
        { status: (error as { statusCode?: number })?.statusCode ?? 500 },
      ),
  };
});

import { GET, PATCH, DELETE } from './route';

const OWNER = 'usr_owner';
const BLUEPRINT_ID = 'bp_1';

function params() {
  return { params: Promise.resolve({ blueprintId: BLUEPRINT_ID }) };
}

function getRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/assistant/blueprints/${BLUEPRINT_ID}`);
}

function patchRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/assistant/blueprints/${BLUEPRINT_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deleteRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/assistant/blueprints/${BLUEPRINT_ID}`, {
    method: 'DELETE',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: OWNER });
});

describe('GET /api/assistant/blueprints/[blueprintId]', () => {
  it('returns the blueprint for its owner', async () => {
    get.mockResolvedValue({ blueprint_id: BLUEPRINT_ID, owner_user_id: OWNER });

    const response = await GET(getRequest(), params());

    expect(get).toHaveBeenCalledWith(BLUEPRINT_ID, OWNER);
    expect(response.status).toBe(200);
  });

  it('403s for a blueprint owned by someone else', async () => {
    const { ForbiddenError } = await import('@arbitra/shared');
    get.mockRejectedValue(new ForbiddenError('not yours'));

    const response = await GET(getRequest(), params());

    expect(response.status).toBe(403);
  });

  it('404s for a blueprint that does not exist', async () => {
    const { NotFoundError } = await import('@arbitra/shared');
    get.mockRejectedValue(new NotFoundError('TaskBlueprint', BLUEPRINT_ID));

    const response = await GET(getRequest(), params());

    expect(response.status).toBe(404);
  });
});

describe('PATCH /api/assistant/blueprints/[blueprintId]', () => {
  it('passes the validated partial body through to the service', async () => {
    update.mockResolvedValue({ blueprint_id: BLUEPRINT_ID, name: 'Renamed', version: 2 });

    const response = await PATCH(patchRequest({ name: 'Renamed' }), params());

    expect(update).toHaveBeenCalledWith(BLUEPRINT_ID, OWNER, { name: 'Renamed' });
    expect(response.status).toBe(200);
  });

  it('rejects an empty body before the service is called', async () => {
    const response = await PATCH(patchRequest({}), params());

    expect(response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('403s for a blueprint owned by someone else', async () => {
    const { ForbiddenError } = await import('@arbitra/shared');
    update.mockRejectedValue(new ForbiddenError('not yours'));

    const response = await PATCH(patchRequest({ name: 'Hijacked' }), params());

    expect(response.status).toBe(403);
  });

  it('409s on an archived blueprint', async () => {
    const { ArbitraError } = await import('@arbitra/shared');
    update.mockRejectedValue(new ArbitraError('archived', 'TASK_BLUEPRINT_ARCHIVED', 409));

    const response = await PATCH(patchRequest({ name: 'Resurrected' }), params());

    expect(response.status).toBe(409);
  });
});

describe('DELETE /api/assistant/blueprints/[blueprintId]', () => {
  it('archives the blueprint for its owner', async () => {
    archive.mockResolvedValue({ blueprint_id: BLUEPRINT_ID, archived_at: '2026-08-06T00:00:00.000Z' });

    const response = await DELETE(deleteRequest(), params());

    expect(archive).toHaveBeenCalledWith(BLUEPRINT_ID, OWNER);
    expect(response.status).toBe(200);
  });

  it('403s for a blueprint owned by someone else', async () => {
    const { ForbiddenError } = await import('@arbitra/shared');
    archive.mockRejectedValue(new ForbiddenError('not yours'));

    const response = await DELETE(deleteRequest(), params());

    expect(response.status).toBe(403);
  });
});
