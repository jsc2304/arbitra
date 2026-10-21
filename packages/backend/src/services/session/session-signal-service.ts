import crypto from 'node:crypto';
import {
  sessionSignalEventSchema,
  SESSION_LIVENESS_WINDOW_MS,
} from '@arbitra/shared';
import type {
  ActiveSessionSummary,
  SessionActivityRecord,
  SessionRegistryEntry,
  SessionSignalEvent,
  SessionSignalEventReceipt,
  SessionSignalIngestOutcome,
  SessionSignalIngestResult,
} from '@arbitra/shared';
import { collections, getDb } from '../../lib/firestore.js';

/**
 * Deterministic doc id for the idempotency receipt of one event. Hashing
 * (rather than using `event_id` verbatim) keeps the id well-formed and
 * length-bounded regardless of what a client sends as `event_id`.
 */
export function sessionSignalEventDocId(eventId: string): string {
  return crypto.createHash('sha256').update(eventId).digest('hex');
}

/**
 * Ingest one batch of Session Signal events (issue #983 / ADR-0001).
 *
 * Validation happens per item: an invalid item is reported as `rejected` in
 * its own result slot and every other item in the batch is still processed
 * — one bad event never sinks the batch.
 *
 * Idempotency is a transactional atomic claim on a deterministic doc id
 * derived from the client-supplied `event_id` (`tx.create`, which throws if
 * the doc already exists) — never a check-then-insert. A duplicate
 * `event_id`, in any order of arrival relative to itself, is reported as
 * `duplicate` and mutates nothing.
 */
export interface IngestSessionSignalBatchOptions {
  /**
   * The authenticated caller emitting this batch (issue #990), from
   * `authenticate()` at the route boundary — never from the event payload
   * itself, which carries no identity field. Stamped onto every session
   * entry the batch touches; omitted when the caller couldn't be resolved
   * to a user id, leaving `user_id` unset on the entry.
   */
  userId?: string;
}

export async function ingestSessionSignalBatch(
  rawEvents: readonly unknown[],
  options: IngestSessionSignalBatchOptions = {},
): Promise<SessionSignalIngestResult> {
  const results: SessionSignalIngestOutcome[] = [];

  for (let index = 0; index < rawEvents.length; index += 1) {
    const parsed = sessionSignalEventSchema.safeParse(rawEvents[index]);
    if (!parsed.success) {
      results.push({
        index,
        status: 'rejected',
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; '),
        },
      });
      continue;
    }
    results.push(await ingestOne(parsed.data, index, options.userId));
  }

  return {
    accepted: results.filter((r) => r.status === 'accepted').length,
    duplicate: results.filter((r) => r.status === 'duplicate').length,
    rejected: results.filter((r) => r.status === 'rejected').length,
    results,
  };
}

async function ingestOne(
  event: SessionSignalEvent,
  index: number,
  userId?: string,
): Promise<SessionSignalIngestOutcome> {
  const receiptRef = collections.sessionSignalEvents().doc(sessionSignalEventDocId(event.event_id));
  const sessionRef = collections.sessions().doc(event.session_id);
  // Server receipt time — authoritative for ordering and liveness. Captured
  // once per event, before the transaction, so retries of the *same* claim
  // attempt (not applicable here — each event is processed once) would not
  // skew it; what matters is that this is never the client's clock.
  const receivedAt = new Date().toISOString();

  const claimed = await getDb().runTransaction(async (tx) => {
    const receiptSnap = await tx.get(receiptRef);
    if (receiptSnap.exists) return false;

    const sessionSnap = await tx.get(sessionRef);

    const receipt: SessionSignalEventReceipt = {
      event_id: event.event_id,
      session_id: event.session_id,
      event_type: event.event_type,
      received_at: receivedAt,
      ...(event.client_timestamp !== undefined && { client_timestamp: event.client_timestamp }),
    };
    tx.create(receiptRef, receipt);

    const ended = event.event_type === 'session_end';

    if (sessionSnap.exists) {
      const existing = sessionSnap.data() as SessionRegistryEntry;
      // Only ever move last_seen_at forward. Since receipt time is captured
      // per event as it is processed, an event that (despite being new,
      // undeduplicated) reflects an older moment than what is already
      // stored never overwrites the more recent state.
      if (receivedAt >= existing.last_seen_at) {
        // `ended` is sticky: once a session_end has been recorded, no later
        // event — even a legitimately new, undeduplicated one — may flip it
        // back to false. There is no "un-end" event in this contract; a
        // heartbeat/session_start arriving after session_end (out-of-order
        // delivery, or a client that kept sending after ending) still
        // updates the metadata below, but must never resurrect the session.
        const nextEnded = existing.ended || ended;
        const patch: Partial<SessionRegistryEntry> = {
          agent_name: event.agent_name,
          repository: event.repository,
          branch: event.branch,
          last_event_type: event.event_type,
          ended: nextEnded,
          last_seen_at: receivedAt,
        };
        if (event.client_timestamp !== undefined) {
          patch.client_last_timestamp = event.client_timestamp;
        }
        // `user_id` tracks the most recent authenticated caller, mirroring
        // `last_seen_at`/`agent_name` — not sticky like `ended`. Only
        // written when this call actually resolved a caller, so a batch
        // ingested without auth context never clobbers a previously-known
        // user_id with `undefined`.
        if (userId !== undefined) {
          patch.user_id = userId;
        }
        tx.set(sessionRef, patch, { merge: true });
      }
    } else {
      const entry: SessionRegistryEntry = {
        session_id: event.session_id,
        agent_name: event.agent_name,
        repository: event.repository,
        branch: event.branch,
        last_event_type: event.event_type,
        ended,
        first_seen_at: receivedAt,
        last_seen_at: receivedAt,
        ...(event.client_timestamp !== undefined && { client_last_timestamp: event.client_timestamp }),
        ...(userId !== undefined && { user_id: userId }),
      };
      tx.set(sessionRef, entry);
    }

    return true;
  });

  return { index, event_id: event.event_id, status: claimed ? 'accepted' : 'duplicate' };
}

/**
 * Read-time liveness derivation — never stored. A session with no heartbeat
 * within `SESSION_LIVENESS_WINDOW_MS` of `referenceTime` reads as ended,
 * regardless of what is persisted; an explicit `session_end` always wins.
 */
export function isSessionEntryActive(
  entry: SessionRegistryEntry,
  referenceTime: Date = new Date(),
): boolean {
  if (entry.ended) return false;
  const lastSeenMs = Date.parse(entry.last_seen_at);
  return referenceTime.getTime() - lastSeenMs < SESSION_LIVENESS_WINDOW_MS;
}

/**
 * Mission-Control read path (issue #983's slice of it): every session
 * currently reading as active, projected to repository/branch/agent/session
 * id/last-seen. Computed on read, mirroring the existing Observatory /
 * `agentPresence` style — no separate storage layer for "active now".
 */
export async function listActiveSessions(
  referenceTime: Date = new Date(),
): Promise<ActiveSessionSummary[]> {
  // Bound the read: `ended == false` plus a `last_seen_at` range excludes
  // both explicitly-ended sessions and anything already outside the
  // liveness window at the database layer, instead of scanning every
  // session document ever written. Composite index in
  // `firestore.indexes.json`. `isSessionEntryActive` below still runs on
  // every returned doc — belt and suspenders, and the actual source of
  // truth for "active" (this query is just a bound on it).
  const cutoffIso = new Date(referenceTime.getTime() - SESSION_LIVENESS_WINDOW_MS).toISOString();
  const snapshot = await collections
    .sessions()
    .where('ended', '==', false)
    .where('last_seen_at', '>=', cutoffIso)
    .get();
  const active: ActiveSessionSummary[] = [];
  snapshot.forEach((doc: { data: () => SessionRegistryEntry }) => {
    const entry = doc.data();
    if (!isSessionEntryActive(entry, referenceTime)) return;
    active.push({
      session_id: entry.session_id,
      agent_name: entry.agent_name,
      repository: entry.repository,
      branch: entry.branch,
      last_seen_at: entry.last_seen_at,
    });
  });
  return active;
}

/**
 * Windowed-activity read path (issue #990): every session whose
 * `last_seen_at` falls on or after `cutoff`, regardless of `ended` —
 * activity history over a window, not the 5-minute "active now" liveness
 * check `listActiveSessions` applies. This is the raw material for the
 * 24h/7d/30d panel: callers pass the widest window's cutoff once and bucket
 * the result in memory, rather than issuing one query per window.
 *
 * Bounded at the database layer by the single `last_seen_at >= cutoff`
 * range filter — no composite index required (a lone range filter uses
 * Firestore's automatic single-field index), and no full-collection scan.
 */
export async function listSessionsSince(cutoff: Date): Promise<SessionActivityRecord[]> {
  const cutoffIso = cutoff.toISOString();
  const snapshot = await collections.sessions().where('last_seen_at', '>=', cutoffIso).get();
  const records: SessionActivityRecord[] = [];
  snapshot.forEach((doc: { data: () => SessionRegistryEntry }) => {
    const entry = doc.data();
    records.push({
      session_id: entry.session_id,
      repository: entry.repository,
      last_seen_at: entry.last_seen_at,
      ...(entry.user_id !== undefined && { user_id: entry.user_id }),
    });
  });
  return records;
}
