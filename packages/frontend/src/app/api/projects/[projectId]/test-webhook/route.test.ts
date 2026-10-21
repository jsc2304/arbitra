/**
 * @file `POST /api/projects/[projectId]/test-webhook` — delivery-outcome
 * recording (spec Slice C item 4, `docs/specs/clerk-config-scheduling-chat.md`).
 * Pre-fix this route had zero test coverage and discarded the notifier's
 * result down to a bare boolean; a Test click updating
 * `notification_delivery` is a feature per the spec, not a side effect to
 * skip testing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authenticate, requireProjectAccess } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    requireProjectAccess,
    handleError: (err: unknown) => {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status });
    },
  };
});

const { projectDocGet, projectDocUpdate, sendTestMock } = vi.hoisted(() => ({
  projectDocGet: vi.fn(),
  projectDocUpdate: vi.fn(),
  sendTestMock: vi.fn(),
}));

vi.mock('@arbitra/backend', async (importOriginal) => {
  const original = await importOriginal<typeof import('@arbitra/backend')>();
  return {
    ...original,
    collections: {
      projects: () => ({
        doc: () => ({
          get: projectDocGet,
          update: projectDocUpdate,
        }),
      }),
    },
    GoogleChatNotifier: class {
      sendTest = sendTestMock;
    },
  };
});

import { POST } from './route';

const params = { params: Promise.resolve({ projectId: 'proj_1' }) };

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/projects/proj_1/test-webhook', { method: 'POST' });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireProjectAccess.mockResolvedValue(null);
  projectDocGet.mockResolvedValue({
    exists: true,
    data: () => ({
      project_id: 'proj_1',
      notification_webhook_url: 'https://chat.googleapis.com/v1/spaces/x/messages?key=y',
    }),
  });
  projectDocUpdate.mockResolvedValue(undefined);
});

describe('POST /api/projects/[projectId]/test-webhook — delivery-outcome recording', () => {
  it('records last_success_at when the test send succeeds', async () => {
    sendTestMock.mockResolvedValue({ ok: true, status: 200, attempts: 1 });

    const res = await POST(makeReq(), params);

    expect(res.status).toBe(200);
    expect(projectDocUpdate).toHaveBeenCalledTimes(1);
    const written = projectDocUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect(typeof written['notification_delivery.last_success_at']).toBe('string');
    expect(written['notification_delivery.last_error']).toBeUndefined();
  });

  it('records last_error (code + message) and 502s when the test send fails after retries', async () => {
    sendTestMock.mockResolvedValue({ ok: false, status: 500, error: 'boom', attempts: 2 });

    const res = await POST(makeReq(), params);

    expect(res.status).toBe(502);
    expect(projectDocUpdate).toHaveBeenCalledTimes(1);
    const written = projectDocUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect(written['notification_delivery.last_success_at']).toBeUndefined();
    expect(written['notification_delivery.last_error']).toMatchObject({ code: '500', message: 'boom' });
  });

  it('a delivery-outcome write failure never breaks the response (fire-and-forget)', async () => {
    sendTestMock.mockResolvedValue({ ok: true, status: 200, attempts: 1 });
    projectDocUpdate.mockRejectedValueOnce(new Error('Firestore unavailable'));

    const res = await POST(makeReq(), params);

    // The test SEND itself succeeded — the recording failure must not
    // downgrade this to an error response.
    expect(res.status).toBe(200);
  });

  it('does not call the notifier or record anything when no webhook is configured', async () => {
    projectDocGet.mockResolvedValue({ exists: true, data: () => ({ project_id: 'proj_1' }) });

    const res = await POST(makeReq(), params);

    expect(res.status).toBe(400);
    expect(sendTestMock).not.toHaveBeenCalled();
    expect(projectDocUpdate).not.toHaveBeenCalled();
  });
});
