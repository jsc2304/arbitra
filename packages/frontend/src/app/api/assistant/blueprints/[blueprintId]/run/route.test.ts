/**
 * `POST /api/assistant/blueprints/[blueprintId]/run` — run-now. Ownership,
 * archived, and overlap rejections all come from `TaskBlueprintService.runNow`
 * (unit-tested directly in `task-blueprint-service.test.ts`); this file
 * checks only that the route authenticates, delegates with the right ids,
 * dispatches exactly when intake actually created a run, and maps the
 * service's errors to the right HTTP status.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { runNow, authenticate, scheduleAssistantRunDispatch } = vi.hoisted(() => ({
  runNow: vi.fn(),
  authenticate: vi.fn(),
  scheduleAssistantRunDispatch: vi.fn(),
}));

vi.mock('@arbitra/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arbitra/backend')>();
  return {
    ...actual,
    TaskBlueprintService: class {
      runNow = runNow;
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
            details: (error as { details?: unknown })?.details,
          },
        },
        { status: (error as { statusCode?: number })?.statusCode ?? 500 },
      ),
  };
});

vi.mock('@/lib/public-base-url', () => ({ resolveCaseShareUrl: vi.fn(() => null) }));
vi.mock('@/lib/assistant-run-dispatch', () => ({ scheduleAssistantRunDispatch }));

import { POST } from './route';

const OWNER = 'usr_owner';
const BLUEPRINT_ID = 'bp_1';

function params() {
  return { params: Promise.resolve({ blueprintId: BLUEPRINT_ID }) };
}

function runRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/assistant/blueprints/${BLUEPRINT_ID}/run`, {
    method: 'POST',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: OWNER });
});

describe('POST /api/assistant/blueprints/[blueprintId]/run', () => {
  it('runs now for the owner, dispatches the new run, and returns 201', async () => {
    runNow.mockResolvedValue({
      case: { case_id: 'case_1', status: 'open' },
      run: { run_id: 'run_1' },
      run_id: 'run_1',
      replayed: false,
    });

    const response = await POST(runRequest(), params());
    const body = await response.json();

    expect(runNow).toHaveBeenCalledWith(BLUEPRINT_ID, OWNER);
    expect(scheduleAssistantRunDispatch).toHaveBeenCalledWith(
      { case_id: 'case_1', status: 'open' },
      { run_id: 'run_1' },
    );
    expect(response.status).toBe(201);
    expect(body).toMatchObject({ case_id: 'case_1', run_id: 'run_1', replayed: false });
  });

  it('does not dispatch on a replay (run is null) and returns 200', async () => {
    runNow.mockResolvedValue({
      case: { case_id: 'case_1', status: 'open' },
      run: null,
      run_id: 'run_1',
      replayed: true,
    });

    const response = await POST(runRequest(), params());

    expect(scheduleAssistantRunDispatch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it('403s for a non-owner', async () => {
    const { ForbiddenError } = await import('@arbitra/shared');
    runNow.mockRejectedValue(new ForbiddenError('not yours'));

    const response = await POST(runRequest(), params());

    expect(response.status).toBe(403);
    expect(scheduleAssistantRunDispatch).not.toHaveBeenCalled();
  });

  it('409s on an archived blueprint', async () => {
    const { ArbitraError } = await import('@arbitra/shared');
    runNow.mockRejectedValue(new ArbitraError('archived', 'TASK_BLUEPRINT_ARCHIVED', 409));

    const response = await POST(runRequest(), params());

    expect(response.status).toBe(409);
  });

  it('409s with the existing case id when a prior occurrence overlaps, and does not dispatch', async () => {
    const { ArbitraError } = await import('@arbitra/shared');
    runNow.mockRejectedValue(
      new ArbitraError('overlap', 'TASK_BLUEPRINT_OVERLAP', 409, {
        blueprint_id: BLUEPRINT_ID,
        case_id: 'case_in_flight',
      }),
    );

    const response = await POST(runRequest(), params());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.details).toMatchObject({ case_id: 'case_in_flight' });
    expect(scheduleAssistantRunDispatch).not.toHaveBeenCalled();
  });
});
