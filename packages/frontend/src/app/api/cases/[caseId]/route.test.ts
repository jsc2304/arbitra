import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  getCase,
  updateCase,
  loadPreconditionContext,
  evaluate,
  createPreconditionEvaluator,
  caseEventsGet,
} = vi.hoisted(() => ({
  getCase: vi.fn(),
  updateCase: vi.fn(),
  loadPreconditionContext: vi.fn(),
  evaluate: vi.fn(),
  createPreconditionEvaluator: vi.fn(),
  caseEventsGet: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  CaseService: class {
    getCase = getCase;
    updateCase = updateCase;
  },
  FirestorePipelineAdapter: class {
    loadPreconditionContext = loadPreconditionContext;
  },
  createPreconditionEvaluator,
  collections: {
    caseEvents: () => ({
      where: () => ({
        get: caseEventsGet,
      }),
    }),
  },
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T =>
    schema.parse(body),
}));

function eventsSnap(events: unknown[]): { docs: { data: () => unknown }[] } {
  return { docs: events.map((e) => ({ data: () => e })) };
}

const NO_DIFF_PIPELINE_COMMENT = {
  type: 'comment_added',
  actor_id: 'system:pipeline',
  payload: {
    body: 'Auto-review could not start after 3 attempts: Diff could not be fetched from GitHub',
  },
};

const { authenticate, requireCaseAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireCaseAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => ({
  authenticate,
  requireCaseAccess,
  handleError: (error: unknown) => {
    // Mirrors formatError's precedence (packages/backend/src/middleware/error-handler.ts):
    // an ArbitraError (e.g. ValidationError, which carries `code`/`statusCode`)
    // takes priority over the generic 500 fallback. Kept in step with the
    // equivalent mock in ../route.test.ts (POST /api/cases).
    const isArbitraError = error instanceof Error && 'statusCode' in error && 'code' in error;
    const code = isArbitraError ? (error as Error & { code: string }).code : 'INTERNAL_ERROR';
    const status = isArbitraError ? (error as Error & { statusCode: number }).statusCode : 500;
    return NextResponse.json(
      {
        error: {
          code,
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status },
    );
  },
}));

vi.mock('@/lib/public-base-url', () => ({
  resolveCaseShareUrl: () => undefined,
}));

import { GET, PATCH } from './route';

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/cases/case_1', { method: 'GET' });
}

function makePatchReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/cases/case_1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const baseStaleCase = {
  case_id: 'case_1',
  status: 'in_review' as const,
  review_not_applicable: false,
  // Three exhausted diff_fetch retries on the case wouldn't show as a property —
  // they live in the runs collection. The route doesn't inspect them; the
  // adapter does. We only need to assert the heal pass was scheduled.
};

/**
 * The heal pass is fire-and-forget via Promise.resolve().then(...). Awaiting
 * a microtask flush via Promise.resolve() twice lets the queued continuation
 * run before assertions. We also flush any pending dynamic imports.
 */
async function flushHealPass(): Promise<void> {
  // Yield repeatedly so the queued .then() begins, the cheap pre-check's
  // dynamic import + Firestore query resolve, and then the precondition
  // fan-out's dynamic import and async chain progress.
  for (let i = 0; i < 16; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1', authType: 'firebase' });
  requireCaseAccess.mockResolvedValue(null);
  loadPreconditionContext.mockResolvedValue({ case_: baseStaleCase });
  createPreconditionEvaluator.mockReturnValue({ evaluate });
  evaluate.mockResolvedValue({ satisfied: true });
  // Default: case carries the no-diff pipeline comment, so the heal runs.
  caseEventsGet.mockResolvedValue(eventsSnap([NO_DIFF_PIPELINE_COMMENT]));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/cases/:caseId', () => {
  it('triggers the review_not_applicable heal pass for a stale in_review case', async () => {
    getCase.mockResolvedValue(baseStaleCase);

    const response = await GET(makeReq(), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.case_id).toBe('case_1');
    expect(body.status).toBe('in_review');

    await flushHealPass();

    expect(loadPreconditionContext).toHaveBeenCalledTimes(1);
    expect(loadPreconditionContext).toHaveBeenCalledWith(baseStaleCase);
    expect(createPreconditionEvaluator).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith('review_run_completed');
  });

  it('skips the heal pass when review_not_applicable is already true', async () => {
    const healed = { ...baseStaleCase, review_not_applicable: true };
    getCase.mockResolvedValue(healed);

    const response = await GET(makeReq(), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_not_applicable).toBe(true);

    await flushHealPass();

    expect(loadPreconditionContext).not.toHaveBeenCalled();
    expect(createPreconditionEvaluator).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('skips the heal pass for terminal statuses (done)', async () => {
    const terminal = { ...baseStaleCase, status: 'done' as const };
    getCase.mockResolvedValue(terminal);

    const response = await GET(makeReq(), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('done');

    await flushHealPass();

    expect(loadPreconditionContext).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('skips the heal pass for terminal statuses (rejected)', async () => {
    const terminal = { ...baseStaleCase, status: 'rejected' as const };
    getCase.mockResolvedValue(terminal);

    const response = await GET(makeReq(), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(response.status).toBe(200);

    await flushHealPass();

    expect(loadPreconditionContext).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('skips the precondition fan-out when no no-diff pipeline comment exists (healthy long-dwell case)', async () => {
    // Simulates a healthy long-dwell case (e.g. needs_human_decision) on the
    // 1.5s SWR poll: events collection has no system:pipeline failure comment,
    // so the cheap pre-check short-circuits before the 6-query
    // loadPreconditionContext fan-out runs. See follow-up #92.
    getCase.mockResolvedValue(baseStaleCase);
    caseEventsGet.mockResolvedValue(
      eventsSnap([
        // Unrelated user comment — must not trip the heal.
        { type: 'comment_added', actor_id: 'user_42', payload: { body: 'lgtm' } },
        // Pipeline event of a different type — must not trip the heal.
        { type: 'review_run_completed', actor_id: 'system:pipeline', payload: {} },
      ]),
    );

    const response = await GET(makeReq(), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(response.status).toBe(200);

    await flushHealPass();

    expect(caseEventsGet).toHaveBeenCalledTimes(1);
    expect(loadPreconditionContext).not.toHaveBeenCalled();
    expect(createPreconditionEvaluator).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('runs the precondition fan-out when the no-diff pipeline comment is present', async () => {
    getCase.mockResolvedValue(baseStaleCase);
    caseEventsGet.mockResolvedValue(eventsSnap([NO_DIFF_PIPELINE_COMMENT]));

    const response = await GET(makeReq(), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(response.status).toBe(200);

    await flushHealPass();

    expect(caseEventsGet).toHaveBeenCalledTimes(1);
    expect(loadPreconditionContext).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith('review_run_completed');
  });

  it('returns 200 with case data even when the heal pass throws (graceful degradation)', async () => {
    getCase.mockResolvedValue(baseStaleCase);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadPreconditionContext.mockRejectedValue(new Error('firestore offline'));

    const response = await GET(makeReq(), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.case_id).toBe('case_1');

    await flushHealPass();

    expect(loadPreconditionContext).toHaveBeenCalledTimes(1);
    // Heal failure must be swallowed and logged via console.warn.
    expect(warnSpy).toHaveBeenCalled();
    const firstCall = warnSpy.mock.calls[0];
    expect(String(firstCall?.[0])).toContain('case_1');

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// #1030 — PR #1026 guarded POST /api/cases against the internal-only case
// types (`observed`, `assistant_task`) but left PATCH /api/cases/:id
// unguarded. The equivalent guard on update lives inside
// `CaseService.updateCase` (packages/backend/src/services/case/
// case-service.ts) rather than in this route, because it has to diff
// against the case's *existing* case_type — a plain value guard here would
// reject an edit-modal save that resubmits an already-`observed` case's
// unchanged case_type (see the #1040 review follow-up). `CaseService` is
// mocked in this file, so these tests only cover the route's pass-through
// behavior — the guard's own transition logic is covered directly in
// packages/backend/src/services/case/case-service.internal-case-type-guard.test.ts.
// ---------------------------------------------------------------------------
describe('PATCH /api/cases/:caseId', () => {
  beforeEach(() => {
    updateCase.mockResolvedValue({ case_id: 'case_1', status: 'open', case_type: 'bugfix' });
  });

  it('propagates a ValidationError thrown by CaseService.updateCase as a 400', async () => {
    const { ValidationError } = await import('@arbitra/shared');
    updateCase.mockRejectedValueOnce(
      new ValidationError(
        "case_type 'observed' is system-created only and cannot be set via this endpoint",
        { case_type: 'observed' },
      ),
    );

    const response = await PATCH(makePatchReq({ case_type: 'observed' }), {
      params: Promise.resolve({ caseId: 'case_1' }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.message).toContain('observed');
    expect(updateCase).toHaveBeenCalledWith(
      'case_1',
      expect.objectContaining({ case_type: 'observed' }),
      'user_1',
    );
  });

  it('still updates the case for a regular, publicly-settable case_type', async () => {
    const response = await PATCH(makePatchReq({ case_type: 'refactoring' }), {
      params: Promise.resolve({ caseId: 'case_1' }),
    });

    expect(response.status).toBe(200);
    expect(updateCase).toHaveBeenCalledWith(
      'case_1',
      expect.objectContaining({ case_type: 'refactoring' }),
      'user_1',
    );
  });

  it('still updates the case when case_type is omitted', async () => {
    const response = await PATCH(makePatchReq({ title: 'New title' }), {
      params: Promise.resolve({ caseId: 'case_1' }),
    });

    expect(response.status).toBe(200);
    expect(updateCase).toHaveBeenCalledWith(
      'case_1',
      expect.objectContaining({ title: 'New title' }),
      'user_1',
    );
  });

  it('returns 404 and does not update when the caller lacks case access', async () => {
    requireCaseAccess.mockResolvedValueOnce(
      NextResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
    );

    const response = await PATCH(makePatchReq({ title: 'New title' }), {
      params: Promise.resolve({ caseId: 'case_1' }),
    });

    expect(response.status).toBe(404);
    expect(updateCase).not.toHaveBeenCalled();
  });
});
