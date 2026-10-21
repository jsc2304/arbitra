import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks — wired before importing the route.
// ---------------------------------------------------------------------------

const { artifactsDocSet, createFromBase64 } = vi.hoisted(() => ({
  artifactsDocSet: vi.fn(),
  createFromBase64: vi.fn(async (input: {
    caseId: string;
    filename: string;
    contentType: string;
    base64Data: string;
    actorId: string;
  }) => ({
    artifact_id: 'art_test_1',
    case_id: input.caseId,
    filename: input.filename,
    content_type: input.contentType,
    storage_path: '2026/05/01/art_test_1-file.txt',
    size_bytes: Math.ceil(input.base64Data.length * 3 / 4),
    created_by: input.actorId,
    created_at: '2026-05-01T00:00:00.000Z',
  })),
}));

vi.mock('@arbitra/backend', () => ({
  // Inline validateBody — same trivial wrapper as
  // packages/backend/src/middleware/request-validator.ts. Avoids pulling in
  // the full backend module (firestore init side effects) for a route unit
  // test.
  validateBody: <T>(schema: { parse: (data: unknown) => T }, body: unknown): T =>
    schema.parse(body),
  collections: {
    artifacts: () => ({
      doc: () => ({
        set: vi.fn(async (artifact: unknown) => {
          artifactsDocSet(artifact);
        }),
      }),
      where: () => ({
        orderBy: () => ({
          get: async () => ({ docs: [] }),
        }),
      }),
    }),
  },
  ArtifactService: class {
    createFromBase64 = createFromBase64;
  },
}));

const { authenticate, requireCaseAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireCaseAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    requireCaseAccess,
    handleError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status: 500 });
    },
  };
});

import { POST } from './route';

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/cases/case_1/artifacts', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1', authType: 'firebase' });
  requireCaseAccess.mockResolvedValue(null);
});

describe('POST /api/cases/:caseId/artifacts — happy path', () => {
  it('persists the artifact once access is granted', async () => {
    const res = await POST(
      makeReq({
        filename: 'trace.log',
        content_type: 'text/plain',
        data: 'cnVuIGxvZw==',
      }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(res.status).toBe(201);
    expect(artifactsDocSet).toHaveBeenCalledWith(expect.objectContaining({
      artifact_id: 'art_test_1',
      case_id: 'case_1',
      filename: 'trace.log',
    }));
  });
});

/**
 * Issue #749 item 2: `checkCaseAccess` used to fail open on a case id that
 * doesn't exist ("let the route handle 404"), and this route writes the
 * artifact unconditionally once `requireCaseAccess` passes — nothing here
 * re-checks the case exists. This pins the route's own contract with that
 * gate: a denial (the shape `requireCaseAccess` returns for a fabricated
 * case id post-fix) must short-circuit before `ArtifactService.createFromBase64`
 * ever runs and before anything is persisted.
 * `packages/backend/src/lib/project-access.test.ts` covers the fail-open flip
 * itself; this covers that the route actually honors the denial.
 */
describe('POST /api/cases/:caseId/artifacts — fabricated case id (#749)', () => {
  it('404s and never persists when requireCaseAccess denies (nonexistent case)', async () => {
    requireCaseAccess.mockResolvedValue(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const res = await POST(
      makeReq({
        filename: 'trace.log',
        content_type: 'text/plain',
        data: 'cnVuIGxvZw==',
      }),
      { params: Promise.resolve({ caseId: 'case_fabricated' }) },
    );

    expect(res.status).toBe(404);
    expect(createFromBase64).not.toHaveBeenCalled();
    expect(artifactsDocSet).not.toHaveBeenCalled();
  });
});
