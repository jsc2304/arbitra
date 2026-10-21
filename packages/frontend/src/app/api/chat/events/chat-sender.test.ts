/**
 * @file chat-sender — pure extraction tests.
 *
 * `resolveChatSender` never does I/O and never throws; every test here
 * targets one specific guard in the function so a regression in any single
 * guard is caught in isolation rather than only through an end-to-end
 * route test.
 */
import { describe, expect, it } from 'vitest';
import {
  readCommonEventTimeZone,
  readFallbackSpaceName,
  resolveChatMessage,
  resolveChatSender,
  resolveConversationKind,
} from './chat-sender';
import type { ChatEvent } from './event-shape';

function humanUser(overrides: Record<string, unknown> = {}) {
  return { name: 'users/123456789', type: 'HUMAN', ...overrides };
}

function eventWith(chat: Record<string, unknown>): ChatEvent {
  return { chat } as ChatEvent;
}

describe('resolveChatSender', () => {
  /**
   * Reverting the final `return { status: 'resolved', ... }` (e.g. to
   * always return `unresolved`) breaks this — the happy path must still
   * resolve once every guard above it passes.
   */
  it('resolves a HUMAN sender with an email, name, and space', () => {
    const result = resolveChatSender(
      eventWith({
        user: humanUser({ email: 'alex.example@example.com' }),
        space: { name: 'spaces/AAAA' },
      }),
    );
    expect(result).toEqual({
      status: 'resolved',
      chatUserId: 'users/123456789',
      spaceName: 'spaces/AAAA',
      email: 'alex.example@example.com',
      conversationKind: 'space',
    });
  });

  /**
   * Reverting `if (!chat) { return { status: 'unresolved', reason:
   * 'missing_chat_envelope' }; }` (e.g. deleting the guard) breaks this —
   * without it, `asRecord(chat['user'])` below throws reading a property
   * off `undefined`.
   */
  it('resolves to missing_chat_envelope when the event has no chat field at all', () => {
    expect(resolveChatSender({} as ChatEvent)).toEqual({ status: 'unresolved', reason: 'missing_chat_envelope' });
  });

  /**
   * Reverting the `if (!user) { return { status: 'unresolved', reason:
   * 'missing_user' }; }` guard breaks this.
   */
  it('resolves to missing_user when chat.user is absent (e.g. widgetUpdatedPayload)', () => {
    const result = resolveChatSender(eventWith({ widgetUpdatedPayload: { widget: 'x' } }));
    expect(result).toEqual({ status: 'unresolved', reason: 'missing_user' });
  });

  /**
   * Reverting the `typeof chatUserIdRaw !== 'string' || !chatUserIdRaw.trim()`
   * guard (e.g. only checking `typeof`, not emptiness) breaks this.
   */
  it('resolves to missing_chat_user_id when user.name is absent', () => {
    const result = resolveChatSender(eventWith({ user: { type: 'HUMAN' }, space: { name: 'spaces/AAAA' } }));
    expect(result).toEqual({ status: 'unresolved', reason: 'missing_chat_user_id' });
  });

  /**
   * LOAD-BEARING FOR THE MIS-BINDING GUARD. Reverting
   * `if (user['type'] !== 'HUMAN') { return { status: 'unresolved', reason:
   * 'non_human' }; }` (e.g. deleting it, or inverting it to only reject
   * `'BOT'` explicitly) breaks this — a bot/app sender (or one with no
   * `type` at all) must never resolve to a mappable identity.
   */
  it('resolves to non_human for a BOT-typed sender, never mapping it', () => {
    const result = resolveChatSender(
      eventWith({ user: { name: 'users/app', type: 'BOT' }, space: { name: 'spaces/AAAA' } }),
    );
    expect(result).toEqual({ status: 'unresolved', reason: 'non_human' });
  });

  /**
   * Same guard, the other documented failure mode: proto3 can omit the
   * default enum value from JSON entirely, so an ABSENT `type` must fail
   * closed exactly like `BOT` — not be treated as `HUMAN`. Reverting the
   * guard to `user['type'] === 'BOT'` (explicit-bot-only) instead of
   * `!== 'HUMAN'` breaks this.
   */
  it('resolves to non_human when type is absent entirely', () => {
    const result = resolveChatSender(
      eventWith({ user: { name: 'users/123456789' }, space: { name: 'spaces/AAAA' } }),
    );
    expect(result).toEqual({ status: 'unresolved', reason: 'non_human' });
  });

  /**
   * Reverting `if (user['isAnonymous'] === true) { return { status:
   * 'unresolved', reason: 'anonymous' }; }` breaks this.
   */
  it('resolves to anonymous when isAnonymous is true', () => {
    const result = resolveChatSender(
      eventWith({ user: humanUser({ isAnonymous: true }), space: { name: 'spaces/AAAA' } }),
    );
    expect(result).toEqual({ status: 'unresolved', reason: 'anonymous' });
  });

  /**
   * Reverting the `typeof spaceNameRaw !== 'string' || !spaceNameRaw.trim()`
   * guard breaks this.
   */
  it('resolves to missing_space when chat.space.name is absent', () => {
    const result = resolveChatSender(eventWith({ user: humanUser() }));
    expect(result).toEqual({ status: 'unresolved', reason: 'missing_space' });
  });

  /**
   * Reverting the email ternary (`typeof emailRaw === 'string' &&
   * emailRaw.trim() ? emailRaw.trim() : undefined`) to always fabricate a
   * value (e.g. falling back to an empty string instead of `undefined`)
   * breaks this — an event that never carried an email (documented as
   * happening on membership events) must resolve with `email: undefined`,
   * not a fabricated one, so the caller can distinguish "no email" from
   * "empty string email".
   */
  it('resolves without an email when the event omitted one', () => {
    const result = resolveChatSender(eventWith({ user: humanUser(), space: { name: 'spaces/AAAA' } }));
    expect(result).toEqual({
      status: 'resolved',
      chatUserId: 'users/123456789',
      spaceName: 'spaces/AAAA',
      email: undefined,
      conversationKind: 'space',
    });
  });
});

/**
 * `resolveConversationKind` / `resolveChatSender`'s `conversationKind` —
 * chat DM conversation window feature. See the module doc's "Space kind"
 * section for the `spaceType` citation.
 */
describe('resolveConversationKind — direct vs. space', () => {
  /**
   * Reverting the `=== 'DIRECT_MESSAGE'` check (e.g. to a looser match, or
   * reading the deprecated `type` field instead of `spaceType`) breaks
   * this — the top-level `chat.space` shape (`ADDED_TO_SPACE`).
   */
  it('resolves direct when chat.space.spaceType is DIRECT_MESSAGE (top level)', () => {
    const result = resolveChatSender(
      eventWith({ user: humanUser(), space: { name: 'spaces/AAAA', spaceType: 'DIRECT_MESSAGE' } }),
    );
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.conversationKind).toBe('direct');
  });

  /**
   * Same field, the MESSAGE-event location — reverting the
   * `chat.messagePayload.space` fallback in `readSpaceType` breaks this.
   */
  it('resolves direct when chat.messagePayload.space.spaceType is DIRECT_MESSAGE', () => {
    const result = resolveChatSender(
      eventWith({
        user: humanUser(),
        messagePayload: { space: { name: 'spaces/AAAA', spaceType: 'DIRECT_MESSAGE' } },
      }),
    );
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.conversationKind).toBe('direct');
  });

  it.each(['SPACE', 'GROUP_CHAT'])('resolves space for spaceType %s', (spaceType) => {
    const result = resolveChatSender(eventWith({ user: humanUser(), space: { name: 'spaces/AAAA', spaceType } }));
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.conversationKind).toBe('space');
  });

  /**
   * REQUIRED FAIL-SAFE CONTRACT: an absent or unrecognized `spaceType` must
   * degrade to `space` (thread-keyed), never `direct` — treating an unknown
   * shape as a DM would risk merging unrelated conversations onto one
   * shared DM pointer. Reverting the ternary's fallback branch (e.g.
   * defaulting to `direct`) breaks both of these.
   */
  it('resolves space when spaceType is absent entirely', () => {
    const result = resolveChatSender(eventWith({ user: humanUser(), space: { name: 'spaces/AAAA' } }));
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.conversationKind).toBe('space');
  });

  it('resolves space when spaceType is an unrecognized value', () => {
    const result = resolveChatSender(
      eventWith({ user: humanUser(), space: { name: 'spaces/AAAA', spaceType: 'SPACE_TYPE_UNSPECIFIED' } }),
    );
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.conversationKind).toBe('space');
  });

  it('resolveConversationKind is directly callable on a raw chat record', () => {
    expect(resolveConversationKind({ space: { spaceType: 'DIRECT_MESSAGE' } })).toBe('direct');
    expect(resolveConversationKind({ space: { spaceType: 'SPACE' } })).toBe('space');
    expect(resolveConversationKind({})).toBe('space');
  });
});

describe('readCommonEventTimeZone', () => {
  /** Reverting the `commonEventObject.timeZone.id` read (e.g. reading `.timezone` or a top-level field) breaks this. */
  it('reads commonEventObject.timeZone.id when present', () => {
    const event = { commonEventObject: { timeZone: { id: 'Europe/Vienna', offset: 3600000 } } } as ChatEvent;
    expect(readCommonEventTimeZone(event)).toBe('Europe/Vienna');
  });

  it('returns undefined when commonEventObject is absent', () => {
    expect(readCommonEventTimeZone({} as ChatEvent)).toBeUndefined();
  });

  it('returns undefined when timeZone.id is missing or not a string', () => {
    expect(readCommonEventTimeZone({ commonEventObject: {} } as unknown as ChatEvent)).toBeUndefined();
    expect(
      readCommonEventTimeZone({ commonEventObject: { timeZone: { id: 42 } } } as unknown as ChatEvent),
    ).toBeUndefined();
  });
});

/**
 * `resolveChatMessage` — pure extraction tests for Slice F's inbound
 * message text/thread/message-name extraction. Same discipline as
 * `resolveChatSender` above: never throws, one guard per test.
 */
describe('resolveChatMessage', () => {
  /**
   * Reverting the final `return { status: 'resolved', ... }` (e.g. to
   * always return `unresolved`) breaks this.
   */
  it('resolves text, sourceMessageName, and threadName when all three are present', () => {
    const result = resolveChatMessage(
      eventWith({
        messagePayload: {
          message: {
            text: '  Please review PR #42  ',
            name: 'spaces/AAAA/messages/M1',
            thread: { name: 'spaces/AAAA/threads/T1' },
          },
        },
      }),
    );
    expect(result).toEqual({
      status: 'resolved',
      text: 'Please review PR #42',
      sourceMessageName: 'spaces/AAAA/messages/M1',
      threadName: 'spaces/AAAA/threads/T1',
    });
  });

  /**
   * Reverting `if (!chat) { return { status: 'unresolved', reason:
   * 'missing_chat_envelope' }; }` breaks this — without it,
   * `asRecord(chat['messagePayload'])` below throws reading a property off
   * `undefined`.
   */
  it('resolves to missing_chat_envelope when the event has no chat field at all', () => {
    expect(resolveChatMessage({} as ChatEvent)).toEqual({
      status: 'unresolved',
      reason: 'missing_chat_envelope',
    });
  });

  /**
   * Reverting the `if (!messagePayload) { return { status: 'unresolved',
   * reason: 'missing_message_payload' }; }` guard breaks this — e.g. an
   * `addedToSpacePayload` event, which carries no `messagePayload` at all.
   */
  it('resolves to missing_message_payload when chat.messagePayload is absent', () => {
    const result = resolveChatMessage(eventWith({ addedToSpacePayload: { space: { name: 'spaces/AAAA' } } }));
    expect(result).toEqual({ status: 'unresolved', reason: 'missing_message_payload' });
  });

  /**
   * Reverting the `if (!message) { return { status: 'unresolved', reason:
   * 'missing_message' }; }` guard breaks this.
   */
  it('resolves to missing_message when messagePayload.message is absent', () => {
    const result = resolveChatMessage(eventWith({ messagePayload: {} }));
    expect(result).toEqual({ status: 'unresolved', reason: 'missing_message' });
  });

  /**
   * Reverting the `typeof textRaw !== 'string' || !textRaw.trim()` guard
   * (e.g. only checking `typeof`, not emptiness) breaks this.
   */
  it('resolves to missing_text when message.text is absent or blank', () => {
    const absent = resolveChatMessage(
      eventWith({ messagePayload: { message: { name: 'spaces/AAAA/messages/M1' } } }),
    );
    const blank = resolveChatMessage(
      eventWith({ messagePayload: { message: { text: '   ', name: 'spaces/AAAA/messages/M1' } } }),
    );
    expect(absent).toEqual({ status: 'unresolved', reason: 'missing_text' });
    expect(blank).toEqual({ status: 'unresolved', reason: 'missing_text' });
  });

  /**
   * LOAD-BEARING FOR IDEMPOTENCY. Reverting the
   * `typeof sourceMessageNameRaw !== 'string' || !sourceMessageNameRaw.trim()`
   * guard (e.g. treating a missing `message.name` as an empty string
   * rather than unresolved) breaks this — Slice F's intake uses this value
   * as the idempotency key that collapses Chat's delivery retries onto one
   * Case, so a message this function cannot name must never resolve.
   */
  it('resolves to missing_message_name when message.name is absent, even with valid text', () => {
    const result = resolveChatMessage(eventWith({ messagePayload: { message: { text: 'hi' } } }));
    expect(result).toEqual({ status: 'unresolved', reason: 'missing_message_name' });
  });

  /**
   * Reverting the `threadName` ternary (e.g. fabricating an empty string
   * instead of omitting the field) breaks this — a message resolves fine
   * without a thread (see `ChatReplyTarget.threadName`'s own optionality
   * in `@arbitra/backend`'s `chat-reply-poster.ts`), it just has no
   * `threadName` key at all.
   */
  it('resolves without a threadName when message.thread is absent, and text/name still resolve', () => {
    const result = resolveChatMessage(
      eventWith({ messagePayload: { message: { text: 'hi', name: 'spaces/AAAA/messages/M1' } } }),
    );
    expect(result).toEqual({
      status: 'resolved',
      text: 'hi',
      sourceMessageName: 'spaces/AAAA/messages/M1',
    });
    expect(result).not.toHaveProperty('threadName');
  });
});

/**
 * `readFallbackSpaceName` — the independent, best-effort read used only
 * when `resolveChatSender` itself failed and a decline still needs SOME
 * space to reply into (see `route.ts`'s `declineUnmatchedChatSender`).
 */
describe('readFallbackSpaceName', () => {
  /** Reverting the final `typeof nameRaw === 'string' && nameRaw.trim() ? ... : undefined` breaks this. */
  it('reads chat.space.name when present', () => {
    expect(readFallbackSpaceName(eventWith({ space: { name: 'spaces/AAAA' } }))).toBe('spaces/AAAA');
  });

  /** Reverting `asRecord(chat?.['space'])`'s guard (e.g. assuming `space` is always an object) breaks this. */
  it('returns undefined when chat.space is absent', () => {
    expect(readFallbackSpaceName(eventWith({ user: { name: 'users/1' } }))).toBeUndefined();
  });

  /** Reverting the top-level `asRecord(event.chat)` guard breaks this — without it, reading `chat?.['space']` off a non-object `chat` would not throw, but a malformed `chat` (e.g. a string) must still resolve to `undefined`, not a stray value. */
  it('returns undefined when the event has no chat field at all', () => {
    expect(readFallbackSpaceName({} as ChatEvent)).toBeUndefined();
  });
});

describe('space resolution across event shapes (MESSAGE vs ADDED_TO_SPACE)', () => {
  // Shape of a MESSAGE event (an @-mention): the space sits under `chat.messagePayload.space`,
  // NOT `chat.space`, while `chat.user.*` stays top level. Reading only the
  // latter made every real message resolve to `missing_space`.
  const messageEvent = eventWith({
    user: humanUser({ email: 'alex@example.com', displayName: 'Alex' }),
    messagePayload: {
      space: { name: 'spaces/AAAA' },
      message: { name: 'spaces/AAAA/messages/abc123', text: 'How many cases?' },
    },
  });

  it('resolves the sender from a MESSAGE payload (space under messagePayload)', () => {
    const result = resolveChatSender(messageEvent);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.spaceName).toBe('spaces/AAAA');
    expect(result.email).toBe('alex@example.com');
  });

  it('still resolves the ADDED_TO_SPACE shape where the space is top level', () => {
    const result = resolveChatSender(
      eventWith({ user: humanUser({ email: 'a@b.test' }), space: { name: 'spaces/TOPLEVEL' } }),
    );

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.spaceName).toBe('spaces/TOPLEVEL');
  });

  it('readFallbackSpaceName finds the space in a MESSAGE payload too', () => {
    expect(readFallbackSpaceName(messageEvent)).toBe('spaces/AAAA');
  });

  it('still reports missing_space when neither location carries one', () => {
    const result = resolveChatSender(
      eventWith({ user: humanUser({ email: 'a@b.test' }), messagePayload: {} }),
    );

    expect(result.status).toBe('unresolved');
    if (result.status !== 'unresolved') return;
    expect(result.reason).toBe('missing_space');
  });
});
