import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { registerEvidence, safeHeartbeat } = vi.hoisted(() => ({
  registerEvidence: vi.fn(),
  safeHeartbeat: vi.fn(),
}));

const pipelineAdapterInstances: unknown[] = [];

vi.mock('@arbitra/backend', () => ({
  EvidenceService: class {
    constructor(
      _repo?: unknown,
      _evaluator?: unknown,
      _eventService?: unknown,
      _caseRepo?: unknown,
      public readonly pipelineAdapter?: unknown,
    ) {}

    registerEvidence = registerEvidence;
  },
  FirestorePipelineAdapter: class {
    constructor() {
      pipelineAdapterInstances.push(this);
    }
  },
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T =>
    schema.parse(body),
  safeHeartbeat,
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

vi.mock('@/lib/api-helpers', async () => ({
  authenticate,
  requireCaseAccess,
  handleError: (error: unknown) => {
    const isValidation = error instanceof Error && 'issues' in error;
    return NextResponse.json(
      {
        error: {
          code: isValidation ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
          details: isValidation
            ? { issues: (error as Error & { issues: unknown[] }).issues }
            : undefined,
        },
      },
      { status: isValidation ? 400 : 500 },
    );
  },
}));

import { POST } from './route';

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/cases/case_1/evidence', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  pipelineAdapterInstances.length = 0;
  authenticate.mockResolvedValue({ userId: 'user_1', authType: 'firebase' });
  requireCaseAccess.mockResolvedValue(null);
  safeHeartbeat.mockResolvedValue(undefined);
  registerEvidence.mockResolvedValue({
    evidence_id: 'evidence_1',
    case_id: 'case_1',
    type: 'ci_result',
    source_type: 'automated',
    summary: 'CI green',
    created_by: 'user_1',
    validation_track: 'direct',
    created_at: '2026-04-21T10:00:00Z',
  });
});

describe('POST /api/cases/:caseId/evidence', () => {
  it('returns structured validation errors for invalid evidence payloads', async () => {
    const response = await POST(
      makeReq({ type: 'ci_result' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const issuePaths = body.error.details.issues.map((issue: { path: unknown[] }) => issue.path.join('.'));
    expect(issuePaths).toContain('source_type');
    expect(registerEvidence).not.toHaveBeenCalled();
  });

  it('injects the route caseId and registers evidence via a pipeline-aware service', async () => {
    const response = await POST(
      makeReq({
        type: 'ci_result',
        source_type: 'automated',
        summary: 'CI green',
      }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(response.status).toBe(201);
    expect(registerEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        case_id: 'case_1',
        type: 'ci_result',
        source_type: 'automated',
        summary: 'CI green',
      }),
      'user_1',
    );
    expect(pipelineAdapterInstances).toHaveLength(1);
  });

  it('writes a presence heartbeat with source mapped from authType', async () => {
    await POST(
      makeReq({ type: 'ci_result', source_type: 'automated', summary: 'CI green' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );
    expect(safeHeartbeat).toHaveBeenCalledWith({
      caseId: 'case_1',
      userId: 'user_1',
      source: 'web',
    });

    safeHeartbeat.mockClear();
    authenticate.mockResolvedValue({ userId: 'user_1', authType: 'token' });

    await POST(
      makeReq({ type: 'ci_result', source_type: 'automated', summary: 'CI green' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );
    expect(safeHeartbeat).toHaveBeenCalledWith({
      caseId: 'case_1',
      userId: 'user_1',
      source: 'ide_agent',
    });
  });
});
