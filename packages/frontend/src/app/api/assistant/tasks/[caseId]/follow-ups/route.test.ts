import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { intakeFollowUp, dispatch } = vi.hoisted(() => ({
  intakeFollowUp: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  AssistantIntakeService: class {
    intakeFollowUp = intakeFollowUp;
  },
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T => schema.parse(body),
}));

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock('@/lib/api-helpers', () => ({
  authenticate,
  handleError: (error: unknown) => {
    const validation = error instanceof Error && 'issues' in error;
    return NextResponse.json({ error: { message: 'failed' } }, { status: validation ? 400 : 500 });
  },
}));
vi.mock('@/lib/public-base-url', () => ({ resolveCaseShareUrl: vi.fn(() => null) }));
vi.mock('@/lib/assistant-run-dispatch', () => ({ scheduleAssistantRunDispatch: dispatch }));

import { POST } from './route';

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/assistant/tasks/case_parent/follow-ups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_requester' });
  intakeFollowUp.mockResolvedValue({
    case: { case_id: 'case_child', status: 'open' },
    run: { run_id: 'run_child', case_id: 'case_child' },
    run_id: 'run_child',
    event_id: 'event_child',
    replayed: false,
  });
});

describe('POST /api/assistant/tasks/:caseId/follow-ups', () => {
  it('accepts only text and a mandatory idempotency key', async () => {
    const missing = await POST(request({ text: 'continue' }), {
      params: Promise.resolve({ caseId: 'case_parent' }),
    });
    const forged = await POST(request({
      text: 'continue',
      idempotency_key: 'turn-2',
      parent_case_id: 'case_forged',
    }), { params: Promise.resolve({ caseId: 'case_parent' }) });

    expect(missing.status).toBe(400);
    expect(forged.status).toBe(400);
    expect(intakeFollowUp).not.toHaveBeenCalled();
  });

  it('lets the service derive every provenance field and dispatches the child', async () => {
    const response = await POST(request({ text: 'continue', idempotency_key: 'turn-2' }), {
      params: Promise.resolve({ caseId: 'case_parent' }),
    });

    expect(response.status).toBe(201);
    expect(intakeFollowUp).toHaveBeenCalledWith(
      { text: 'continue', idempotency_key: 'turn-2' },
      'usr_requester',
      'case_parent',
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ case_id: 'case_child' }),
      expect.objectContaining({ run_id: 'run_child' }),
    );
  });

  it('returns a replay without dispatching a second Run', async () => {
    intakeFollowUp.mockResolvedValueOnce({
      case: { case_id: 'case_child', status: 'done' },
      run: null,
      run_id: 'run_child',
      event_id: 'event_child',
      replayed: true,
    });

    const response = await POST(request({ text: 'continue', idempotency_key: 'turn-2' }), {
      params: Promise.resolve({ caseId: 'case_parent' }),
    });

    expect(response.status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
