/**
 * @file `POST /api/users/me/test-chat-webhook` — Slice D
 * (`docs/specs/clerk-config-scheduling-chat.md`) mirror of
 * `POST /api/projects/[projectId]/test-webhook`'s delivery-outcome
 * recording, scoped to the caller's own `notification_chat_webhook`/
 * `notification_chat_delivery` instead of a project's. Did not exist
 * before this PR.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authenticate } = vi.hoisted(() => ({
  authenticate: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    handleError: (err: unknown) => {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status });
    },
  };
});

const { userDocGet, userDocUpdate, sendTestMock } = vi.hoisted(() => ({
  userDocGet: vi.fn(),
  userDocUpdate: vi.fn(),
  sendTestMock: vi.fn(),
}));

const docSpy = vi.hoisted(() => vi.fn());

vi.mock('@arbitra/backend', async (importOriginal) => {
  const original = await importOriginal<typeof import('@arbitra/backend')>();
  return {
    ...original,
    collections: {
      users: () => ({
        doc: (userId: string) => {
          docSpy(userId);
          return { get: userDocGet, update: userDocUpdate };
        },
      }),
    },
    GoogleChatNotifier: class {
      sendTest = sendTestMock;
    },
  };
});

import { POST } from './route';

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/users/me/test-chat-webhook', { method: 'POST' });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_caller', email: 'caller@example.com' });
  userDocGet.mockResolvedValue({
    exists: true,
    data: () => ({
      user_id: 'usr_caller',
      notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x',
    }),
  });
  userDocUpdate.mockResolvedValue(undefined);
});

describe('POST /api/users/me/test-chat-webhook — delivery-outcome recording', () => {
  it('records last_success_at on the CALLER doc when the test send succeeds', async () => {
    sendTestMock.mockResolvedValue({ ok: true, status: 200, attempts: 1 });

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(docSpy).toHaveBeenCalledWith('usr_caller');
    expect(userDocUpdate).toHaveBeenCalledTimes(1);
    const written = userDocUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect(typeof written['notification_chat_delivery.last_success_at']).toBe('string');
    expect(written['notification_chat_delivery.last_error']).toBeUndefined();
  });

  it('records last_error (code + message) and 502s when the test send fails after retries', async () => {
    sendTestMock.mockResolvedValue({ ok: false, status: 500, error: 'boom', attempts: 2 });

    const res = await POST(makeReq());

    expect(res.status).toBe(502);
    const written = userDocUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect(written['notification_chat_delivery.last_success_at']).toBeUndefined();
    expect(written['notification_chat_delivery.last_error']).toMatchObject({ code: '500', message: 'boom' });
  });

  it('a delivery-outcome write failure never breaks the response (fire-and-forget on the recording write)', async () => {
    sendTestMock.mockResolvedValue({ ok: true, status: 200, attempts: 1 });
    userDocUpdate.mockRejectedValueOnce(new Error('Firestore unavailable'));

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
  });

  it('400s and never calls the notifier when the caller has no chat webhook configured', async () => {
    userDocGet.mockResolvedValue({ exists: true, data: () => ({ user_id: 'usr_caller' }) });

    const res = await POST(makeReq());

    expect(res.status).toBe(400);
    expect(sendTestMock).not.toHaveBeenCalled();
    expect(userDocUpdate).not.toHaveBeenCalled();
  });

  it('404s when the caller has no user document', async () => {
    userDocGet.mockResolvedValue({ exists: false });

    const res = await POST(makeReq());

    expect(res.status).toBe(404);
    expect(sendTestMock).not.toHaveBeenCalled();
  });

  it('only ever reads/writes the authenticated caller — no project or other-user id anywhere in this route', async () => {
    sendTestMock.mockResolvedValue({ ok: true, status: 200, attempts: 1 });
    authenticate.mockResolvedValue({ userId: 'usr_other', email: 'other@example.com' });
    userDocGet.mockResolvedValue({
      exists: true,
      data: () => ({ user_id: 'usr_other', notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/BBB/messages' }),
    });

    await POST(makeReq());

    expect(docSpy).toHaveBeenCalledWith('usr_other');
    expect(docSpy).not.toHaveBeenCalledWith('usr_caller');
  });
});
