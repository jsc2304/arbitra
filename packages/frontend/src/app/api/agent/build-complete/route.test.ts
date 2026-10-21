import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks — wired before importing the route so the module picks them up.
//
// The route uses dynamic `await import('@arbitra/backend')` twice, so the
// factory is invoked multiple times per request. All service methods are
// spied so we can assert that malformed evidence payloads never reach
// `registerEvidence` (i.e. Firestore stays clean).
// ---------------------------------------------------------------------------

const {
  getCase,
  updateCase,
  registerEvidence,
  evaluateCompleteness,
  createRun,
  completeRun,
  onRunCompleted,
  commentsDocSet,
  generateId,
} = vi.hoisted(() => ({
  getCase: vi.fn(),
  updateCase: vi.fn(),
  registerEvidence: vi.fn(),
  evaluateCompleteness: vi.fn(),
  createRun: vi.fn(),
  completeRun: vi.fn(),
  onRunCompleted: vi.fn(),
  commentsDocSet: vi.fn(),
  generateId: vi.fn(() => 'comment_test_1'),
}));

// Capture the persisted comment (arg 0 to commentsDocSet) so tests can assert
// the top-level actor_metadata flows through to the build-summary comment.
const lastPersistedComment: { value: Record<string, unknown> | null } = { value: null };

vi.mock('@arbitra/backend', () => ({
  CaseService: vi.fn().mockImplementation(() => ({
    getCase,
    updateCase,
  })),
  EvidenceService: vi.fn().mockImplementation(() => ({
    registerEvidence,
    evaluateCompleteness,
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
  // Branch-uniqueness guard is exercised by its own unit tests. Here we stub
  // it to no-op so the build-complete tests stay focused on evidence validation.
  assertBranchUniqueForCase: vi.fn().mockResolvedValue(undefined),
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/agent/build-complete', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockReset();
  requireCaseAccess.mockReset();
  handleError.mockReset();
  getCase.mockReset();
  updateCase.mockReset();
  registerEvidence.mockReset();
  evaluateCompleteness.mockReset();
  createRun.mockReset();
  completeRun.mockReset();
  onRunCompleted.mockReset();
  commentsDocSet.mockReset();
  generateId.mockReset();
  generateId.mockReturnValue('comment_test_1');
  lastPersistedComment.value = null;
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireCaseAccess.mockResolvedValue(null);
  updateCase.mockResolvedValue(undefined);
  registerEvidence.mockResolvedValue({});
  evaluateCompleteness.mockResolvedValue({
    satisfied: true,
    required: ['ci_result'],
    present: ['ci_result'],
    missing: [],
    optional_present: [],
    four_eyes_required: false,
    allow_self_approval: false,
  });
  createRun.mockResolvedValue({ run_id: 'run_1' });
  completeRun.mockResolvedValue(undefined);
  onRunCompleted.mockResolvedValue(undefined);
  commentsDocSet.mockResolvedValue(undefined);
  // getCase is called twice (pre- and post-pipeline); second call sees a
  // progressed state.
  getCase
    .mockResolvedValueOnce({ case_id: 'case_1', status: 'in_build' })
    .mockResolvedValueOnce({ case_id: 'case_1', status: 'in_validation' })
    .mockResolvedValue({ case_id: 'case_1', status: 'in_validation' });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/agent/build-complete — evidence validation', () => {
  it('rejects missing-type evidence with 400 and writes nothing', async () => {
    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
        evidence: [{ summary: 'x' }],
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Invalid request payload');
    expect(Array.isArray(body.error.details.issues)).toBe(true);
    // At least one issue points at the missing `type` field of index 0.
    const issuePaths = body.error.details.issues.map((i: { path: unknown[] }) => i.path.join('.'));
    expect(issuePaths.some((p: string) => p.includes('type'))).toBe(true);
    // Zero evidence written, no run created.
    expect(registerEvidence).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it('rejects a batch containing any invalid item (no partial writes)', async () => {
    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
        evidence: [
          { type: 'ci_result', source_type: 'automated', summary: 'ok-1' },
          { summary: 'bad — missing type' }, // index 1: invalid
          { type: 'unit_test_result', source_type: 'automated', summary: 'ok-2' },
        ],
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    // Issue path must identify the offending index (1) so the agent author
    // can debug which items were malformed.
    const issuePaths: string[] = body.error.details.issues.map((i: { path: unknown[] }) =>
      i.path.map(String).join('.'),
    );
    expect(issuePaths.some((p) => p.includes('evidence.1'))).toBe(true);
    // Atomic: no writes at all, not even for the valid items.
    expect(registerEvidence).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it('rejects wrong-typed fields (e.g. non-string type) with 400', async () => {
    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
        evidence: [{ type: 123, source_type: 'automated' }],
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(registerEvidence).not.toHaveBeenCalled();
  });

  it('rejects build completion when required evidence is still missing', async () => {
    evaluateCompleteness.mockResolvedValueOnce({
      satisfied: false,
      required: ['ci_result', 'unit_test_result'],
      present: ['unit_test_result'],
      missing: ['ci_result'],
      optional_present: [],
      four_eyes_required: false,
      allow_self_approval: false,
    });

    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
        evidence: [
          {
            type: 'unit_test_result',
            source_type: 'automated',
            summary: '42/42 passing',
          },
        ],
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('MISSING_REQUIRED_EVIDENCE');
    expect(body.error.details.missing).toEqual(['ci_result']);
    expect(registerEvidence).toHaveBeenCalledTimes(1);
    expect(commentsDocSet).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it('accepts a valid evidence array and registers one record per item', async () => {
    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
        evidence: [
          {
            type: 'ci_result',
            source_type: 'automated',
            summary: 'CI green',
            machine_readable: true,
          },
        ],
      }),
    );

    expect(res.status).toBe(200);
    expect(registerEvidence).toHaveBeenCalledTimes(1);
    expect(registerEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        case_id: 'case_1',
        type: 'ci_result',
        source_type: 'automated',
        summary: 'CI green',
        machine_readable: true,
      }),
      'user_1',
    );
    // Full pipeline ran.
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(completeRun).toHaveBeenCalledTimes(1);
    expect(onRunCompleted).toHaveBeenCalledWith('case_1');
  });

  it('accepts an empty evidence array and still completes the build', async () => {
    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
        evidence: [],
      }),
    );

    expect(res.status).toBe(200);
    expect(registerEvidence).not.toHaveBeenCalled();
    expect(createRun).toHaveBeenCalledTimes(1);
  });

  it('accepts omitted evidence field and still completes the build', async () => {
    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
      }),
    );

    expect(res.status).toBe(200);
    expect(registerEvidence).not.toHaveBeenCalled();
    expect(createRun).toHaveBeenCalledTimes(1);
  });

  it('rejects non-array evidence payload with 400', async () => {
    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
        evidence: { type: 'ci_result' }, // object instead of array
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(registerEvidence).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Silent-drop fix: a non-canonical evidence `type` (e.g. manual_verification)
  // used to pass schema validation, get registered, then satisfy nothing — the
  // gate stayed unmet with no feedback. Now it's rejected at the boundary with
  // a named-type + accepted-types envelope, and nothing is written.
  // -------------------------------------------------------------------------
  it('rejects unknown evidence type with 400 naming the type and accepted types', async () => {
    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
        evidence: [
          { type: 'manual_verification', source_type: 'manual', summary: 'I checked it' },
        ],
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('UNKNOWN_EVIDENCE_TYPE');
    // Names the offending type.
    expect(body.error.message).toContain('manual_verification');
    expect(body.error.details.invalid_evidence_types).toContain('manual_verification');
    // Lists the accepted canonical types so the caller can correct it.
    expect(body.error.details.accepted_evidence_types).toContain('manual_confirmation');
    expect(body.error.details.accepted_evidence_types).toContain('ci_result');
    // Silent-drop is closed: nothing registered, no run created.
    expect(registerEvidence).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it('rejects a batch containing one unknown type without partial writes', async () => {
    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
        evidence: [
          { type: 'ci_result', source_type: 'automated', summary: 'green' },
          { type: 'manual_verification', source_type: 'manual', summary: 'checked' },
        ],
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('UNKNOWN_EVIDENCE_TYPE');
    expect(body.error.details.invalid_evidence_types).toEqual(['manual_verification']);
    // Atomic: the valid ci_result item is NOT written either.
    expect(registerEvidence).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it('accepts manual_confirmation (canonical) and still satisfies as before', async () => {
    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
        evidence: [
          { type: 'manual_confirmation', source_type: 'manual', summary: 'Manually verified' },
        ],
      }),
    );

    expect(res.status).toBe(200);
    expect(registerEvidence).toHaveBeenCalledTimes(1);
    expect(registerEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'manual_confirmation', source_type: 'manual' }),
      'user_1',
    );
    expect(createRun).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// actor_metadata wiring — wiring fixes from PR #323.
// ---------------------------------------------------------------------------

describe('POST /api/agent/build-complete — actor_metadata wiring', () => {
  it('passes per-item actor_metadata through to registerEvidence', async () => {
    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
        evidence: [
          {
            type: 'ci_result',
            source_type: 'automated',
            summary: 'CI green',
            actor_metadata: {
              client_name: 'Claude-Code',
              client_version: '1.2.3',
              model: 'Claude-Opus-4-7',
            },
          },
        ],
      }),
    );

    expect(res.status).toBe(200);
    expect(registerEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_metadata: {
          client_name: 'Claude-Code',
          client_version: '1.2.3',
          model: 'Claude-Opus-4-7',
        },
      }),
      'user_1',
    );
  });

  it('persists top-level actor_metadata on the build-summary comment (normalized)', async () => {
    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
        actor_metadata: {
          client_name: '  Cursor  ',
          client_version: '  0.42.1  ',
          model: 'Claude-Opus-4-7',
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(lastPersistedComment.value).not.toBeNull();
    expect(lastPersistedComment.value?.actor_metadata).toEqual({
      client_name: 'cursor',
      client_version: '0.42.1',
      model: 'claude-opus-4-7',
    });
    // Regression guard: the comment still carries its source/agent_name.
    expect(lastPersistedComment.value?.source).toBe('ide_agent');
    expect(lastPersistedComment.value?.agent_name).toBe('ide-agent');
  });

  it('omits actor_metadata on the build-summary comment when not provided', async () => {
    const res = await POST(
      makeReq({ case_id: 'case_1', summary: 'Build done' }),
    );

    expect(res.status).toBe(200);
    expect(lastPersistedComment.value).not.toBeNull();
    expect(lastPersistedComment.value?.actor_metadata).toBeUndefined();
  });

  it('rejects invalid top-level actor_metadata with 400 (no writes)', async () => {
    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
        // Unknown key — strict schema rejects.
        actor_metadata: { client_name: 'cursor', rogue_field: 'x' },
      }),
    );

    expect(res.status).toBe(400);
    expect(registerEvidence).not.toHaveBeenCalled();
    expect(commentsDocSet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Structural `kind` tag — replaces the dossier's temporal-pairing heuristic.
// The build-summary channel must always tag the persisted comment with
// `kind: 'build_summary'` so the dossier can locate the slot directly.
// ---------------------------------------------------------------------------

describe('POST /api/agent/build-complete — kind tag', () => {
  it("tags the persisted comment with kind: 'build_summary'", async () => {
    const res = await POST(
      makeReq({ case_id: 'case_1', summary: 'Build done' }),
    );

    expect(res.status).toBe(200);
    expect(lastPersistedComment.value).not.toBeNull();
    expect(lastPersistedComment.value?.kind).toBe('build_summary');
  });

  it('still tags the comment when actor_metadata is provided', async () => {
    const res = await POST(
      makeReq({
        case_id: 'case_1',
        summary: 'Build done',
        actor_metadata: { client_name: 'cursor', client_version: '0.42.0' },
      }),
    );

    expect(res.status).toBe(200);
    expect(lastPersistedComment.value?.kind).toBe('build_summary');
  });
});
