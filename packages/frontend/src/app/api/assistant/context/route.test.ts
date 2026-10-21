/**
 * `GET/POST /api/assistant/context` — the owner list/create path for Clerk
 * context entries (#832 slice A). No id parameter names the scope on either
 * verb: `clerkCoreIds(auth.userId)` derives it from the session alone, so
 * there is nothing here a caller could point at someone else's project.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { KnowledgeAsset } from '@arbitra/shared';

const { listByScope, createAsset, authenticate } = vi.hoisted(() => ({
  listByScope: vi.fn(),
  createAsset: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock('@arbitra/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arbitra/backend')>();
  return {
    ...actual,
    // The REAL `clerkCoreIds` — deterministic on `auth.userId` alone, so a
    // test that seeded an asset under the wrong id would fail honestly
    // rather than the mock happening to agree with the route.
    KnowledgeService: class {
      listByScope = listByScope;
      createAsset = createAsset;
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

import { GET, POST } from './route';

const REQUESTER = 'usr_web_requester';

function getRequest(): NextRequest {
  return new NextRequest('http://localhost/api/assistant/context');
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/assistant/context', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function contextAsset(overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  return {
    knowledge_id: 'know_ctx_1',
    type: 'clerk_context',
    title: 'Team roster',
    summary: 'Team roster',
    body: 'Team members: Alice, Bob, Carol.',
    scope_type: 'project',
    scope_ref: 'proj_clerk_whatever',
    status: 'suggested',
    version: 1,
    trust_level: 0,
    source_case_refs: [],
    source_decision_refs: [],
    tags: [],
    artifact_refs: [],
    created_by: REQUESTER,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    always_inject: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: REQUESTER });
});

describe('GET /api/assistant/context', () => {
  it('lists only the caller\'s own project scope, narrowed to type clerk_context', async () => {
    listByScope.mockResolvedValue([
      contextAsset(),
      contextAsset({ knowledge_id: 'know_other_type', type: 'implementation_note' }),
    ]);

    const response = await GET(getRequest());

    expect(listByScope).toHaveBeenCalledWith('project', expect.any(String));
    const [, scopeRef] = listByScope.mock.calls[0]!;
    // The scope handed to the service is derived from the session id, not
    // from anything in the request.
    expect(typeof scopeRef).toBe('string');
    expect(scopeRef.length).toBeGreaterThan(0);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].knowledge_id).toBe('know_ctx_1');
  });

  it('propagates an authentication failure without calling the service', async () => {
    authenticate.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));

    const response = await GET(getRequest());

    expect(listByScope).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });
});

describe('POST /api/assistant/context', () => {
  it('creates a clerk_context entry scoped to the caller\'s own project, ignoring any scope/type smuggled in the body', async () => {
    createAsset.mockImplementation(async (input) => ({ ...contextAsset(), ...input }));

    const response = await POST(
      postRequest({
        title: 'Team roster',
        body: 'Team members: Alice, Bob, Carol.',
        always_inject: true,
        // Attempted overrides — the route must ignore all three.
        type: 'precedent',
        scope_type: 'global',
        scope_ref: 'proj_someone_else',
      }),
    );

    expect(createAsset).toHaveBeenCalledTimes(1);
    const [input, actorId] = createAsset.mock.calls[0]!;
    expect(input.type).toBe('clerk_context');
    expect(input.scope_type).toBe('project');
    expect(input.scope_ref).not.toBe('proj_someone_else');
    expect(input.always_inject).toBe(true);
    expect(actorId).toBe(REQUESTER);
    expect(response.status).toBe(201);
  });

  it('rejects an empty title before the service is called', async () => {
    const response = await POST(postRequest({ title: '   ', body: 'some body' }));

    expect(response.status).toBe(400);
    expect(createAsset).not.toHaveBeenCalled();
  });

  it('rejects an empty body before the service is called', async () => {
    const response = await POST(postRequest({ title: 'Team roster', body: '' }));

    expect(response.status).toBe(400);
    expect(createAsset).not.toHaveBeenCalled();
  });

  it('defaults always_inject when omitted, without inventing a value', async () => {
    createAsset.mockImplementation(async (input) => ({ ...contextAsset(), ...input }));

    await POST(postRequest({ title: 'Team roster', body: 'roster body' }));

    const [input] = createAsset.mock.calls[0]!;
    expect(input).not.toHaveProperty('always_inject');
  });
});
