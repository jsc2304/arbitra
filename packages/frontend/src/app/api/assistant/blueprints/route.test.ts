/**
 * `GET`/`POST /api/assistant/blueprints` — list-and-create is scoped entirely
 * to the session user (`auth.userId`), never a body/query value, and the
 * `.strict()` validator rejects a malformed cron/timezone or a smuggled
 * system-owned field (e.g. `owner_user_id`, `version`) BEFORE the service —
 * and therefore before any Firestore write — is ever reached.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { list, create, authenticate } = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock('@arbitra/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arbitra/backend')>();
  return {
    ...actual,
    TaskBlueprintService: class {
      list = list;
      create = create;
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

import { GET, POST } from './route';

const OWNER = 'usr_owner';

function listRequest(): NextRequest {
  return new NextRequest('http://localhost/api/assistant/blueprints');
}

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/assistant/blueprints', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  name: 'Daily digest',
  prompt_text: 'Summarise open cases.',
  cron_schedule: '0 8 * * *',
  timezone: 'UTC',
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: OWNER });
});

describe('GET /api/assistant/blueprints', () => {
  it("lists only the caller's own blueprints", async () => {
    list.mockResolvedValue([]);

    const response = await GET(listRequest());

    expect(list).toHaveBeenCalledWith(OWNER);
    expect(response.status).toBe(200);
  });
});

describe('POST /api/assistant/blueprints', () => {
  it('creates a blueprint for the session user with the validated, defaulted body', async () => {
    create.mockResolvedValue({ blueprint_id: 'bp_1', ...VALID_BODY, enabled: true, version: 1 });

    const response = await POST(createRequest(VALID_BODY));

    expect(create).toHaveBeenCalledWith(OWNER, { ...VALID_BODY, enabled: true });
    expect(response.status).toBe(201);
  });

  it('rejects a smuggled system-owned field (owner_user_id) before the service is called', async () => {
    const response = await POST(createRequest({ ...VALID_BODY, owner_user_id: 'usr_forged' }));

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a malformed cron_schedule before the service is called', async () => {
    const response = await POST(createRequest({ ...VALID_BODY, cron_schedule: 'not a cron' }));

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized timezone before the service is called', async () => {
    const response = await POST(createRequest({ ...VALID_BODY, timezone: 'Nowhere/Land' }));

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});
