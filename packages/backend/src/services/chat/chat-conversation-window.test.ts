/**
 * @file chat-conversation-window — the pure per-option restart decision
 * (`shouldRestartChatConversation`) and the Firestore-backed user-habit
 * lookup (`resolveUserChatConversationWindow`), mocked the same way
 * `chat-identity-service.test.ts` mocks `collections.users()`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHAT_CONVERSATION_WINDOW } from '@arbitra/shared';

type DocData = Record<string, unknown>;

const usersStore = new Map<string, DocData>();

function reset(): void {
  usersStore.clear();
}

class FakeUserDocRef {
  constructor(readonly id: string) {}

  async get() {
    const data = usersStore.get(this.id);
    return { exists: data !== undefined, id: this.id, data: () => data };
  }
}

class FakeUsersCollection {
  doc(id: string): FakeUserDocRef {
    return new FakeUserDocRef(id);
  }
}

vi.mock('../../lib/firestore.js', () => ({
  collections: { users: () => new FakeUsersCollection() },
}));

const { shouldRestartChatConversation, resolveUserChatConversationWindow, CHAT_IDLE_GAP_MS } = await import(
  './chat-conversation-window.js'
);

beforeEach(() => {
  reset();
});

describe('shouldRestartChatConversation — continuous', () => {
  /**
   * Reverting the `case 'continuous': return false;` branch (e.g. falling
   * through to a timestamp comparison) breaks this — `continuous` must
   * never restart, no matter how large the gap.
   */
  it('never restarts, even across a huge gap', () => {
    const restart = shouldRestartChatConversation(
      'continuous',
      '2026-01-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    );
    expect(restart).toBe(false);
  });
});

describe('shouldRestartChatConversation — per_message', () => {
  /**
   * Reverting the `case 'per_message': return true;` branch breaks this —
   * `per_message` must always restart, even one millisecond after the last
   * message.
   */
  it('always restarts, even immediately after the last message', () => {
    const restart = shouldRestartChatConversation(
      'per_message',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.001Z',
    );
    expect(restart).toBe(true);
  });
});

describe('shouldRestartChatConversation — idle_gap boundary', () => {
  /**
   * Reverting the `gapMs > CHAT_IDLE_GAP_MS` comparison (e.g. to `>=`, or to
   * a different constant) breaks one side of this boundary pair.
   */
  it('does not restart just under the 4-hour gap', () => {
    const lastTipAdvanceAt = '2026-01-01T00:00:00.000Z';
    const now = new Date(Date.parse(lastTipAdvanceAt) + CHAT_IDLE_GAP_MS - 1000).toISOString();
    expect(shouldRestartChatConversation('idle_gap', lastTipAdvanceAt, now)).toBe(false);
  });

  it('restarts just over the 4-hour gap', () => {
    const lastTipAdvanceAt = '2026-01-01T00:00:00.000Z';
    const now = new Date(Date.parse(lastTipAdvanceAt) + CHAT_IDLE_GAP_MS + 1000).toISOString();
    expect(shouldRestartChatConversation('idle_gap', lastTipAdvanceAt, now)).toBe(true);
  });

  /**
   * Reverting the `!Number.isFinite(gapMs) ||` guard (e.g. dropping it so
   * an unparsable timestamp falls through to `NaN > CHAT_IDLE_GAP_MS`,
   * which is `false`) breaks this — bad data must fail toward "restart",
   * never toward silently treating an unparsable link as still current.
   */
  it('restarts when the stored timestamp is unparsable, rather than silently continuing', () => {
    expect(shouldRestartChatConversation('idle_gap', 'not-a-timestamp', '2026-01-01T00:00:00.000Z')).toBe(true);
  });
});

describe('shouldRestartChatConversation — daily boundary', () => {
  /**
   * Reverting the calendar-day comparison to a raw elapsed-time check (e.g.
   * reusing the `idle_gap` arithmetic) breaks this — two messages minutes
   * apart but either side of local midnight must still restart under
   * `daily`.
   */
  it('restarts across a UTC calendar-day boundary, even a minute apart', () => {
    const lastTipAdvanceAt = '2026-01-01T23:59:00.000Z';
    const now = '2026-01-02T00:01:00.000Z';
    expect(shouldRestartChatConversation('daily', lastTipAdvanceAt, now)).toBe(true);
  });

  it('does not restart within the same UTC calendar day, even hours apart', () => {
    const lastTipAdvanceAt = '2026-01-01T08:00:00.000Z';
    const now = '2026-01-01T20:00:00.000Z';
    expect(shouldRestartChatConversation('daily', lastTipAdvanceAt, now)).toBe(false);
  });

  /**
   * Reverting the `timeZoneId` plumbing (e.g. always formatting in UTC)
   * breaks this — the same two UTC instants land on different LOCAL
   * calendar days in `America/New_York` but the same UTC day, and the
   * reverse for `Asia/Seoul`.
   */
  it('uses the given IANA timezone, not a fixed one, to decide the calendar day', () => {
    // One hour apart, straddling 15:00Z — local midnight in Asia/Seoul
    // (UTC+9: 14:30Z -> 23:30 Jan 1 KST, 15:30Z -> 00:30 Jan 2 KST, so KST
    // crosses a day boundary) but nowhere near local midnight in
    // America/New_York (UTC-5 in January: 09:30 Jan 1 -> 10:30 Jan 1, no
    // boundary crossed). Same two UTC instants, opposite verdicts.
    const lastTipAdvanceAt = '2026-01-01T14:30:00.000Z';
    const now = '2026-01-01T15:30:00.000Z';
    expect(shouldRestartChatConversation('daily', lastTipAdvanceAt, now, 'America/New_York')).toBe(false);
    expect(shouldRestartChatConversation('daily', lastTipAdvanceAt, now, 'Asia/Seoul')).toBe(true);
  });

  /**
   * Reverting the try/catch fallback to UTC (e.g. letting the
   * `Intl.DateTimeFormat` `RangeError` for an invalid timezone propagate)
   * breaks this — an invalid/unrecognized timezone string must degrade to
   * UTC, never throw.
   */
  it('falls back to UTC for an invalid timezone id instead of throwing', () => {
    expect(() =>
      shouldRestartChatConversation('daily', '2026-01-01T08:00:00.000Z', '2026-01-01T20:00:00.000Z', 'Not/AZone'),
    ).not.toThrow();
  });
});

describe('resolveUserChatConversationWindow', () => {
  /**
   * Reverting the `?? DEFAULT_CHAT_CONVERSATION_WINDOW` fallback (e.g.
   * returning the raw `undefined` field) breaks this. Asserts against the
   * imported constant, not a hardcoded literal, so this test does not go
   * stale the next time the default changes (it already has once —
   * case-soft-cliff-lOZ_, Change 3: `per_message` -> `idle_gap`).
   */
  it('falls back to the default window when the user never chose one', async () => {
    usersStore.set('usr_1', { user_id: 'usr_1' });
    expect(await resolveUserChatConversationWindow('usr_1')).toBe(DEFAULT_CHAT_CONVERSATION_WINDOW);
    expect(DEFAULT_CHAT_CONVERSATION_WINDOW).toBe('idle_gap');
  });

  it('returns the stored value when it is a valid option', async () => {
    usersStore.set('usr_1', { user_id: 'usr_1', chat_conversation_window: 'daily' });
    expect(await resolveUserChatConversationWindow('usr_1')).toBe('daily');
  });

  /**
   * `per_message` remains a selectable option after the default flip
   * (case-soft-cliff-lOZ_, Change 3) — only the FALLBACK changed, not the
   * closed set itself, so a user who explicitly chose `per_message` must
   * still get exactly that back, not the new default.
   */
  it('returns per_message when the user explicitly chose it, even though it is no longer the default', async () => {
    usersStore.set('usr_1', { user_id: 'usr_1', chat_conversation_window: 'per_message' });
    expect(await resolveUserChatConversationWindow('usr_1')).toBe('per_message');
  });

  /**
   * Defends against a hand-edited or pre-migration document carrying a
   * value outside the closed set — must not propagate garbage into the
   * routing decision.
   */
  it('falls back to the default window when the stored value is not one of the closed options', async () => {
    usersStore.set('usr_1', { user_id: 'usr_1', chat_conversation_window: 'hourly' });
    expect(await resolveUserChatConversationWindow('usr_1')).toBe(DEFAULT_CHAT_CONVERSATION_WINDOW);
  });

  it('falls back to the default window when the user document does not exist', async () => {
    expect(await resolveUserChatConversationWindow('usr_missing')).toBe(DEFAULT_CHAT_CONVERSATION_WINDOW);
  });
});
