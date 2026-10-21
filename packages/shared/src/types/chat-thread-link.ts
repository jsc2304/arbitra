/**
 * Which kind of Chat coordinate a `ChatThreadLink` is keyed on.
 *
 * `thread_name` — a Chat SPACE conversation, keyed on the explicit Chat
 * thread resource name (`spaces/AAA/threads/BBB`). Unchanged behavior: a
 * thread resource name already embeds its space, so no further scoping key
 * is needed. This is the ONLY kind that existed before the chat DM
 * conversation-window feature, and its routing behavior is unchanged by it.
 *
 * `space_name` — a Chat DIRECT MESSAGE, keyed on the space itself
 * (`spaces/AAAA`). A Chat DM is flat: every message gets its OWN thread, so
 * keying continuity on `thread_name` there would open a new root Case on
 * every single message — see `docs/specs/clerk-config-scheduling-chat.md`
 * and `chat-sender.ts`'s `resolveConversationKind` for the `spaceType`
 * signal (`DIRECT_MESSAGE`) that decides which kind applies to one event.
 *
 * A `thread_name` and a `space_name` are never comparable — see
 * `chatThreadLinkId`'s doc for why the two can never collide even if the
 * literal string values happened to be equal.
 */
export type ChatContinuityKeyKind = 'thread_name' | 'space_name';

/**
 * Mutable pointer to the current tip Case of one Chat conversation —
 * either a SPACE's thread, or a DM's space itself
 * (`docs/specs/clerk-config-scheduling-chat.md` Slice F inbound, generalized
 * for the chat DM conversation-window feature). Doc id is derived from
 * `(continuity_key_kind, continuity_key)` (`chatThreadLinkId` in
 * `chat-thread-link-service.ts`).
 *
 * Unlike `AssistantIntakeReceipt` (write-once, keyed by the Chat message
 * name — the thing that actually guarantees at most one Case per inbound
 * message), this pointer is overwritten every time a genuinely NEW Case is
 * accepted for the conversation, so a read always names its current tip. It
 * is a routing hint, not an idempotency mechanism: reading it decides
 * whether the next message becomes a follow-up turn
 * (`AssistantIntakeService.intakeFollowUp`) or a new root Case, never
 * whether the message has already been processed.
 *
 * For a DM (`continuity_key_kind: 'space_name'`), `updated_at` additionally
 * drives the DM conversation-window decision
 * (`shouldRestartChatConversation` in `chat-conversation-window.ts`): how
 * long ago the tip was last advanced decides whether `idle_gap`/`daily`
 * treat this pointer as still current or start a fresh root regardless of
 * the pointed-to Case's own status. A SPACE conversation
 * (`continuity_key_kind: 'thread_name'`) never applies a window — it always
 * uses this pointer exactly as before the conversation-window feature.
 */
export interface ChatThreadLink {
  thread_link_id: string;
  /** Which coordinate `continuity_key` is — see `ChatContinuityKeyKind`'s doc. */
  continuity_key_kind: ChatContinuityKeyKind;
  /** The Chat thread OR space resource name this pointer is keyed on, kept for audit. */
  continuity_key: string;
  /** First Case created for this conversation. Never changes once set. */
  root_case_id: string;
  /** Most recent Case created for this conversation — the follow-up target. */
  latest_case_id: string;
  updated_at: string;
}
