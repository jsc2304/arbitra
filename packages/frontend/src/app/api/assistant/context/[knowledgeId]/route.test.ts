/**
 * `PATCH/DELETE /api/assistant/context/[knowledgeId]` — the owner write path
 * (#832 slice A). The property under test: a plain user (no `tech_lead`/
 * `admin` role) can edit and delete their OWN context entries, the route
 * passes the caller's own project id through as `expectedScopeRef`, and a
 * `NotFoundError` the SERVICE throws (foreign scope, wrong type, or a
 * genuinely missing asset — the service can't tell these apart, by design)
 * reaches the caller as an identical 404. Ownership is asserted inside
 * `KnowledgeService`, not this route, so there is no `getAsset` call here
 * to test against.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { updateAssetAsOwner, deleteAssetAsOwner, authenticate } = vi.hoisted(() => ({
  updateAssetAsOwner: vi.fn(),
  deleteAssetAsOwner: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock('@arbitra/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arbitra/backend')>();
  return {
    ...actual,
    // The REAL `clerkCoreIds`, so the `expectedScopeRef` the route passes
    // through is derived the same way a live deployment would derive it.
    KnowledgeService: class {
      updateAssetAsOwner = updateAssetAsOwner;
      deleteAssetAsOwner = deleteAssetAsOwner;
    },
  };
});

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    handleError: (error: unknown) =>
      NextResponse.json(
        { error: { message: error instanceof Error ? error.message : String(error) } },
        { status: (error as { statusCode?: number })?.statusCode ?? 500 },
      ),
  };
});

const { clerkCoreIds } = await import('@arbitra/backend');
const { PATCH, DELETE } = await import('./route');

const REQUESTER = 'usr_web_requester';
const OWN_PROJECT_ID = clerkCoreIds(REQUESTER).projectId;

function patchRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/assistant/context/know_ctx_1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deleteRequest(): NextRequest {
  return new NextRequest('http://localhost/api/assistant/context/know_ctx_1', {
    method: 'DELETE',
  });
}

function params(knowledgeId = 'know_ctx_1') {
  return { params: Promise.resolve({ knowledgeId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: REQUESTER });
});

describe('PATCH /api/assistant/context/[knowledgeId]', () => {
  it('passes the caller\'s own project id as expectedScopeRef — no privileged role required', async () => {
    // Reverted line: reintroducing a `requireRole(auth.userId, ['tech_lead',
    // 'admin'])` call in the route (mirroring the generic
    // `knowledge/[knowledgeId]/route.ts` gate) would make this fail — the
    // session here carries no roles at all.
    updateAssetAsOwner.mockResolvedValue({ knowledge_id: 'know_ctx_1', title: 'Updated roster' });

    const response = await PATCH(patchRequest({ title: 'Updated roster' }), params());

    expect(updateAssetAsOwner).toHaveBeenCalledWith(
      'know_ctx_1',
      { title: 'Updated roster' },
      REQUESTER,
      OWN_PROJECT_ID,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entry.title).toBe('Updated roster');
  });

  it('404s when the service reports the asset is not the caller\'s own (foreign scope, wrong type, or missing)', async () => {
    // Reverted line: this is the service-level ownership guard from
    // `knowledge-service.ts`'s `assertOwnedContextAsset` — the route itself
    // no longer fetches the asset to pre-check, so this test would still
    // pass a broken guard silently if the route regained its own check
    // while the service's stayed missing. It exercises the route's mapping
    // of that thrown error, not the guard's own logic (see
    // `knowledge-service.test.ts` for that).
    const { NotFoundError } = await import('@arbitra/shared');
    updateAssetAsOwner.mockRejectedValue(new NotFoundError('KnowledgeAsset', 'know_ctx_1'));

    const response = await PATCH(patchRequest({ title: 'Hijacked' }), params());

    expect(response.status).toBe(404);
  });

  it('rejects an unknown field via the .strict() schema before the service is called', async () => {
    const response = await PATCH(
      patchRequest({ scope_ref: 'proj_clerk_someone_else' }),
      params(),
    );

    expect(response.status).toBe(400);
    expect(updateAssetAsOwner).not.toHaveBeenCalled();
  });

  it('propagates an authentication failure without calling the service', async () => {
    authenticate.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));

    const response = await PATCH(patchRequest({ title: 'x' }), params());

    expect(updateAssetAsOwner).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });
});

describe('DELETE /api/assistant/context/[knowledgeId]', () => {
  it('passes the caller\'s own project id as expectedScopeRef — no privileged role required', async () => {
    deleteAssetAsOwner.mockResolvedValue(undefined);

    const response = await DELETE(deleteRequest(), params());

    expect(deleteAssetAsOwner).toHaveBeenCalledWith('know_ctx_1', REQUESTER, OWN_PROJECT_ID);
    expect(response.status).toBe(200);
  });

  it('404s another user\'s asset instead of deleting it — untouchable even by id', async () => {
    const { NotFoundError } = await import('@arbitra/shared');
    deleteAssetAsOwner.mockRejectedValue(new NotFoundError('KnowledgeAsset', 'know_ctx_1'));

    const response = await DELETE(deleteRequest(), params());

    expect(response.status).toBe(404);
  });

  it('propagates an authentication failure without calling the service', async () => {
    authenticate.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));

    const response = await DELETE(deleteRequest(), params());

    expect(deleteAssetAsOwner).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });
});
