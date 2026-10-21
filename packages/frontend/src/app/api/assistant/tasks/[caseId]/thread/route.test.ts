import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getThread, authenticate } = vi.hoisted(() => ({
  getThread: vi.fn(),
  authenticate: vi.fn(),
}));
vi.mock('@arbitra/backend', () => ({
  AssistantFollowUpService: class {
    getThread = getThread;
  },
}));
vi.mock('@/lib/api-helpers', () => ({
  authenticate,
  handleError: (error: unknown) => { throw error; },
}));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_requester' });
  getThread.mockResolvedValue({ root_case_id: 'case_root', turns: [] });
});

describe('GET /api/assistant/tasks/:caseId/thread', () => {
  it('scopes the dedicated thread read to the authenticated requester', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/assistant/tasks/case_child/thread'),
      { params: Promise.resolve({ caseId: 'case_child' }) },
    );

    expect(getThread).toHaveBeenCalledWith('case_child', 'usr_requester');
    expect(await response.json()).toEqual({ root_case_id: 'case_root', turns: [] });
  });
});
