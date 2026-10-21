/**
 * Session Signals — the one new write boundary from ADR-0001 (observe by
 * default). A developer's agent emits `session_start` / `heartbeat` /
 * `session_end` events so Arbitra can build a live session registry without
 * requiring a case to exist first.
 *
 * Payloads are deliberately shaped to carry identity and location only —
 * agent name, repository, branch, session id. There is no field anywhere in
 * this shape for tool output, diffs, or code, by construction: adding one
 * would be a conscious schema change, not an oversight.
 *
 * The wire schema has no version in the URL. Instead every event carries its
 * own `schema_version` so the payload can evolve additively (Zalando
 * 113/115/116 — see `docs/adr/0001-observe-by-default-enforce-by-policy.md`
 * and issue #981 for the sourcing).
 */

/** Lifecycle stage a single Session Signal event reports. */
export type SessionSignalEventType = 'session_start' | 'heartbeat' | 'session_end';

/**
 * One event in an ingestion batch, as sent by the client. `event_id` is
 * client-generated and is the idempotency key: the ingestion seam upserts
 * keyed on it, so retries and out-of-order delivery are expected and
 * harmless, never errors.
 *
 * `client_timestamp`, when present, is informational only — server receipt
 * time is what drives ordering and liveness (see `SessionRegistryEntry`).
 */
export interface SessionSignalEvent {
  event_id: string;
  schema_version: number;
  event_type: SessionSignalEventType;
  agent_name: string;
  /** Repository id (preferred) or a remote URL when the id isn't known yet. */
  repository: string;
  branch: string;
  session_id: string;
  client_timestamp?: string;
}

/** Outcome of ingesting one batch item, keyed to its position in the request. */
export type SessionSignalIngestStatus = 'accepted' | 'duplicate' | 'rejected';

export interface SessionSignalIngestOutcome {
  index: number;
  event_id?: string;
  status: SessionSignalIngestStatus;
  error?: {
    code: string;
    message: string;
  };
}

export interface SessionSignalIngestResult {
  accepted: number;
  duplicate: number;
  rejected: number;
  results: SessionSignalIngestOutcome[];
}

/**
 * The idempotency receipt for one ingested event. Doc id is a deterministic
 * hash of `event_id` (see `sessionSignalEventDocId` in the backend service) —
 * never queried, only claimed via a transactional `create`, which is what
 * makes duplicate/out-of-order delivery of the same `event_id` a no-op
 * instead of a second session mutation.
 */
export interface SessionSignalEventReceipt {
  event_id: string;
  session_id: string;
  event_type: SessionSignalEventType;
  /** Server receipt timestamp (ISO 8601) — authoritative, unlike `client_timestamp`. */
  received_at: string;
  client_timestamp?: string;
}

/** Derived read-time status of a session (never stored — see `isSessionActive`). */
export type SessionLivenessStatus = 'active' | 'ended';

/**
 * A row in the session registry: one document per `session_id`, upserted by
 * every event that carries it. `last_seen_at` is a server receipt timestamp,
 * advanced monotonically as events are processed — it is what drives the
 * liveness window, not any client-supplied time.
 */
export interface SessionRegistryEntry {
  session_id: string;
  agent_name: string;
  repository: string;
  branch: string;
  /** Event type of whichever event most recently advanced `last_seen_at`. */
  last_event_type: SessionSignalEventType;
  /** Explicit end signal received — takes precedence over the liveness window. */
  ended: boolean;
  first_seen_at: string;
  last_seen_at: string;
  /** Informational only — the client's own clock at the last processed event. */
  client_last_timestamp?: string;
  /**
   * The authenticated caller that emitted the most recent event for this
   * session (issue #990) — populated server-side from `authenticate()` at
   * ingestion, never from event payload. Absent for events accepted before
   * this field existed, and for any future caller that authenticates by a
   * mechanism `authenticate()` can't resolve to a user id; the 24h/7d/30d
   * distinct-users panel counts only sessions that carry it, with total
   * session count as the fallback metric everywhere it's absent.
   */
  user_id?: string;
}

/** Projection returned by the active-sessions read path. */
export interface ActiveSessionSummary {
  session_id: string;
  agent_name: string;
  repository: string;
  branch: string;
  last_seen_at: string;
}

/**
 * Projection returned by the windowed activity read path (issue #990,
 * `listSessionsSince`) — the raw material for the 24h/7d/30d panel. Unlike
 * `ActiveSessionSummary`, this is not filtered to the 5-minute liveness
 * window: a session appears here as long as its `last_seen_at` is inside
 * the caller-supplied cutoff, whether or not it has since ended.
 */
export interface SessionActivityRecord {
  session_id: string;
  repository: string;
  last_seen_at: string;
  user_id?: string;
}
