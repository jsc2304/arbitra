import type { WorkspaceEvent, WorkspaceEventDismissal } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';
import { generateId } from '../../lib/ids.js';

/** Stable helper so tests and callers agree on the dismissal doc id shape. */
export function dismissalDocId(userId: string, eventId: string): string {
  return `${userId}_${eventId}`;
}

/**
 * Input shape for recording a workspace-level event. `event_id` and
 * `timestamp` are filled in by the service so callers don't have to manage
 * ids or clock alignment.
 */
export type RecordWorkspaceEventInput = Omit<WorkspaceEvent, 'event_id' | 'timestamp'> & {
  /** Optional override, useful for tests / backfills. Defaults to now(). */
  timestamp?: string;
  /**
   * Optional deterministic id override. When omitted, a fresh random id is
   * generated. Callers that want at-most-one event per logical occurrence
   * (e.g. one duplicate-repository-id conflict per `(github id, day)`) pass a
   * stable id here so repeat `record` calls overwrite the same document
   * instead of spamming the activity feed. Mirrors the `(repo, day)` dedup
   * pattern used by the push-only misconfig detector.
   */
  event_id?: string;
};

/**
 * Thin write-path wrapper around the `workspace_events` collection. Kept
 * deliberately minimal — no validation beyond what Firestore enforces — so
 * callers can't accidentally diverge from the canonical shape.
 *
 * Reads go through `listActivity` (which unifies workspace_events with the
 * other activity sources) rather than this service. If a dedicated read
 * surface becomes necessary later, extend here.
 */
function buildEvent(input: RecordWorkspaceEventInput): WorkspaceEvent {
  return {
    event_id: input.event_id ?? generateId('workspaceEvent'),
    type: input.type,
    actor_user_id: input.actor_user_id,
    ...(input.actor_metadata ? { actor_metadata: input.actor_metadata } : {}),
    timestamp: input.timestamp ?? new Date().toISOString(),
    summary: input.summary,
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };
}

export class WorkspaceEventService {
  async record(input: RecordWorkspaceEventInput): Promise<WorkspaceEvent> {
    const event = buildEvent(input);
    await collections.workspaceEvents().doc(event.event_id).set(event);
    return event;
  }

  /**
   * Stage one workspace-event write inside `transaction`, mirroring
   * `EventRepository.createInTransaction`. Use this (not `record`) whenever
   * the audit event must land atomically with the state change it
   * describes — e.g. a read-modify-write on the same document the event
   * reports on, where an audit write issued only after the transaction
   * commits could observe a doc that a retry already changed again, or
   * could simply never run if the process dies between commit and the
   * follow-up write. `record`'s own single non-transactional `.set()` has
   * no such follow-up step to lose.
   *
   * Callers pass this the SAME transaction whose commit must include this
   * write — do not call it after `runTransaction` has resolved, and do not
   * use it to defer a side effect (see `EventService.notifyCommitted` for
   * that pattern instead, which exists precisely because notifications are
   * NOT safe to stage this way).
   */
  recordInTransaction(
    transaction: FirebaseFirestore.Transaction,
    input: RecordWorkspaceEventInput,
  ): WorkspaceEvent {
    const event = buildEvent(input);
    const ref = collections.workspaceEvents().doc(event.event_id);
    transaction.set(ref, event);
    return event;
  }

  /**
   * Single-row lookup by id. Returns `null` when the document is missing so
   * callers can render a 404 without catching a thrown error. Used by the
   * workspace-event detail drawer (PR 2).
   */
  async get(eventId: string): Promise<WorkspaceEvent | null> {
    const doc = await collections.workspaceEvents().doc(eventId).get();
    if (!doc.exists) return null;
    const data = doc.data();
    return data ?? null;
  }

  /**
   * Globally resolve a workspace event. Writes `resolved_at` + `resolved_by`
   * onto the canonical doc so every viewer's activity feed drops the row
   * after the next fetch. Idempotent: calling twice is a no-op semantically
   * (the second write simply overwrites the timestamp). Returns the updated
   * event, or `null` if the event id does not exist (caller maps to 404).
   */
  async resolve(eventId: string, byUserId: string): Promise<WorkspaceEvent | null> {
    const ref = collections.workspaceEvents().doc(eventId);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const resolved_at = new Date().toISOString();
    await ref.set({ resolved_at, resolved_by: byUserId }, { merge: true });
    const after = await ref.get();
    return after.data() ?? null;
  }

  /**
   * Dismiss a workspace event for a single viewer. Upserts the dismissal
   * doc keyed by `${userId}_${eventId}`; repeat calls just refresh
   * `dismissed_at`. Does NOT verify the event exists — a dismissal of a
   * deleted event is harmless (never joins back in) and skipping the extra
   * read halves latency on the hot dismiss path.
   */
  async dismissForUser(eventId: string, userId: string): Promise<WorkspaceEventDismissal> {
    const doc: WorkspaceEventDismissal = {
      user_id: userId,
      event_id: eventId,
      dismissed_at: new Date().toISOString(),
    };
    await collections.workspaceEventDismissals().doc(dismissalDocId(userId, eventId)).set(doc);
    return doc;
  }

  /**
   * Returns the set of workspace-event ids dismissed by `userId`. Used by
   * the activity feed to filter rows before returning them. One read per
   * request, on a collection that stays small in practice (one doc per
   * user × dismissed event).
   */
  async listDismissedEventIdsForUser(userId: string): Promise<Set<string>> {
    const snap = await collections.workspaceEventDismissals()
      .where('user_id', '==', userId)
      .get();
    const ids = new Set<string>();
    for (const doc of snap.docs) {
      const data = doc.data();
      if (data?.event_id) ids.add(data.event_id);
    }
    return ids;
  }
}
