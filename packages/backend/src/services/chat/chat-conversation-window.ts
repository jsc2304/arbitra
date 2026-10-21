import { CHAT_CONVERSATION_WINDOWS, DEFAULT_CHAT_CONVERSATION_WINDOW, type ChatConversationWindow } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';

/**
 * Fixed idle gap for the `idle_gap` window option: 4 hours.
 *
 * The spec deliberately calls for ONE sensible fixed value here rather than
 * a user-configurable number of hours (closed-set options only, same reason
 * `ChatConversationWindow` itself is a closed enum, not a free-form
 * duration). 4 hours was chosen because it comfortably spans a single
 * working session (long enough that a lunch break or a meeting inside one
 * conversation does not fragment it) while still being short enough that an
 * overnight gap always starts fresh — the exact use case ("a conversation
 * per day" without literally requiring the `daily` option) the owner
 * described wanting.
 */
export const CHAT_IDLE_GAP_MS = 4 * 60 * 60 * 1000;

/**
 * Formats an ISO timestamp as its calendar-day key (`YYYY-MM-DD`) in the
 * given IANA timezone, falling back to UTC when the timezone is missing or
 * not a value `Intl` recognizes (an invalid `Intl.DateTimeFormat` `timeZone`
 * option throws a `RangeError`) — never throws itself.
 */
function calendarDayKey(iso: string, timeZoneId: string | undefined): string {
  const date = new Date(iso);
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  if (timeZoneId) {
    try {
      return format(timeZoneId);
    } catch {
      // Falls through to UTC below.
    }
  }
  return format('UTC');
}

/**
 * Pure decision function: given a user's chosen `ChatConversationWindow`
 * and the DM's recorded tip timestamp, should the NEXT message start a
 * fresh root Case instead of continuing (or asking to continue) the
 * existing one?
 *
 * Deliberately evaluated BEFORE any check of the pointed-to Case's own
 * status (`route.ts`'s `resolveExistingChatThreadCase`): a `daily` or
 * `idle_gap` reset is a hard boundary the caller must treat as if no
 * pointer existed at all, even if the previous Case is still genuinely in
 * flight — the alternative (still returning a "still working" busy nudge
 * across a day boundary the user explicitly asked to reset on) is exactly
 * the surprising behavior this feature exists to avoid.
 *
 * Only ever consulted for a DM (`continuity_key_kind: 'space_name'`); a
 * Chat SPACE conversation never calls this at all, so its thread-keyed
 * behavior is byte-for-byte unchanged by this feature.
 */
export function shouldRestartChatConversation(
  window: ChatConversationWindow,
  // This is `ChatThreadLink.updated_at` (`recordChatThreadTip`'s
  // tip-advance timestamp), passed in by the only caller as
  // `link.updatedAt`. Because every non-replayed inbound message mints a
  // new Case (follow-ups included) and advances the tip, this is in
  // practice the time of the last conversation turn — so `idle_gap` is a
  // ROLLING window (restart after 4 h of inactivity, however long the
  // conversation has been going), and `daily` compares the calendar day of
  // the last turn. Only a redelivered/replayed message leaves the clock
  // untouched.
  lastTipAdvanceAtIso: string,
  nowIso: string,
  timeZoneId?: string,
): boolean {
  switch (window) {
    case 'continuous':
      return false;
    case 'per_message':
      return true;
    case 'idle_gap': {
      const gapMs = Date.parse(nowIso) - Date.parse(lastTipAdvanceAtIso);
      // An unparsable timestamp on either side degrades to "restart" —
      // the safe direction per this feature's contract (never silently
      // merge into a possibly-unrelated conversation on bad data).
      return !Number.isFinite(gapMs) || gapMs > CHAT_IDLE_GAP_MS;
    }
    case 'daily':
      return calendarDayKey(nowIso, timeZoneId) !== calendarDayKey(lastTipAdvanceAtIso, timeZoneId);
    default:
      // Unreached given the closed `ChatConversationWindow` type; matches
      // `continuous`'s fail-safe rather than restarting on a value this
      // function does not recognize.
      return false;
  }
}

/**
 * Resolves the DM conversation-window habit for one Arbitra user, falling
 * back to `DEFAULT_CHAT_CONVERSATION_WINDOW` when the user has never chosen
 * one, when the stored value is not one of the closed
 * `CHAT_CONVERSATION_WINDOWS` (defensive against a hand-edited or
 * pre-migration document), or when the read itself fails — a Firestore
 * hiccup here must degrade to the safe default, not propagate into a 5xx on
 * the Chat webhook (same "never throws" discipline as the rest of the
 * `/api/chat/events` call chain).
 */
export async function resolveUserChatConversationWindow(userId: string): Promise<ChatConversationWindow> {
  try {
    const snap = await collections.users().doc(userId).get();
    const value = snap.data()?.chat_conversation_window;
    return (CHAT_CONVERSATION_WINDOWS as readonly string[]).includes(value as string)
      ? (value as ChatConversationWindow)
      : DEFAULT_CHAT_CONVERSATION_WINDOW;
  } catch {
    return DEFAULT_CHAT_CONVERSATION_WINDOW;
  }
}
