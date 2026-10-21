import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  getCase,
  transition,
  createRun,
  completeRun,
  onRunCompleted,
  commentsDocSet,
  generateId,
} = vi.hoisted(() => ({
  getCase: vi.fn(),
  transition: vi.fn(),
  createRun: vi.fn(),
  completeRun: vi.fn(),
  onRunCompleted: vi.fn(),
  commentsDocSet: vi.fn(),
  generateId: vi.fn(() => 'comment_test_1'),
}));

// Capture the persisted comment (arg 0 to commentsDocSet) so tests can assert
// that top-level actor_metadata flows through to the exploration-summary comment.
const lastPersistedComment: { value: Record<string, unknown> | null } = { value: null };

vi.mock('@arbitra/backend', () => ({
  CaseService: vi.fn().mockImplementation(() => ({
    getCase,
  })),
  OrchestrationService: vi.fn().mockImplementation(() => ({
    transition,
  })),
  FirestorePipelineAdapter: vi.fn().mockImplementation(() => ({
    createRun,
    completeRun,
  })),
  RunCompletionHandler: vi.fn().mockImplementation(() => ({
    onRunCompleted,
  })),
  collections: {
    comments: () => ({
      doc: () => ({
        set: (c: Record<string, unknown>) => {
          lastPersistedComment.value = c;
          return commentsDocSet(c);
        },
      }),
    }),
  },
  generateId,
  safeHeartbeat: vi.fn(),
}));

const { authenticate, requireCaseAccess, handleError } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireCaseAccess: vi.fn(),
  handleError: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');

  return {
    authenticate,
    requireCaseAccess,
    validate: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T =>
      schema.parse(body),
    validationErrorResponse: (
      message: string,
      issues: Array<{ code: string; message: string; path: unknown[] }>,
    ) => NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message,
          details: {
            issues: issues.map((issue) => ({
              code: issue.code,
              message: issue.message,
              path: issue.path.map(String),
            })),
          },
        },
      },
      { status: 400 },
    ),
    invalidJsonResponse: (message = 'Request body must be valid JSON') =>
      NextResponse.json(
        {
          error: {
            code: 'INVALID_JSON',
            message,
          },
        },
        { status: 400 },
      ),
    handleError: (err: unknown) => {
      handleError(err);
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status: 500 });
    },
  };
});

import { POST } from './route';

function makeReq(body: string): NextRequest {
  return new NextRequest('http://localhost/api/agent/explore', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockReset();
  requireCaseAccess.mockReset();
  handleError.mockReset();
  getCase.mockReset();
  transition.mockReset();
  createRun.mockReset();
  completeRun.mockReset();
  onRunCompleted.mockReset();
  commentsDocSet.mockReset();
  generateId.mockReset();
  generateId.mockReturnValue('comment_test_1');
  lastPersistedComment.value = null;

  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireCaseAccess.mockResolvedValue(null);
  transition.mockResolvedValue(undefined);
  createRun.mockResolvedValue({ run_id: 'run_1' });
  completeRun.mockResolvedValue(undefined);
  onRunCompleted.mockResolvedValue(undefined);
  commentsDocSet.mockResolvedValue(undefined);
  getCase
    .mockResolvedValueOnce({ case_id: 'case_1', status: 'open' })
    .mockResolvedValueOnce({ case_id: 'case_1', status: 'ready_for_build' })
    .mockResolvedValueOnce({ case_id: 'case_1', status: 'in_build' })
    .mockResolvedValue({ case_id: 'case_1', status: 'in_build' });
});

describe('POST /api/agent/explore', () => {
  it('returns INVALID_JSON for malformed JSON', async () => {
    const res = await POST(makeReq('{'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_JSON');
  });

  it('returns structured VALIDATION_ERROR issues for missing summary', async () => {
    const res = await POST(makeReq(JSON.stringify({ case_id: 'case_1' })));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['summary'] }),
      ]),
    );
  });

  it('returns INVALID_CASE_STATE with details for non-open cases', async () => {
    getCase.mockReset();
    getCase.mockResolvedValue({ case_id: 'case_1', status: 'in_review' });

    const res = await POST(makeReq(JSON.stringify({
      case_id: 'case_1',
      summary: 'Explored the change',
    })));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_CASE_STATE');
    expect(body.error.details.required_statuses).toEqual(['open', 'exploration']);
  });

  it('accepts a valid request and auto-advances to in_build', async () => {
    const res = await POST(makeReq(JSON.stringify({
      case_id: 'case_1',
      summary: 'Explored the change',
    })));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('in_build');
    expect(transition).toHaveBeenCalledWith('case_1', 'exploration', 'user_1');
    expect(transition).toHaveBeenCalledWith('case_1', 'in_build', 'user_1');
    expect(commentsDocSet).toHaveBeenCalledTimes(1);
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(onRunCompleted).toHaveBeenCalledWith('case_1');
  });
});

// ---------------------------------------------------------------------------
// actor_metadata wiring — mirrors build-complete so the exploration-summary
// comment carries the specific client/model instead of the generic ide-agent
// badge. Old MCP versions that don't send the field must continue to work.
// ---------------------------------------------------------------------------

describe('POST /api/agent/explore — actor_metadata wiring', () => {
  it('omits actor_metadata on the exploration-summary comment when not provided (back-compat)', async () => {
    const res = await POST(makeReq(JSON.stringify({
      case_id: 'case_1',
      summary: 'Explored the change',
    })));

    expect(res.status).toBe(200);
    expect(lastPersistedComment.value).not.toBeNull();
    expect(lastPersistedComment.value?.actor_metadata).toBeUndefined();
    // Regression guard: the comment still carries its source/agent_name.
    expect(lastPersistedComment.value?.source).toBe('ide_agent');
    expect(lastPersistedComment.value?.agent_name).toBe('ide-agent');
  });

  it('persists top-level actor_metadata on the exploration-summary comment (normalized)', async () => {
    // Use messy input to prove normalizeActorMetadata actually runs (whitespace
    // trim + casing). Mirrors the build-complete test pattern.
    const res = await POST(makeReq(JSON.stringify({
      case_id: 'case_1',
      summary: 'Explored the change',
      actor_metadata: {
        client_name: '  Cursor  ',
        client_version: '0.42.0',
      },
    })));

    expect(res.status).toBe(200);
    expect(lastPersistedComment.value).not.toBeNull();
    expect(lastPersistedComment.value?.actor_metadata).toEqual({
      client_name: 'cursor',
      client_version: '0.42.0',
    });
  });

  it('rejects malformed actor_metadata with 400 (no writes)', async () => {
    const res = await POST(makeReq(JSON.stringify({
      case_id: 'case_1',
      summary: 'Explored the change',
      // Unknown key — strict schema rejects.
      actor_metadata: { client_name: 'cursor', rogue_field: 'x' },
    })));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(commentsDocSet).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Structural `kind` tag — replaces the dossier's temporal-pairing heuristic.
// The exploration-summary channel must always tag the persisted comment with
// `kind: 'exploration_summary'` so the dossier can locate the slot directly.
// ---------------------------------------------------------------------------

describe('POST /api/agent/explore — kind tag', () => {
  it("tags the persisted comment with kind: 'exploration_summary'", async () => {
    const res = await POST(makeReq(JSON.stringify({
      case_id: 'case_1',
      summary: 'Explored the change',
    })));

    expect(res.status).toBe(200);
    expect(lastPersistedComment.value).not.toBeNull();
    expect(lastPersistedComment.value?.kind).toBe('exploration_summary');
  });

  it('still tags the comment when actor_metadata is provided', async () => {
    const res = await POST(makeReq(JSON.stringify({
      case_id: 'case_1',
      summary: 'Explored the change',
      actor_metadata: { client_name: 'cursor', client_version: '0.42.0' },
    })));

    expect(res.status).toBe(200);
    expect(lastPersistedComment.value?.kind).toBe('exploration_summary');
  });
});
