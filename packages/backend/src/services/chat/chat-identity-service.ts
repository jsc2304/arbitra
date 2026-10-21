import { collections, getDb } from '../../lib/firestore.js';
import type { User } from '@arbitra/shared';

/**
 * Maps a Google Chat sender to an Arbitra user account (spec Slice E,
 * `docs/specs/clerk-config-scheduling-chat.md`). See
 * `packages/frontend/src/app/api/chat/events/chat-sender.ts` for how the
 * sender identity is extracted from the verified add-on event, and
 * `route.ts`'s `dispatchEvent` for the two trigger points that call this.
 *
 * ## Why the match key is email, not the Chat resource name
 *
 * The Chat event's stable identifier is `chat.user.name`
 * (`users/123456789` — the opaque Google/People/Directory resource id,
 * also the Google OIDC `sub`). It has nothing in common with an Arbitra
 * `user_id`, which is the Firebase UID minted by `verifyIdToken` at sign-in
 * (`auth-middleware.ts`) — they are simply unrelated strings in unrelated
 * namespaces, so there is no join possible on that field alone. The only
 * field with any chance of linking the two systems is `email`: Arbitra
 * sign-in is Google-only (`GoogleAuthProvider` + `signInWithPopup`), so
 * every stored `users/{id}.email` is a real Google/Workspace address, and
 * the Chat event can (not always — see the caller) carry the same address
 * for the interacting human.
 *
 * ## Exact match only
 *
 * A loose match here is a privilege-escalation bug waiting to happen: this
 * mapping is what a later slice (Card v2 decision buttons) uses to
 * attribute an approve/reject to a person. Matching on anything less than
 * the full, normalized address would eventually let one person approve
 * cases as another. So:
 *   - the Chat-supplied address is lowercased before the query; the STORED
 *     address is compared exactly as written. The equality query cannot
 *     normalize the stored side, so a user document whose `email` was
 *     persisted with different casing will not match and stays unmapped —
 *     a missed mapping, never a wrong one, which is the safe direction.
 *     `auth-middleware.ts` is the only writer of `users/{id}.email`;
 *     lowercasing it there closes the gap and self-heals on next sign-in.
 *     Do not "fix" this by loosening the comparison;
 *   - zero matches and two-or-more matches both resolve to "stay
 *     unmapped", as two DISTINCT outcomes, never a `.limit(1)` guess that
 *     would silently pick a winner among several candidates;
 *   - there is no fallback to `displayName`, domain, or a Directory API
 *     lookup. An unmatched sender simply stays unmapped — that is correct
 *     behavior, not a bug to work around.
 *
 * ## Idempotency and the double-install-event race
 *
 * On the add-on shape, installing the app via @mention fires an
 * `ADDED_TO_SPACE` event immediately followed by a `MESSAGE` event for the
 * same interaction — both carry the same `chat.user`, and `route.ts` wires
 * both into this function. The write below happens inside a transaction
 * that re-reads the target user doc first, so whichever of the two calls
 * lands second (or a genuinely concurrent one) observes the mapping the
 * first one just committed and takes the `mapped_idempotent` branch — no
 * second write, `mapped_at` unchanged.
 *
 * ## Two deliberate design decisions
 *
 * 1. **A different Chat account can never re-map an already-mapped Arbitra
 *    user.** If `users/{id}.chat_identity.chat_user_id` is already set to
 *    a DIFFERENT value than the one this call would write, the call
 *    returns `mapping_conflict` and writes nothing. The alternative
 *    (overwrite) would let a reassigned or reused Workspace address
 *    silently re-point future decision attribution at a different physical
 *    person — exactly the mis-binding this design exists to prevent.
 *    Correcting a genuine reassignment is a deliberate admin action, not a
 *    side effect of a Chat message.
 * 2. **`space_name` is written once and never moved.** The first
 *    successful mapping's space is kept even if the same, already-mapped
 *    sender later messages the app from a different space (e.g. a shared
 *    space that also has the bot installed). `space_name` exists for
 *    outbound DM delivery in a later slice; letting an incidental
 *    group-space message overwrite it would silently break that delivery
 *    target for no behavioural benefit today.
 */
export type ChatIdentityMappingOutcome =
  | 'mapped'
  | 'mapped_idempotent'
  | 'no_email'
  | 'no_match'
  | 'ambiguous_match'
  | 'mapping_conflict';

export interface MapChatIdentityParams {
  /** The add-on's opaque `chat.user.name` resource id, e.g. `users/123456789`. */
  chatUserId: string;
  /** The add-on's `chat.space.name`, e.g. `spaces/AAAA`. */
  spaceName: string;
  /**
   * The add-on's `chat.user.email`, if the event carried one. Documented as
   * absent on at least the membership (`addedToSpacePayload`) trigger — see
   * `chat-sender.ts`.
   */
  email: string | undefined;
}

export interface MapChatIdentityResult {
  outcome: ChatIdentityMappingOutcome;
  /** Set only when a candidate Arbitra user was found (`mapped`, `mapped_idempotent`, `mapping_conflict`). */
  userId?: string;
}

/**
 * Attempts to bind `chatUserId` to the Arbitra user whose `email` exactly
 * (case-insensitively) matches `email`. See the module doc for the full
 * reasoning behind every branch below.
 */
export async function mapChatIdentity(params: MapChatIdentityParams): Promise<MapChatIdentityResult> {
  const { chatUserId, spaceName, email } = params;

  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) {
    return { outcome: 'no_email' };
  }

  // `.limit(2)`, not `.limit(1)`: reading two lets zero, one, and "two or
  // more" be told apart. A `.limit(1)` here would silently pick a winner
  // among several candidates, which is exactly the mis-binding this
  // mapping exists to prevent.
  const snapshot = await collections.users().where('email', '==', normalizedEmail).limit(2).get();
  if (snapshot.empty) {
    return { outcome: 'no_match' };
  }
  if (snapshot.docs.length > 1) {
    return { outcome: 'ambiguous_match' };
  }

  const candidateId = snapshot.docs[0]!.id;

  return getDb().runTransaction(async (tx) => {
    const ref = collections.users().doc(candidateId);
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!data) {
      // The candidate was deleted between the query above and this
      // transaction. Rare, and not worth a retry: the sender simply stays
      // unmapped until the next event re-runs the whole lookup.
      return { outcome: 'no_match' };
    }

    const existing = data.chat_identity;
    if (existing) {
      if (existing.chat_user_id === chatUserId) {
        // Same sender, same mapping already recorded — idempotent replay
        // of the install's double event (or a later message). No write:
        // `mapped_at` must not shift, and `space_name` intentionally stays
        // the first-ever value (see design decision 2 above).
        return { outcome: 'mapped_idempotent', userId: candidateId };
      }
      // Design decision 1 above: never rebind over an existing mapping.
      return { outcome: 'mapping_conflict', userId: candidateId };
    }

    const now = new Date().toISOString();
    const chatIdentity: NonNullable<User['chat_identity']> = {
      chat_user_id: chatUserId,
      space_name: spaceName,
      mapped_at: now,
    };
    tx.set(ref, { chat_identity: chatIdentity, updated_at: now }, { merge: true });
    return { outcome: 'mapped', userId: candidateId };
  });
}
