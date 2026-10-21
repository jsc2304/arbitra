import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// POST /api/cases must reject callers who are not members (or admins)
// of the target project before creating the case. Mirrors the mocking style
// of cases/[caseId]/decisions/route.test.ts: `requireProjectAccess` is the
// boundary we assert on directly rather than re-exercising
// checkProjectAccess/checkIsAdmin, which are covered where they live.
// ---------------------------------------------------------------------------

const { createCase } = vi.hoisted(() => ({
  createCase: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  CaseService: class {
    createCase = createCase;
  },
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T =>
    schema.parse(body),
  detectCaseFields: vi.fn(() => ({ case_type: 'other', jira_refs: [] })),
}));

const { authenticate, requireProjectAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => ({
  authenticate,
  requireProjectAccess,
  handleError: (error: unknown) => {
    // Mirrors formatError's precedence (packages/backend/src/middleware/error-handler.ts):
    // an ArbitraError (e.g. ValidationError, which carries `code`/`statusCode`)
    // takes priority over the raw-ZodError `issues` duck-type check.
    const isArbitraError = error instanceof Error && 'statusCode' in error && 'code' in error;
    const isZodIssues = !isArbitraError && error instanceof Error && 'issues' in error;
    const isValidation = isArbitraError || isZodIssues;
    const code = isArbitraError ? (error as Error & { code: string }).code : 'VALIDATION_ERROR';
    const status = isArbitraError ? (error as Error & { statusCode: number }).statusCode : (isZodIssues ? 400 : 500);
    return NextResponse.json(
      {
        error: {
          code: isValidation ? code : 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status },
    );
  },
}));

vi.mock('@/lib/comment-attachments', () => ({
  storeCommentAttachments: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/public-base-url', () => ({
  resolveCaseShareUrl: vi.fn(() => undefined),
}));

import { POST } from './route';

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/cases', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Fix the thing',
    source_type: 'manual',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    risk_level: 'medium',
    priority: 'normal',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireProjectAccess.mockResolvedValue(null);
  createCase.mockResolvedValue({
    case_id: 'case_1',
    project_id: 'proj_1',
    status: 'open',
  });
});

describe('POST /api/cases', () => {
  it('returns 404 and does not create a case when the caller is not a project member', async () => {
    requireProjectAccess.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const response = await POST(makeReq(validBody()));

    expect(response.status).toBe(404);
    expect(requireProjectAccess).toHaveBeenCalledWith('proj_1', 'user_1');
    expect(createCase).not.toHaveBeenCalled();
  });

  it('creates the case for an effective project member', async () => {
    const response = await POST(makeReq(validBody()));

    expect(response.status).toBe(201);
    expect(requireProjectAccess).toHaveBeenCalledWith('proj_1', 'user_1');
    expect(createCase).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'proj_1' }),
      'user_1',
    );
  });

  it('creates the case for an admin (requireProjectAccess short-circuits via the admin bypass)', async () => {
    // requireProjectAccess -> checkProjectAccess has its own admin bypass
    // (packages/backend/src/lib/project-access.ts); at this route-test layer
    // that just means the mock resolves null the same as a regular member.
    requireProjectAccess.mockResolvedValueOnce(null);

    const response = await POST(makeReq(validBody({ project_id: 'proj_admin_only' })));

    expect(response.status).toBe(201);
    expect(requireProjectAccess).toHaveBeenCalledWith('proj_admin_only', 'user_1');
    expect(createCase).toHaveBeenCalledTimes(1);
  });

  it('checks project access before creating the case (ordering)', async () => {
    const callOrder: string[] = [];
    requireProjectAccess.mockImplementationOnce(async () => {
      callOrder.push('requireProjectAccess');
      return null;
    });
    createCase.mockImplementationOnce(async () => {
      callOrder.push('createCase');
      return { case_id: 'case_1', project_id: 'proj_1', status: 'open' };
    });

    await POST(makeReq(validBody()));

    expect(callOrder).toEqual(['requireProjectAccess', 'createCase']);
  });

  // -------------------------------------------------------------------------
  // #997 — `observed` and `assistant_task` are system-created only (the
  // git-signal sweep and the assistant intake transaction write those case
  // documents directly, without going through this route or CaseService). A
  // client posting one of these types here would bypass the atomic claim
  // dedup and the governance lifecycle those internal writers rely on.
  // -------------------------------------------------------------------------
  describe('internal-only case_type guard', () => {
    it.each(['observed', 'assistant_task'])(
      'rejects a public create with case_type %s before creating the case',
      async (caseType) => {
        const response = await POST(makeReq(validBody({ case_type: caseType })));

        expect(response.status).toBe(400);
        const payload = await response.json();
        expect(payload.error.message).toContain(caseType);
        expect(createCase).not.toHaveBeenCalled();
        // Rejected before the project-access check runs, same ordering as
        // the payload-shape validation it sits next to.
        expect(requireProjectAccess).not.toHaveBeenCalled();
      },
    );

    it('still creates a case for a regular, publicly-creatable case_type', async () => {
      const response = await POST(makeReq(validBody({ case_type: 'bugfix' })));

      expect(response.status).toBe(201);
      expect(createCase).toHaveBeenCalledWith(
        expect.objectContaining({ case_type: 'bugfix' }),
        'user_1',
      );
    });

    it('still creates a case when case_type is omitted', async () => {
      const response = await POST(makeReq(validBody()));

      expect(response.status).toBe(201);
      expect(createCase).toHaveBeenCalled();
    });
  });
});
