import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { provision } = vi.hoisted(() => ({ provision: vi.fn() }));

vi.mock('@arbitra/backend', () => ({
  ProvisionClerkCoreService: class {
    provision = provision;
  },
}));

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock('@/lib/api-helpers', () => ({
  authenticate,
  handleError: (error: unknown) =>
    NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } },
      { status: (error as { statusCode?: number })?.statusCode ?? 500 },
    ),
}));

import { POST } from './route';

function makeRequest(body?: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/assistant/clerk-core', {
    method: 'POST',
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
}

const REQUESTER = 'usr_web_requester';

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: REQUESTER });
  provision.mockResolvedValue({
    user_id: REQUESTER,
    ids: { projectId: 'proj_clerk_x', repositoryId: 'repo_clerk_x', policyId: 'ep_clerk_x' },
    items: [
      { kind: 'project', id: 'proj_clerk_x', status: 'created' },
      { kind: 'repository', id: 'repo_clerk_x', status: 'created' },
      { kind: 'evidence_policy', id: 'ep_clerk_x', status: 'created' },
    ],
  });
});

describe('POST /api/assistant/clerk-core', () => {
  it('provisions the authenticated caller, not a user id from the body', async () => {
    const response = await POST(makeRequest({ user_id: 'usr_someone_else' }));

    expect(provision).toHaveBeenCalledWith(REQUESTER);
    expect(provision).not.toHaveBeenCalledWith('usr_someone_else');
    expect(response.status).toBe(201);
  });

  it('works with no request body at all', async () => {
    const response = await POST(makeRequest());

    expect(provision).toHaveBeenCalledWith(REQUESTER);
    expect(response.status).toBe(201);
  });

  it('returns the per-document breakdown and the deterministic ids', async () => {
    const response = await POST(makeRequest());
    const body = await response.json();

    expect(body).toEqual({
      project_id: 'proj_clerk_x',
      repository_id: 'repo_clerk_x',
      policy_id: 'ep_clerk_x',
      items: [
        { kind: 'project', id: 'proj_clerk_x', status: 'created' },
        { kind: 'repository', id: 'repo_clerk_x', status: 'created' },
        { kind: 'evidence_policy', id: 'ep_clerk_x', status: 'created' },
      ],
    });
  });

  it('reports 200, not 201, when a repeat call creates nothing', async () => {
    provision.mockResolvedValue({
      user_id: REQUESTER,
      ids: { projectId: 'proj_clerk_x', repositoryId: 'repo_clerk_x', policyId: 'ep_clerk_x' },
      items: [
        { kind: 'project', id: 'proj_clerk_x', status: 'already_provisioned' },
        { kind: 'repository', id: 'repo_clerk_x', status: 'already_provisioned' },
        { kind: 'evidence_policy', id: 'ep_clerk_x', status: 'already_provisioned' },
      ],
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
  });

  it('propagates authentication failure without calling provision', async () => {
    authenticate.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));

    const response = await POST(makeRequest());

    expect(provision).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });
});
