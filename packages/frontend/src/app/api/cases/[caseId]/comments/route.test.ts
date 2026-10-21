import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { Comment } from '@arbitra/shared';

// ---------------------------------------------------------------------------
// Mocks — wired before importing the route.
// ---------------------------------------------------------------------------

const { artifactsDocSet, commentsDocSet, generateId, safeHeartbeat } = vi.hoisted(() => ({
  artifactsDocSet: vi.fn(),
  commentsDocSet: vi.fn(),
  generateId: vi.fn(() => 'comment_test_1'),
  safeHeartbeat: vi.fn(),
}));

// Capture the persisted Comment so round-trip tests can assert on normalized
// actor_metadata (lowercased client_name / model, trimmed client_version).
const lastPersistedComment: { value: Comment | null } = { value: null };

vi.mock('@arbitra/backend', () => ({
  // Inline validateBody — same trivial wrapper as
  // packages/backend/src/middleware/request-validator.ts. Avoids pulling in
  // the full backend module (firestore init side effects) for a route unit
  // test.
  validateBody: <T>(schema: { parse: (data: unknown) => T }, body: unknown): T =>
    schema.parse(body),
  collections: {
    comments: () => ({
      doc: () => ({
        set: vi.fn(async (c: Comment) => {
          lastPersistedComment.value = c;
          commentsDocSet(c);
        }),
      }),
    }),
    artifacts: () => ({
      doc: () => ({
        set: vi.fn(async (artifact: unknown) => {
          artifactsDocSet(artifact);
        }),
      }),
    }),
  },
  generateId,
  safeHeartbeat,
  ArtifactService: class {
    async createFromBase64(input: {
      caseId: string;
      commentId?: string;
      filename: string;
      contentType: string;
      base64Data: string;
      actorId: string;
    }) {
      return {
        artifact_id: 'art_test_1',
        case_id: input.caseId,
        comment_id: input.commentId,
        filename: input.filename,
        content_type: input.contentType,
        storage_path: '2026/05/01/art_test_1-file.txt',
        size_bytes: Math.ceil(input.base64Data.length * 3 / 4),
        created_by: input.actorId,
        created_at: '2026-05-01T00:00:00.000Z',
      };
    }
  },
  CaseService: class {
    async getCase() {
      throw new Error('not mocked');
    }
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
  return new NextRequest('http://localhost/api/cases/case_1/comments', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  lastPersistedComment.value = null;
  authenticate.mockResolvedValue({ userId: 'user_1', authType: 'firebase' });
  requireCaseAccess.mockResolvedValue(null);
  safeHeartbeat.mockResolvedValue(undefined);
});

/**
 * Issue #749 item 2: `checkCaseAccess` used to fail open on a case id that
 * doesn't exist, and this route writes the comment unconditionally once
 * `requireCaseAccess` passes — no follow-up existence check. This pins the
 * route's own contract with that gate: a denial (the shape `requireCaseAccess`
 * returns for a fabricated case id post-fix) must short-circuit before the
 * comment is ever persisted. `packages/backend/src/lib/project-access.test.ts`
 * covers the fail-open flip itself; this covers that the route actually
 * honors the denial.
 */
describe('POST /api/cases/:caseId/comments — fabricated case id (#749)', () => {
  it('404s and never persists when requireCaseAccess denies (nonexistent case)', async () => {
    requireCaseAccess.mockResolvedValue(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const res = await POST(
      makeReq({ body: 'hello from a fabricated case id' }),
      { params: Promise.resolve({ caseId: 'case_fabricated' }) },
    );

    expect(res.status).toBe(404);
    expect(commentsDocSet).not.toHaveBeenCalled();
    expect(safeHeartbeat).not.toHaveBeenCalled();
  });
});

describe('POST /api/cases/:caseId/comments — attachments', () => {
  it('stores uploaded files as artifacts linked to the comment', async () => {
    const res = await POST(
      makeReq({
        body: 'see attached',
        attachments: [
          {
            filename: 'trace.log',
            content_type: 'text/plain',
            data: 'cnVuIGxvZw==',
          },
        ],
      }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(res.status).toBe(201);
    expect(artifactsDocSet).toHaveBeenCalledWith(expect.objectContaining({
      artifact_id: 'art_test_1',
      case_id: 'case_1',
      comment_id: 'comment_test_1',
      filename: 'trace.log',
    }));
    expect(lastPersistedComment.value?.attachment_refs).toEqual(['art_test_1']);
  });
});

describe('POST /api/cases/:caseId/comments — agent presence heartbeat', () => {
  it('maps firebase authType → source=web', async () => {
    await POST(
      makeReq({ body: 'hello' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(safeHeartbeat).toHaveBeenCalledWith({
      caseId: 'case_1',
      userId: 'user_1',
      source: 'web',
    });
  });

  it('maps token authType → source=ide_agent', async () => {
    authenticate.mockResolvedValue({ userId: 'user_1', authType: 'token' });

    await POST(
      makeReq({ body: 'hello' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(safeHeartbeat).toHaveBeenCalledWith({
      caseId: 'case_1',
      userId: 'user_1',
      source: 'ide_agent',
    });
  });
});

// ---------------------------------------------------------------------------
// Round-trip: POST accepts valid actor_metadata → persisted row normalized.
// ---------------------------------------------------------------------------

describe('POST /api/cases/:caseId/comments — actor_metadata round-trip', () => {
  it('accepts valid actor_metadata and persists normalized fields', async () => {
    const res = await POST(
      makeReq({
        body: 'looks good',
        source: 'ide_agent',
        actor_metadata: {
          client_name: '  Cursor  ',
          client_version: '  0.42.1  ',
          model: 'Claude-Opus-4-7',
        },
      }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(res.status).toBe(201);
    expect(lastPersistedComment.value?.actor_metadata).toEqual({
      client_name: 'cursor',
      client_version: '0.42.1',
      model: 'claude-opus-4-7',
    });
  });

  it('omits actor_metadata from persisted row when not provided', async () => {
    const res = await POST(
      makeReq({ body: 'human note' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(res.status).toBe(201);
    expect(lastPersistedComment.value).not.toBeNull();
    expect(lastPersistedComment.value?.actor_metadata).toBeUndefined();
  });

  it('rejects unknown keys in actor_metadata (strict schema)', async () => {
    const res = await POST(
      makeReq({
        body: 'bad meta',
        actor_metadata: { client_name: 'cursor', rogue_field: 'x' },
      }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    // validateBody throws on strict-mode violations, handleError returns 500.
    // The key assertion is that the write never happened.
    expect(res.status).toBe(500);
    expect(lastPersistedComment.value).toBeNull();
  });
});
