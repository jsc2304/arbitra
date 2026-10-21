import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { get, record } = vi.hoisted(() => ({ get: vi.fn(), record: vi.fn() }));

vi.mock('@arbitra/backend', () => ({
  AssistantFeedbackService: class { get = get; record = record; },
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T => schema.parse(body),
}));

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock('@/lib/api-helpers', () => ({
  authenticate,
  handleError: (error: unknown) => NextResponse.json(
    { error: { message: error instanceof Error ? error.message : 'failed' } },
    { status: error instanceof Error && 'issues' in error ? 400 : 500 },
  ),
}));

import { GET, PUT } from './route';

const context = { params: Promise.resolve({ caseId: 'case_answer' }) };
function request(method: 'GET' | 'PUT', body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/assistant/tasks/case_answer/feedback', {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_requester' });
  get.mockResolvedValue(null);
  record.mockResolvedValue({ feedback: { feedback_id: 'case_answer' }, replayed: false });
});

describe('/api/assistant/tasks/:caseId/feedback', () => {
  it('reads feedback through the service authorization boundary', async () => {
    const response = await GET(request('GET'), context);
    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith('case_answer', 'usr_requester');
    await expect(response.json()).resolves.toEqual({ feedback: null });
  });

  it('accepts only a rating and mandatory human reason', async () => {
    const blank = await PUT(request('PUT', { rating: 'useful', reason: '  ' }), context);
    const forged = await PUT(request('PUT', {
      rating: 'useful',
      reason: 'Good.',
      requester_user_id: 'usr_forged',
    }), context);

    expect(blank.status).toBe(400);
    expect(forged.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it('passes the trimmed judgement and no provenance fields to the service', async () => {
    const response = await PUT(request('PUT', {
      rating: 'not_useful',
      reason: '  It missed the total.  ',
    }), context);

    expect(response.status).toBe(200);
    expect(record).toHaveBeenCalledWith('case_answer', 'usr_requester', {
      rating: 'not_useful',
      reason: 'It missed the total.',
    });
  });
});
