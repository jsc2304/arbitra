import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { TransitionError } from '@arbitra/shared';

const {
  transition,
  getCase,
  assertBranchUniqueForCase,
  onRunCompleted,
  safeHeartbeat,
} = vi.hoisted(() => ({
  transition: vi.fn(),
  getCase: vi.fn(),
  assertBranchUniqueForCase: vi.fn(),
  onRunCompleted: vi.fn(),
  safeHeartbeat: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  OrchestrationService: class {
    transition = transition;
  },
  CaseService: class {
    getCase = getCase;
  },
  FirestorePipelineAdapter: class {},
  RunCompletionHandler: class {
    onRunCompleted = onRunCompleted;
  },
  assertBranchUniqueForCase,
  safeHeartbeat,
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T =>
    schema.parse(body),
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
  return new NextRequest('http://localhost/api/cases/case_1/transition', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockReset();
  requireCaseAccess.mockReset();
  transition.mockReset();
  getCase.mockReset();
  assertBranchUniqueForCase.mockReset();
  onRunCompleted.mockReset();
  authenticate.mockResolvedValue({ userId: 'user_1', authType: 'firebase' });
  requireCaseAccess.mockResolvedValue(null);
  assertBranchUniqueForCase.mockResolvedValue(undefined);
  safeHeartbeat.mockResolvedValue(undefined);
  transition.mockResolvedValue({ case_id: 'case_1', status: 'approved' });
  onRunCompleted.mockResolvedValue(undefined);
  getCase
    .mockResolvedValueOnce({
      case_id: 'case_1',
      status: 'in_review',
      repository_id: 'repo_1',
      current_branch: 'feat/case-1',
    })
    .mockResolvedValueOnce({
      case_id: 'case_1',
      status: 'approved',
      repository_id: 'repo_1',
      current_branch: 'feat/case-1',
    });
});

describe('POST /api/cases/:caseId/transition', () => {
  it('returns structured validation errors for invalid request bodies', async () => {
    const response = await POST(
      makeReq({}),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const issuePaths = body.error.details.issues.map((issue: { path: unknown[] }) => issue.path.join('.'));
    expect(issuePaths).toContain('target_status');
    expect(transition).not.toHaveBeenCalled();
  });

  it('returns the current case for idempotent transitions and skips orchestration', async () => {
    getCase.mockReset();
    getCase.mockResolvedValue({
      case_id: 'case_1',
      status: 'in_review',
      repository_id: 'repo_1',
      current_branch: 'feat/case-1',
    });

    const response = await POST(
      makeReq({ target_status: 'in_review' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('in_review');
    expect(transition).not.toHaveBeenCalled();
    expect(onRunCompleted).not.toHaveBeenCalled();
  });

  it('returns BRANCH_CONFLICT when in_build transition hits an occupied branch', async () => {
    const error = Object.assign(new Error('Branch already claimed'), {
      code: 'BRANCH_CONFLICT',
      details: { branch: 'feat/case-1', conflicting_case_id: 'case_2' },
    });
    getCase.mockReset();
    getCase.mockResolvedValue({
      case_id: 'case_1',
      status: 'ready_for_build',
      repository_id: 'repo_1',
      current_branch: 'feat/case-1',
    });
    assertBranchUniqueForCase.mockRejectedValueOnce(error);

    const response = await POST(
      makeReq({ target_status: 'in_build' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe('BRANCH_CONFLICT');
    expect(body.error.details.conflicting_case_id).toBe('case_2');
    expect(transition).not.toHaveBeenCalled();
  });

  it('returns INVALID_CASE_TRANSITION details for failed preconditions', async () => {
    transition.mockRejectedValueOnce(new TransitionError(
      'in_review',
      'approved',
      [{ id: 'review_run_completed', reason: 'No completed review run found' }],
    ));

    const response = await POST(
      makeReq({ target_status: 'approved' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_CASE_TRANSITION');
    expect(body.error.failed_preconditions).toEqual([
      { id: 'review_run_completed', reason: 'No completed review run found' },
    ]);
    expect(body.error.valid_targets).toContain('approved');
  });

  it('writes a presence heartbeat with source=web for firebase auth', async () => {
    await POST(
      makeReq({ target_status: 'approved' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(safeHeartbeat).toHaveBeenCalledWith({
      caseId: 'case_1',
      userId: 'user_1',
      source: 'web',
    });
  });

  it('writes a presence heartbeat with source=ide_agent for token auth', async () => {
    authenticate.mockResolvedValue({ userId: 'user_1', authType: 'token' });

    await POST(
      makeReq({ target_status: 'approved' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(safeHeartbeat).toHaveBeenCalledWith({
      caseId: 'case_1',
      userId: 'user_1',
      source: 'ide_agent',
    });
  });

  it('runs the pipeline after successful non-in_build transitions and returns the refreshed case', async () => {
    const response = await POST(
      makeReq({ target_status: 'approved' }),
      { params: Promise.resolve({ caseId: 'case_1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('approved');
    expect(transition).toHaveBeenCalledWith('case_1', 'approved', 'user_1');
    expect(onRunCompleted).toHaveBeenCalledWith('case_1');
  });
});
