/**
 * Sender-identity extraction for `POST /api/chat/events` (spec Slice E,
 * `docs/specs/clerk-config-scheduling-chat.md`).
 *
 * Lives outside `route.ts` for the same reason `event-shape.ts` and
 * `rate-limit.ts` do — a Next.js route module may only export HTTP-method
 * handlers plus a fixed config allowlist. Kept as a PURE function (no
 * Firestore, no logging) so it is directly testable against every
 * hostile/missing shape without mocking anything.
 *
 * ## Where the identity is, and why
 *
 * `chat.user` sits as a SIBLING of the six mutually exclusive payload keys
 * `classifyChatEvent` switches on (`event-shape.ts`), not inside any of
 * them — Google's own event-object docs list `chat.user` before the
 * "Union field payload" block. That is exactly what makes it usable from
 * the `ADDED_TO_SPACE` branch as well as `MESSAGE`: there is a SECOND,
 * independent `User` object at `chat.messagePayload.message.sender`, but it
 * exists only on message-bearing payloads and means "who wrote this
 * message" — not "who is interacting with the app". Using `sender` for a
 * future button click would attribute the action to the wrong person if
 * the clicker isn't the message's author. `chat.user` is read here
 * exclusively; there is deliberately no fallback to `sender`.
 *
 * ## Fields trusted, and why
 *
 * `chat.user.name` (`users/123456789`) is the only field every one of
 * Google's own add-on samples reads, and the only one documented as always
 * returned in canonical form — it is also the Google OIDC `sub`. It is the
 * join key `chat-identity-service.ts` stores, but it is NOT itself matched
 * against anything Arbitra stores: Arbitra's `user_id` is a Firebase UID,
 * an unrelated string in an unrelated namespace.
 *
 * `chat.user.email` is not part of the typed Chat API `User` resource (five
 * fields, no email) but Google's own event-data samples and one of its own
 * add-on samples both show it populated on the wire, while Google's own
 * DevRel guidance says membership events can omit it entirely. Treated here
 * as present-or-absent, never assumed either way.
 *
 * `chat.user.type` distinguishes `HUMAN` from `BOT` (the app's own alias is
 * `users/app`), but a proto3 enum's default value can be omitted from JSON
 * entirely — so an ABSENT `type` is treated the same as `BOT`: fail closed,
 * matching the mis-binding risk this whole feature exists to avoid.
 * `isAnonymous: true` ("the user is deleted or their profile is not
 * visible") is rejected the same way.
 *
 * The space (`chat.space.name`, or `chat.messagePayload.space.name` on a
 * MESSAGE event) is read for the mapping's `space_name`. Nothing in
 * Google's docs states it is guaranteed present on every payload kind
 * either, so it is guarded exactly like `chat.user`.
 *
 * ## Space kind — DM vs. group/named space
 *
 * The same embedded `Space` object also carries `spaceType`, a required
 * (output-only) enum documented at
 * https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces#Space
 * with three values: `SPACE` ("a place where people send messages, share
 * files, and collaborate"), `GROUP_CHAT` ("group conversations between 3 or
 * more people"), and `DIRECT_MESSAGE` ("1:1 messages between two humans or a
 * human and a Chat app") — the deprecated `type` field predates this
 * three-way split and uses its OWN, different enum (`ROOM` / `DM`, not
 * `SPACE`/`GROUP_CHAT`/`DIRECT_MESSAGE`): `ROOM` collapses what `spaceType`
 * now splits into `SPACE` and `GROUP_CHAT`, and `DM` corresponds to
 * `DIRECT_MESSAGE`. Not read here regardless. `resolveConversationKind` below
 * reads it from the same two locations `readSpaceName` already checks
 * (top-level `chat.space` for `ADDED_TO_SPACE`, `chat.messagePayload.space`
 * for `MESSAGE`) and collapses it to the closed `direct` / `space`
 * distinction the chat DM conversation-window feature routes on
 * (`chat-thread-link-service.ts`'s `ChatContinuityKeyKind`). Only the exact
 * string `'DIRECT_MESSAGE'` resolves to `direct` — an absent field, an
 * unrecognized value, or `SPACE`/`GROUP_CHAT` all resolve to `space`. That
 * fail-safe direction is deliberate: treating an unknown shape as `space`
 * keeps today's proven thread-keyed routing (a Case per thread), where
 * treating it as `direct` would risk merging unrelated conversations onto
 * one shared DM pointer if the assumption about this field ever turns out
 * wrong on a payload shape not yet seen on the wire.
 *
 * Every access below is a type-guarded read of `unknown` data out of a
 * caller-supplied (though JWT-verified) HTTP body. A missing, wrongly
 * typed, or unexpected shape at any point returns `unresolved` — never
 * throws — so a malformed or novel event body can never turn into a 5xx
 * for the caller in `route.ts`.
 */
import type { ChatEvent } from './event-shape';

/**
 * Closed distinction the chat DM conversation-window feature routes
 * continuity on — see the module doc's "Space kind" section above for the
 * `spaceType` values this collapses.
 */
export type ChatConversationKind = 'direct' | 'space';

/**
 * Why the sender could not be resolved to a mappable human. Safe to log
 * verbatim — each value is a fixed classification, never a payload value.
 */
export type ChatSenderUnresolvedReason =
  | 'missing_chat_envelope'
  | 'missing_user'
  | 'missing_chat_user_id'
  | 'non_human'
  | 'anonymous'
  | 'missing_space';

export interface ResolvedChatSender {
  status: 'resolved';
  /** The opaque `chat.user.name` resource id, e.g. `users/123456789`. */
  chatUserId: string;
  /** The `chat.space.name` resource id, e.g. `spaces/AAAA`. */
  spaceName: string;
  /** Present only when the event carried one — see the module doc. */
  email?: string;
  /**
   * `direct` (a 1:1 DM) or `space` (a named space or group chat) — see the
   * module doc's "Space kind" section for the `spaceType` field this is
   * derived from and its fail-safe default.
   */
  conversationKind: ChatConversationKind;
}

export interface UnresolvedChatSender {
  status: 'unresolved';
  reason: ChatSenderUnresolvedReason;
}

export type ChatSenderResolution = ResolvedChatSender | UnresolvedChatSender;

/** Narrows to a plain object record, rejecting `null` and arrays. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Extracts and validates the sender identity from a verified add-on event.
 * See the module doc for the field-by-field reasoning.
 */
export function resolveChatSender(event: ChatEvent): ChatSenderResolution {
  const chat = asRecord(event.chat);
  if (!chat) {
    return { status: 'unresolved', reason: 'missing_chat_envelope' };
  }

  const user = asRecord(chat['user']);
  if (!user) {
    return { status: 'unresolved', reason: 'missing_user' };
  }

  const chatUserIdRaw = user['name'];
  if (typeof chatUserIdRaw !== 'string' || !chatUserIdRaw.trim()) {
    return { status: 'unresolved', reason: 'missing_chat_user_id' };
  }

  // Fail closed: BOT, TYPE_UNSPECIFIED, missing, or any unrecognized value
  // all resolve the same way as a genuine bot — only an explicit 'HUMAN'
  // is accepted. Order matters: this must run before the anonymous check
  // below is even meaningful, since a non-human sender is rejected
  // regardless of `isAnonymous`.
  if (user['type'] !== 'HUMAN') {
    return { status: 'unresolved', reason: 'non_human' };
  }
  if (user['isAnonymous'] === true) {
    return { status: 'unresolved', reason: 'anonymous' };
  }

  const spaceName = readSpaceName(chat);
  if (!spaceName) {
    return { status: 'unresolved', reason: 'missing_space' };
  }

  const emailRaw = user['email'];
  const email = typeof emailRaw === 'string' && emailRaw.trim() ? emailRaw.trim() : undefined;

  return {
    status: 'resolved',
    chatUserId: chatUserIdRaw.trim(),
    spaceName,
    email,
    conversationKind: resolveConversationKind(chat),
  };
}

/**
 * Reads the embedded `Space` object's `spaceType`, from whichever of the two
 * locations `readSpaceName` also checks (top-level first). Returns the raw
 * string — narrowing to `ChatConversationKind` is `resolveConversationKind`'s
 * job, not this helper's, so a caller that ever needs the raw enum value
 * (e.g. for a future `GROUP_CHAT`-specific behavior) is not forced through
 * the collapsed boolean-ish distinction.
 */
function readSpaceType(chat: Record<string, unknown>): string | undefined {
  const direct = asRecord(chat['space'])?.['spaceType'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const fromMessage = asRecord(asRecord(chat['messagePayload'])?.['space'])?.['spaceType'];
  if (typeof fromMessage === 'string' && fromMessage.trim()) return fromMessage.trim();
  return undefined;
}

/**
 * Collapses the Space resource's `spaceType` to the closed `direct` /
 * `space` distinction the chat DM conversation-window feature routes
 * continuity on. See the module doc's "Space kind" section for the full
 * citation and why an absent or unrecognized value fails safe to `space`
 * rather than `direct`.
 */
export function resolveConversationKind(chat: Record<string, unknown>): ChatConversationKind {
  return readSpaceType(chat) === 'DIRECT_MESSAGE' ? 'direct' : 'space';
}

/**
 * Best-effort read of the requester's IANA timezone off the add-on event's
 * `commonEventObject.timeZone.id` — a sibling of `chat` on the event object,
 * documented (for Workspace add-ons generally, Chat included) at
 * https://developers.google.com/workspace/add-ons/concepts/event-objects:
 * `commonEventObject.timeZone.id`, "The timezone identifier of the user's
 * timezone. Examples include: America/New_York, Europe/Vienna, and
 * Asia/Seoul." Used ONLY as an input to the `daily` DM conversation-window
 * option's calendar-day comparison (`shouldRestartChatConversation` in
 * `chat-conversation-window.ts`) — never for anything authorization- or
 * identity-related. Absent (Google's own docs note `timeZone` is disabled
 * by default without the Editor-add-on `useLocaleFromApp` manifest flag,
 * which this Chat app's manifest does not set) falls back to UTC at the
 * call site, never guessed at here.
 */
export function readCommonEventTimeZone(event: ChatEvent): string | undefined {
  const common = asRecord(event['commonEventObject']);
  const timeZone = asRecord(common?.['timeZone'])?.['id'];
  return typeof timeZone === 'string' && timeZone.trim() ? timeZone.trim() : undefined;
}

/**
 * Where the space lives depends on the event kind: an `ADDED_TO_SPACE`
 * event carries `chat.space`, while a `MESSAGE` event nests it under
 * `chat.messagePayload.space` (alongside `chat.messagePayload.message`).
 * Reading only the former makes every @-mention resolve to
 * `missing_space` — and, because the polite decline also needs a space to
 * reply into, produces total silence for the sender. Try both, top level
 * first.
 */
function readSpaceName(chat: Record<string, unknown> | undefined): string | undefined {
  const direct = asRecord(chat?.['space'])?.['name'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const fromMessage = asRecord(asRecord(chat?.['messagePayload'])?.['space'])?.['name'];
  if (typeof fromMessage === 'string' && fromMessage.trim()) return fromMessage.trim();
  return undefined;
}

/**
 * Why the inbound message could not be resolved to a mappable intake
 * request. Safe to log verbatim — each value is a fixed classification,
 * never a payload value.
 */
export type ChatMessageUnresolvedReason =
  | 'missing_chat_envelope'
  | 'missing_message_payload'
  | 'missing_message'
  | 'missing_text'
  | 'missing_message_name';

export interface ResolvedChatMessage {
  status: 'resolved';
  /** `chat.messagePayload.message.text`, trimmed. */
  text: string;
  /**
   * `chat.messagePayload.message.name` — the message's OWN resource id
   * (`spaces/AAA/messages/XXXX`), distinct from the thread name below.
   * Required (not optional) because this is the value Slice F's intake
   * uses as the idempotency key that collapses Chat's at-least-once
   * delivery retries onto one Case — a message we cannot name is a
   * message we cannot safely dedupe, so it is treated as unresolved
   * rather than risking a double intake.
   */
  sourceMessageName: string;
  /**
   * `chat.messagePayload.message.thread.name`, when the event carried
   * one. Unlike `sourceMessageName` this is best-effort: a reply target
   * that lacks a thread still has a valid space to post into (see
   * `ChatReplyTarget.threadName`'s own optionality), so its absence does
   * not make the whole message unresolved.
   */
  threadName?: string;
}

export interface UnresolvedChatMessage {
  status: 'unresolved';
  reason: ChatMessageUnresolvedReason;
}

export type ChatMessageResolution = ResolvedChatMessage | UnresolvedChatMessage;

/**
 * Extracts and validates the inbound message text plus its thread/message
 * identifiers from a verified add-on event (Slice F,
 * `docs/specs/clerk-config-scheduling-chat.md`).
 *
 * Deliberately reads ONLY the add-on `chat.messagePayload` shape, the same
 * scope decision `resolveChatSender` above already made for `chat.user` —
 * this app's actual registration never sends the classic
 * `{"type":"MESSAGE","message":{...}}` envelope (see `event-shape.ts`'s doc
 * comment), so a classic-shape fallback would be untested dead code, not a
 * safety net.
 *
 * `message.text`, `message.name`, and `message.thread.name` are read here on
 * the strength of Google's add-on documentation and samples. Every access
 * below is a type-guarded read of `unknown` data, so an unexpected shape
 * resolves to `unresolved` — never a throw, and never a read of the wrong
 * field.
 */
export function resolveChatMessage(event: ChatEvent): ChatMessageResolution {
  const chat = asRecord(event.chat);
  if (!chat) {
    return { status: 'unresolved', reason: 'missing_chat_envelope' };
  }

  const messagePayload = asRecord(chat['messagePayload']);
  if (!messagePayload) {
    return { status: 'unresolved', reason: 'missing_message_payload' };
  }

  const message = asRecord(messagePayload['message']);
  if (!message) {
    return { status: 'unresolved', reason: 'missing_message' };
  }

  const textRaw = message['text'];
  if (typeof textRaw !== 'string' || !textRaw.trim()) {
    return { status: 'unresolved', reason: 'missing_text' };
  }

  const sourceMessageNameRaw = message['name'];
  if (typeof sourceMessageNameRaw !== 'string' || !sourceMessageNameRaw.trim()) {
    return { status: 'unresolved', reason: 'missing_message_name' };
  }

  const thread = asRecord(message['thread']);
  const threadNameRaw = thread?.['name'];
  const threadName = typeof threadNameRaw === 'string' && threadNameRaw.trim()
    ? threadNameRaw.trim()
    : undefined;

  return {
    status: 'resolved',
    text: textRaw.trim(),
    sourceMessageName: sourceMessageNameRaw.trim(),
    ...(threadName ? { threadName } : {}),
  };
}

/**
 * Best-effort fallback read of `chat.space.name`, independent of
 * `resolveChatSender`. Used only when the sender itself failed to resolve
 * (so `ResolvedChatSender.spaceName` is not available) but a polite decline
 * still needs SOME space to reply into — see `route.ts`'s
 * `declineUnmatchedSender`. Returns `undefined` rather than throwing on any
 * unexpected shape, same discipline as everything else in this file.
 */
export function readFallbackSpaceName(event: ChatEvent): string | undefined {
  return readSpaceName(asRecord(event.chat));
}
