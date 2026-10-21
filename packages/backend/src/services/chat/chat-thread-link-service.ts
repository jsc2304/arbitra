import { createHash } from 'node:crypto';
import type { ChatContinuityKeyKind } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';

/** Salt for the thread-link document id. Same shape as `RECEIPT_ID_SALT` in `assistant-intake-service.ts`. */
const THREAD_LINK_ID_SALT = 'arbitra-chat-thread-link';

/**
 * Deterministic doc id for one Chat conversation's tip pointer, derived from
 * `(keyKind, key)` — a thread resource name already embeds its space (no
 * further scoping needed for `'thread_name'`), and for `'space_name'` the
 * space name alone IS the DM's identity.
 *
 * `keyKind` is folded into the hashed input, not just carried alongside it —
 * this is what keeps a `thread_name` and a `space_name` from EVER colliding
 * even if the two literal strings happened to be equal (e.g. a hypothetical
 * future Chat resource-name scheme that reused the same string shape for
 * both). Without the kind in the digest input, `chatThreadLinkId('thread_name', x)`
 * and `chatThreadLinkId('space_name', x)` would hash identically and a DM
 * could silently merge into an unrelated space's conversation (or vice
 * versa) purely by coincidence of string value.
 *
 * ## Id-scheme change (chat DM conversation-window feature) — no backfill
 *
 * Before this feature, the digest input was `prefix + threadName` (a single
 * string, no `keyKind`). This function now hashes `(keyKind, key)` instead,
 * so every `chat_thread_links` document written under the OLD scheme hashes
 * to a different id and becomes permanently unreachable through this
 * function — by design, not by accident. This is a deliberate one-time
 * consequence, not a bug: a conversation already in flight at deploy time
 * will simply fail the tip lookup on its NEXT message and start a fresh
 * root Case, exactly as if it had never had a pointer at all (see
 * `resolveChatThreadCase`'s "miss" doc). No prior conversation is lost —
 * both the old and the new root Case remain individually reachable — only
 * the CONTINUITY across the id-scheme boundary breaks, once, per affected
 * thread.
 *
 * No migration was written for this: the feature is new, so there are no
 * existing `chat_thread_links` documents to carry forward, and a backfill
 * would add migration risk for zero preserved continuity.
 */
export function chatThreadLinkId(keyKind: ChatContinuityKeyKind, key: string): string {
  const digest = createHash('sha256')
    .update(`${THREAD_LINK_ID_SALT}\0${keyKind}\0${key}`)
    .digest('hex')
    .slice(0, 32);
  return `ctl_${digest}`;
}

/** What `resolveChatThreadCase` found for one continuity key. */
export interface ChatContinuityLink {
  /** The Case currently recorded as this conversation's tip. */
  caseId: string;
  /**
   * When the tip was last advanced (`recordChatThreadTip`'s `updated_at`).
   * Load-bearing for the DM conversation-window decision
   * (`shouldRestartChatConversation`) — a SPACE lookup ignores this field
   * entirely, since a thread-keyed conversation never applies a window.
   */
  updatedAt: string;
}

/**
 * Reads the Case currently recorded as this conversation's tip, if any.
 *
 * A miss (`undefined`) means either this is the conversation's first
 * message, or a prior message in it raced past this same lookup before the
 * tip was recorded (see `recordChatThreadTip`'s doc for why that race is
 * accepted slack rather than a correctness bug) — the caller's answer in
 * both cases is the same: treat this message as starting a new root Case.
 */
export async function resolveChatThreadCase(
  keyKind: ChatContinuityKeyKind,
  key: string,
): Promise<ChatContinuityLink | undefined> {
  const snap = await collections.chatThreadLinks().doc(chatThreadLinkId(keyKind, key)).get();
  const data = snap.data();
  if (!data?.latest_case_id) return undefined;
  return { caseId: data.latest_case_id, updatedAt: data.updated_at };
}

/**
 * Advances a conversation's recorded tip to `caseId`, computing `rootCaseId`
 * from the Case's own `assistant_thread.root_case_id` (or `caseId` itself,
 * when this Case IS the root) rather than requiring the caller to track it.
 *
 * Call this ONLY after a genuinely NEW Case was created — never on an
 * idempotent replay. `AssistantIntakeService.intake`/`intakeFollowUp` report
 * `replayed: true` when the Chat message name was already seen (Chat's own
 * at-least-once redelivery); writing the pointer again on that path risks
 * rolling the tip backward if the replay's stale message is delivered late,
 * AFTER a genuinely later follow-up already advanced it.
 *
 * This write is a plain upsert, not part of the intake transaction — it is
 * a routing hint, not the idempotency guarantee (the message-name-keyed
 * `AssistantIntakeReceipt` is). Two concurrent FIRST messages in a brand new
 * conversation can each miss `resolveChatThreadCase` above and both create a
 * root Case; whichever write lands last here wins the tip, and the other
 * root becomes an orphan for future routing purposes. Accepted slack, same
 * class as the per-user limit race `AssistantIntakeService`'s own doc
 * comment already documents — rare, and not a data-loss bug (both Cases
 * still exist and are still reachable individually).
 */
export async function recordChatThreadTip(
  keyKind: ChatContinuityKeyKind,
  key: string,
  rootCaseId: string,
  caseId: string,
): Promise<void> {
  const ref = collections.chatThreadLinks().doc(chatThreadLinkId(keyKind, key));
  await ref.set(
    {
      thread_link_id: ref.id,
      continuity_key_kind: keyKind,
      continuity_key: key,
      root_case_id: rootCaseId,
      latest_case_id: caseId,
      updated_at: new Date().toISOString(),
    },
    { merge: true },
  );
}
