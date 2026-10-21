/**
 * @file `PATCH /api/users/me` — self-only, multi-field profile updates.
 * Pre-Slice-D this route only patched `custom_avatar_url`; Slice D
 * (`docs/specs/clerk-config-scheduling-chat.md`) added
 * `notification_chat_webhook`, and the chat DM conversation-window feature
 * adds `chat_conversation_window` — all three independently optional. This
 * suite covers each field's validation, null/empty clearing where
 * applicable, that the route always targets `auth.userId` regardless of
 * body content (no other-user write path exists here), and that the
 * pre-existing avatar behavior survives the field becoming optional in the
 * schema.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authenticate } = vi.hoisted(() => ({
  authenticate: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  const { formatValidationIssues } = await import('@arbitra/backend');
  return {
    authenticate,
    handleError: (err: unknown) => {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status });
    },
    validationErrorResponse: (message: string, issues: unknown) =>
      NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message, details: { issues: formatValidationIssues(issues as never) } } },
        { status: 400 },
      ),
  };
});

const { userDocGet, userDocUpdate } = vi.hoisted(() => ({
  userDocGet: vi.fn(),
  userDocUpdate: vi.fn(),
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
  };
});

import { PATCH } from './route';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/users/me', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_caller', email: 'caller@example.com' });
  userDocGet.mockImplementation(async () => ({
    exists: true,
    data: () => ({ user_id: 'usr_caller', email: 'caller@example.com', display_name: 'Caller', roles: ['developer'] }),
  }));
  userDocUpdate.mockResolvedValue(undefined);
});

describe('PATCH /api/users/me — no updatable fields', () => {
  it('400s when both custom_avatar_url and notification_chat_webhook are absent', async () => {
    const res = await PATCH(makeReq({}));
    expect(res.status).toBe(400);
    expect(userDocUpdate).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/users/me — notification_chat_webhook validation + null-clear', () => {
  it('accepts a valid https://chat.googleapis.com/ URL and persists it', async () => {
    const res = await PATCH(makeReq({ notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x' }));

    expect(res.status).toBe(200);
    expect(userDocUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x' }),
    );
  });

  it('rejects a non-Google-Chat https URL with 400', async () => {
    // Reverting to an unchecked `z.string().url()` (or no schema at all)
    // would let this through.
    const res = await PATCH(makeReq({ notification_chat_webhook: 'https://evil.example.com/hook' }));

    expect(res.status).toBe(400);
    expect(userDocUpdate).not.toHaveBeenCalled();
  });

  it('rejects a plain http:// URL with 400', async () => {
    const res = await PATCH(makeReq({ notification_chat_webhook: 'http://chat.googleapis.com/v1/spaces/AAA/messages' }));

    expect(res.status).toBe(400);
    expect(userDocUpdate).not.toHaveBeenCalled();
  });

  it('clears the webhook via FieldValue.delete() when given null', async () => {
    const res = await PATCH(makeReq({ notification_chat_webhook: null }));

    expect(res.status).toBe(200);
    const written = userDocUpdate.mock.calls[0]![0] as Record<string, unknown>;
    // FieldValue.delete() sentinel — not the literal string 'null' or undefined.
    expect(written.notification_chat_webhook).toBeDefined();
    expect(typeof written.notification_chat_webhook).not.toBe('string');
  });

  it('clears the webhook when given an empty string, identically to null', async () => {
    const res = await PATCH(makeReq({ notification_chat_webhook: '' }));

    expect(res.status).toBe(200);
    const written = userDocUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect(typeof written.notification_chat_webhook).not.toBe('string');
  });

  it('rejects a non-string, non-null value (e.g. a number) with 400', async () => {
    const res = await PATCH(makeReq({ notification_chat_webhook: 42 }));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/users/me — custom_avatar_url stays independently optional', () => {
  it('updating only notification_chat_webhook leaves custom_avatar_url untouched', async () => {
    const res = await PATCH(makeReq({ notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages' }));

    expect(res.status).toBe(200);
    const written = userDocUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect('custom_avatar_url' in written).toBe(false);
  });

  it('updating only custom_avatar_url leaves notification_chat_webhook untouched', async () => {
    const res = await PATCH(makeReq({ custom_avatar_url: 'https://cdn.example.com/me.png' }));

    expect(res.status).toBe(200);
    const written = userDocUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect('notification_chat_webhook' in written).toBe(false);
    expect(written.custom_avatar_url).toBe('https://cdn.example.com/me.png');
  });

  it('rejects an invalid custom_avatar_url exactly as before (http://)', async () => {
    const res = await PATCH(makeReq({ custom_avatar_url: 'http://cdn.example.com/me.png' }));
    expect(res.status).toBe(400);
    expect(userDocUpdate).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/users/me — chat_conversation_window validation + persistence', () => {
  // Regression coverage for the bug where this route 400'd on exactly this
  // body shape (only `chat_conversation_window`, no avatar/webhook field) —
  // reverting the route's destructuring/validation block back to just
  // `custom_avatar_url`/`notification_chat_webhook` makes this 400 again.
  it('accepts a PATCH carrying only chat_conversation_window and persists it', async () => {
    const res = await PATCH(makeReq({ chat_conversation_window: 'daily' }));

    expect(res.status).toBe(200);
    expect(userDocUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ chat_conversation_window: 'daily' }),
    );
  });

  it('rejects a value outside the closed CHAT_CONVERSATION_WINDOWS set with 400', async () => {
    const res = await PATCH(makeReq({ chat_conversation_window: 'weekly' }));
    const responseBody = await res.json();

    expect(res.status).toBe(400);
    // Pins the specific rejection reason, not just the status code — a
    // route that doesn't recognize this field at all also 400s (with "No
    // updatable fields provided"), which would make a status-only
    // assertion pass for the wrong reason.
    expect(responseBody.error.message).toBe('Invalid chat_conversation_window');
    expect(userDocUpdate).not.toHaveBeenCalled();
  });

  it('rejects a non-string value (e.g. a number) with 400', async () => {
    const res = await PATCH(makeReq({ chat_conversation_window: 42 }));
    const responseBody = await res.json();

    expect(res.status).toBe(400);
    expect(responseBody.error.message).toBe('Invalid chat_conversation_window');
    expect(userDocUpdate).not.toHaveBeenCalled();
  });

  it('accepts every member of the closed set', async () => {
    for (const value of ['continuous', 'daily', 'idle_gap', 'per_message']) {
      userDocUpdate.mockClear();
      const res = await PATCH(makeReq({ chat_conversation_window: value }));
      expect(res.status).toBe(200);
      expect(userDocUpdate).toHaveBeenCalledWith(expect.objectContaining({ chat_conversation_window: value }));
    }
  });

  it('updating only chat_conversation_window leaves the other fields untouched', async () => {
    const res = await PATCH(makeReq({ chat_conversation_window: 'idle_gap' }));

    expect(res.status).toBe(200);
    const written = userDocUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect('custom_avatar_url' in written).toBe(false);
    expect('notification_chat_webhook' in written).toBe(false);
  });

  it('always targets auth.userId — cannot be redirected to another user via the body', async () => {
    await PATCH(makeReq({ user_id: 'usr_someone_else', chat_conversation_window: 'daily' }));

    expect(docSpy).toHaveBeenCalledWith('usr_caller');
    expect(docSpy).not.toHaveBeenCalledWith('usr_someone_else');
  });
});

describe('PATCH /api/users/me — self-only, server-owned fields untouched', () => {
  it('always targets auth.userId, never a user_id/userId smuggled in the body', async () => {
    // The route has no target-user parameter at all; this pins that even a
    // body carrying a DIFFERENT user_id cannot redirect the write.
    await PATCH(makeReq({ user_id: 'usr_someone_else', notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages' }));

    expect(docSpy).toHaveBeenCalledWith('usr_caller');
    expect(docSpy).not.toHaveBeenCalledWith('usr_someone_else');
  });

  it('ignores unknown/server-owned keys in the body (roles, notification_chat_delivery) — never spread onto the write', async () => {
    await PATCH(
      makeReq({
        notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages',
        roles: ['admin'],
        notification_chat_delivery: { last_success_at: '2020-01-01T00:00:00.000Z' },
      }),
    );

    const written = userDocUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect('roles' in written).toBe(false);
    expect('notification_chat_delivery' in written).toBe(false);
  });

  it('404s when the caller has no user document yet', async () => {
    userDocGet.mockResolvedValueOnce({ exists: false });

    const res = await PATCH(makeReq({ notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages' }));

    expect(res.status).toBe(404);
    expect(userDocUpdate).not.toHaveBeenCalled();
  });
});
