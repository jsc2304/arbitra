import type { Notification, NotificationPage, NotificationType } from '@arbitra/shared';
import { collections, getDb } from '../../lib/firestore.js';

/**
 * `FieldPath.documentId()` in string form: the tiebreak Firestore applies to
 * every query anyway, appended to each composite index in the direction of
 * its last field (same idiom as `tool-reads.ts`'s `DOCUMENT_ID_FIELD`).
 * Ordering by it explicitly is what makes the page boundary expressible as a
 * cursor; it needs no index that does not already exist. It also happens to
 * equal `notification_id` here (`create`/`createOrRefresh` always write at
 * `.doc(notification.notification_id)`), so a decoded cursor's id half can
 * be passed to `startAfter` without a second lookup.
 */
const DOCUMENT_ID_FIELD = '__name__';

const DEFAULT_PAGE_LIMIT = 30;
const MAX_PAGE_LIMIT = 100;

export interface ListPageOptions {
  unreadOnly?: boolean;
  /** Opaque — the previous page's `next_cursor`, unchanged. */
  cursor?: string;
  /** Clamped to `[1, MAX_PAGE_LIMIT]`; defaults to `DEFAULT_PAGE_LIMIT`. */
  limit?: number;
}

function clampLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(Math.trunc(requested), MAX_PAGE_LIMIT));
}

/** `${created_at}\0${notification_id}` — a control char never present in either half. */
function encodeCursor(createdAt: string, notificationId: string): string {
  return Buffer.from(`${createdAt}\0${notificationId}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { createdAt: string; notificationId: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf('\0');
  if (sep < 0) return null;
  const createdAt = decoded.slice(0, sep);
  const notificationId = decoded.slice(sep + 1);
  if (!createdAt || !notificationId) return null;
  return { createdAt, notificationId };
}

export class NotificationRepository {
  async create(notification: Notification): Promise<Notification> {
    await collections.notifications().doc(notification.notification_id).set(notification);
    return notification;
  }

  /**
   * Create-or-refresh primitive behind the dedup fix for issue #794 P0
   * ("Notification duplication and overload" — the drawer rendered 48
   * notifications with visible duplicate approval entries for the same
   * case). A `candidate` identical in `(user_id, type, case_id)` to an
   * existing UNREAD notification refreshes that doc (latest title/body,
   * `created_at` bumped to now so it resurfaces at the top of the list)
   * instead of inserting a second row; once a row is read, the slot is
   * vacated and the next matching occurrence creates a new one — this is
   * deliberately narrower than `finding-idempotency.ts`'s permanent
   * deterministic-id reactivation (which coalesces regardless of terminal
   * status): a notification a user has already dismissed is history, not a
   * live slot to resurrect.
   *
   * Concurrency-safe via a transaction, the second idiom this module's
   * callers were pointed at (alongside `finding-idempotency.ts`'s
   * deterministic-id create-only write): `tx.get(dupQuery)` folds the
   * "does an unread duplicate exist" read into the transaction, and
   * Firestore's conflict detection tracks the QUERY's result set, not just
   * documents fetched by ref — if a concurrent call commits a notification
   * that would now match `dupQuery` before this one commits, this
   * transaction is retried from the top, and the retry's `tx.get` observes
   * the just-created row and takes the refresh branch instead of creating a
   * second one. No composite index is needed for `dupQuery`: it is
   * equality-only across every field (`user_id`, `type`, `case_id`, `read`),
   * and Cloud Firestore serves equality-only multi-field queries from the
   * automatic single-field indexes without a manual composite.
   *
   * Notifications without a `case_id` (none of today's call sites omit it,
   * but the field is optional) skip the dedup check entirely and always
   * create — there is no third key to match a duplicate against.
   */
  async createOrRefresh(
    candidate: Notification,
  ): Promise<{ notification: Notification; outcome: 'created' | 'refreshed' }> {
    if (!candidate.case_id) {
      await this.create(candidate);
      return { notification: candidate, outcome: 'created' };
    }

    return getDb().runTransaction(async (tx) => {
      const dupQuery = collections.notifications()
        .where('user_id', '==', candidate.user_id)
        .where('type', '==', candidate.type)
        .where('case_id', '==', candidate.case_id)
        .where('read', '==', false)
        .limit(1);
      const existingSnap = await tx.get(dupQuery);

      if (existingSnap.empty) {
        tx.set(collections.notifications().doc(candidate.notification_id), candidate);
        return { notification: candidate, outcome: 'created' as const };
      }

      const existingDoc = existingSnap.docs[0]!;
      const refresh = {
        title: candidate.title,
        body: candidate.body,
        created_at: candidate.created_at,
      };
      tx.update(existingDoc.ref, refresh);
      return { notification: { ...existingDoc.data(), ...refresh }, outcome: 'refreshed' as const };
    });
  }

  /**
   * Cursor-paginated list for issue #794 P0 ("no grouping, filtering, or
   * pagination" over 48 rendered notifications). Ordered `created_at DESC`
   * with `DOCUMENT_ID_FIELD` as an explicit tiebreak — see that constant's
   * doc comment for why the tiebreak needs no new index — so a page
   * boundary is a total order position and pages neither overlap nor gap
   * even when several notifications share one `created_at` (a burst from
   * `notifyRuleViolations`/`notifyCriticalFindings` fan-out, for example).
   *
   * `unread_count` is always the caller's TOTAL unread count (a `.count()`
   * aggregation, not `notifications.length` on this page) so the notification
   * bell badge is correct before "load more" is ever clicked.
   */
  async listPage(userId: string, options: ListPageOptions = {}): Promise<NotificationPage> {
    const limit = clampLimit(options.limit);

    let query: FirebaseFirestore.Query<Notification> = collections.notifications()
      .where('user_id', '==', userId);
    if (options.unreadOnly) {
      query = query.where('read', '==', false);
    }
    query = query.orderBy('created_at', 'desc').orderBy(DOCUMENT_ID_FIELD, 'desc');

    if (options.cursor) {
      const decoded = decodeCursor(options.cursor);
      if (decoded) {
        query = query.startAfter(decoded.createdAt, decoded.notificationId);
      }
      // A malformed/foreign cursor is ignored rather than rejected — the
      // request degrades to a first page instead of erroring the drawer.
    }

    const [snapshot, unreadCount] = await Promise.all([
      query.limit(limit).get(),
      this.countUnread(userId),
    ]);

    const notifications = snapshot.docs.map((doc) => doc.data());
    const last = notifications[notifications.length - 1];
    const next_cursor = notifications.length === limit && last
      ? encodeCursor(last.created_at, last.notification_id)
      : null;

    return { notifications, next_cursor, unread_count: unreadCount };
  }

  private async countUnread(userId: string): Promise<number> {
    const snap = await collections.notifications()
      .where('user_id', '==', userId)
      .where('read', '==', false)
      .count()
      .get();
    return snap.data().count;
  }

  async getById(notificationId: string): Promise<Notification | null> {
    const doc = await collections.notifications().doc(notificationId).get();
    return doc.exists ? doc.data()! : null;
  }

  async markAsRead(notificationId: string): Promise<void> {
    await collections.notifications().doc(notificationId).update({ read: true });
  }

  /**
   * Bulk "mark all as read" for a user, scoped server-side to EVERY unread
   * row rather than whichever page happens to be loaded client-side — the
   * necessary companion to `listPage`'s pagination: without this, "mark all
   * as read" over a paginated drawer could only ever mark the loaded page,
   * silently leaving older unread rows behind. Firestore batches cap at 500
   * writes; chunked defensively even though a single user's unread count
   * realistically never approaches that.
   */
  async markAllAsRead(userId: string): Promise<number> {
    const snap = await collections.notifications()
      .where('user_id', '==', userId)
      .where('read', '==', false)
      .get();
    if (snap.empty) return 0;

    const BATCH_CHUNK = 500;
    for (let i = 0; i < snap.docs.length; i += BATCH_CHUNK) {
      const batch = getDb().batch();
      for (const doc of snap.docs.slice(i, i + BATCH_CHUNK)) {
        batch.update(doc.ref, { read: true });
      }
      await batch.commit();
    }
    return snap.docs.length;
  }

  /**
   * Reconciliation for issue #794 P0 ("Stale actionable notifications" —
   * scoped here to exactly the case the issue and the follow-up comment
   * name: an unread `gate_pending` superseded by `gate_confirmed`/
   * `gate_rejected` for the SAME case). `gate_pending` fans out to every
   * reviewer/tech-lead in the pool (`EventNotifier.notifyGatePending`), but
   * only the case owner gets a `gate_confirmed`/`gate_rejected`
   * notification — so without this, every OTHER reviewer's copy stays
   * unread and actionable ("awaits your confirmation") forever after the
   * gate has already been resolved by someone. Marks read (not deleted):
   * the row remains in history, just no longer counted unread or
   * highlighted, same as any notification the user dismissed themselves.
   * Scoped by `case_id` only (not `user_id`) so it clears every recipient's
   * copy, not just the actor's.
   *
   * Equality-only query (`case_id`, `type`, `read`) — no composite index
   * needed, same reasoning as `createOrRefresh`'s `dupQuery`.
   *
   * Callers MUST only invoke this for the case-level LIFECYCLE gate
   * decision, never for a RULE-level `human_confirmation` gate decision
   * (`DecisionService.resolveHumanConfirmationGate`, payload tagged
   * `gate_kind: 'human_confirmation_rule'`) — `gate_confirmed`/
   * `gate_rejected` are emitted for both, architecturally-independent gate
   * kinds. This query has no way to tell them apart itself (it only knows
   * `case_id`), so the discrimination happens at the call site —
   * `EventNotifier.notifyGateConfirmed`/`notifyGateRejected` — before this
   * method is ever reached. Safe today because only the lifecycle gate
   * (`pipeline.ts`'s `emitGatePending`) ever writes a `gate_pending`
   * notification in the first place, but that's a property of the caller,
   * not of this query.
   */
  async markStaleGatePending(caseId: string): Promise<number> {
    const snap = await collections.notifications()
      .where('case_id', '==', caseId)
      .where('type', '==', 'gate_pending' satisfies NotificationType)
      .where('read', '==', false)
      .get();
    if (snap.empty) return 0;

    const batch = getDb().batch();
    for (const doc of snap.docs) {
      batch.update(doc.ref, { read: true });
    }
    await batch.commit();
    return snap.docs.length;
  }

  /**
   * Reconciliation for issue #1073 (split out of #794):
   * `notifyHumanDecisionNeeded` fans a `case_needs_decision` notification out
   * to every reviewer/tech-lead + the owner (`EventNotifier.notifyHumanDecisionNeeded`),
   * but until this method existed nothing cleared those rows once the
   * decision actually happened — every non-acting recipient kept an unread,
   * actionable-looking "Decision required" pointed at an already-resolved
   * case, forever. Same shape as `markStaleGatePending` above, scoped to
   * `type == 'case_needs_decision'` instead of `gate_pending`: marks read
   * (not deleted), equality-only query (`case_id`, `type`, `read` — no
   * composite index needed, identical reasoning), scoped by `case_id` only so
   * it clears every recipient's copy, not just the acting one.
   */
  async markStaleCaseNeedsDecision(caseId: string): Promise<number> {
    const snap = await collections.notifications()
      .where('case_id', '==', caseId)
      .where('type', '==', 'case_needs_decision' satisfies NotificationType)
      .where('read', '==', false)
      .get();
    if (snap.empty) return 0;

    const batch = getDb().batch();
    for (const doc of snap.docs) {
      batch.update(doc.ref, { read: true });
    }
    await batch.commit();
    return snap.docs.length;
  }

  async delete(notificationId: string): Promise<void> {
    await collections.notifications().doc(notificationId).delete();
  }
}
