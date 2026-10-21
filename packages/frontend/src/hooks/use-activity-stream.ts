'use client';

import { useEffect, useRef } from 'react';
import type { ActivityEntry } from '@arbitra/shared';
import { getToken } from '../lib/api-client';
import type { ActivityFilters } from './use-activity-feed';

/**
 * Subscribe to /api/activity/stream (SSE) and forward each pushed
 * ActivityEntry to `onEvent`.
 *
 * Why a custom hook (rather than a SWR subscription):
 *  - EventSource is one-way push; SWR's contract is request/response.
 *  - The component that owns the feed cache wants to apply pushes as deltas
 *    *and* track per-id "isFresh" timing — that's a side effect, not a
 *    cache mutation.
 *
 * Behavior:
 *  - Opens an EventSource scoped to the current filters and the latest
 *    timestamp the caller already holds (`since`). Reopens whenever any of
 *    those change.
 *  - The hook reconnects on transient disconnects after fetching a fresh
 *    bearer token. This avoids EventSource replaying an expired token URL.
 *    Error reconnects use exponential backoff with full jitter; graceful
 *    server rotations ('bye') reconnect fast but jittered — see
 *    `computeReconnectDelay` below.
 *  - When `EventSource` is unavailable (older browsers, SSR, tests without
 *    polyfill), the hook is a no-op — the existing SWR poll inside
 *    `useActivityFeed` continues to keep the feed fresh.
 *  - While the tab is hidden (`documentVisibilitySource`), the connection
 *    pauses: no open EventSource, no pending reconnect timer, and
 *    `onConnectionChange('closed')` fires so the UI reflects it. On
 *    becoming visible again it reconnects from scratch (fresh token, fresh
 *    `since` via the caller's ref) rather than trying to resume — cheaper
 *    than tracking a gap, and the caller already re-reads its latest cursor
 *    on every open.
 *  - `onError` is fired on transport errors so the UI can flip the live
 *    pulse to "paused"; the hook itself does not surface the error to React.
 */
export interface UseActivityStreamOptions {
  /** Disable the connection (e.g. tab is hidden). Default: true. */
  enabled?: boolean;
  filters?: ActivityFilters;
  /** Newest timestamp the caller already has — server won't replay older. */
  since: string | null;
  /** Called once per pushed entry, in arrival order. */
  onEvent: (entry: ActivityEntry) => void;
  /** Optional connection state callback. */
  onConnectionChange?: (state: 'open' | 'closed' | 'error') => void;
}

export function useActivityStream({
  enabled = true,
  filters = {},
  since,
  onEvent,
  onConnectionChange,
}: UseActivityStreamOptions): void {
  // Stable refs so re-renders don't re-open the connection unnecessarily.
  const onEventRef = useRef(onEvent);
  const onConnRef = useRef(onConnectionChange);
  // Mirror `since` into a ref so the open-effect always reads the freshest
  // value at filter-change time without listing `since` as a dep (which would
  // re-open on every pushed entry — the parent updates `since` from each
  // arrival).
  const sinceRef = useRef(since);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);
  useEffect(() => {
    onConnRef.current = onConnectionChange;
  }, [onConnectionChange]);
  useEffect(() => {
    sinceRef.current = since;
  }, [since]);

  // Re-open on filter change. We deliberately don't include `since` as a dep
  // — that would re-open on every push and defeat the point of a long-lived
  // stream. On filter-flip we read `sinceRef.current` so the fresh URL keeps
  // the latest cursor we've seen, avoiding a gap of events emitted between
  // filter-flip and reconnect. First-ever open with no baseline (`since` null)
  // is fine: `buildStreamUrl` omits the param and the server falls back to
  // "now".
  const filtersKey = JSON.stringify(filters);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return;
    }

    const connection = createActivityStreamConnection({
      getUrl: (token) =>
        buildStreamUrl({ filters, since: sinceRef.current, token }),
      getToken,
      onEvent: (entry) => onEventRef.current(entry),
      onConnectionChange: (state) => onConnRef.current?.(state),
      createEventSource: (url) =>
        new EventSource(url, { withCredentials: false }),
      visibility: documentVisibilitySource(document),
    });

    return () => {
      connection.close();
      onConnRef.current?.('closed');
    };
    // `since` is read once at open. Subsequent pushes update the parent's
    // copy, but we don't reopen on each new entry — that would defeat the
    // purpose of a long-lived stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, filtersKey]);
}

// ---------------------------------------------------------------------------
// Reconnect policy — pure, exported for unit tests.
//
// Cloud Run hard-kills every stream at its 300s request timeout; clients that
// all reconnect on a FIXED delay retry in lockstep, keep every instance slot
// occupied, and get 429 "Rate exceeded." back. So: exponential backoff with
// full jitter for failures, and jittered-but-fast reconnects for graceful
// server-side rotations.
//
// NOTE: EventSource cannot observe HTTP status codes — a 429 and a 5xx both
// surface as the same generic 'error' event. Backoff is therefore applied to
// ALL transport errors uniformly; that is intentional and exactly what
// de-escalates the 429 storm case.
// ---------------------------------------------------------------------------

/** Backoff cap for error-triggered reconnects. */
export const RECONNECT_MAX_DELAY_MS = 30_000;
/** First-attempt backoff base. */
export const RECONNECT_BASE_DELAY_MS = 1_000;

export function computeReconnectDelay({
  reason,
  attempt,
  random,
}: {
  reason: 'error' | 'bye';
  /** Consecutive failed attempts so far (reset on a successful 'hello'). */
  attempt: number;
  /** A Math.random() sample in [0, 1) — injected for deterministic tests. */
  random: number;
}): number {
  if (reason === 'bye') {
    // Graceful server-side rotation (max-lifetime 'bye') — expected, not a
    // failure. Reconnect fast, but jitter 500–1500ms so clients rotated in
    // the same instant don't reconnect in lockstep.
    return 500 + random * 1_000;
  }
  // Exponential backoff with full jitter: min(cap, base * 2^attempt), then
  // randomized into [delay/2, delay) so retries decorrelate across clients.
  const delay = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** attempt,
  );
  return delay / 2 + random * (delay / 2);
}

/** Minimal EventSource surface the connection controller needs. */
export interface EventSourceLike {
  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void;
  close(): void;
}

/**
 * Minimal Page Visibility surface the connection controller needs — kept
 * separate from `Document` so tests can drive it without jsdom (same idiom
 * as `EventSourceLike`).
 */
export interface VisibilitySource {
  isHidden(): boolean;
  subscribe(listener: () => void): () => void;
}

/** `VisibilitySource` backed by the real DOM `visibilitychange` event. */
export function documentVisibilitySource(doc: Document): VisibilitySource {
  return {
    isHidden: () => doc.visibilityState === 'hidden',
    subscribe: (listener) => {
      doc.addEventListener('visibilitychange', listener);
      return () => doc.removeEventListener('visibilitychange', listener);
    },
  };
}

/**
 * Framework-free connection controller — exported for unit tests (the test
 * suite is deliberately node-only, so the React hook above stays a thin
 * lifecycle wrapper around this; same idiom as `computeFeedStatus`).
 *
 * Owns the EventSource lifecycle: token fetch, open, reconnect scheduling
 * (see `computeReconnectDelay`), and teardown via the returned `close()`.
 */
export function createActivityStreamConnection({
  getUrl,
  getToken,
  onEvent,
  onConnectionChange,
  createEventSource,
  random = Math.random,
  visibility,
}: {
  /** Build the stream URL for a freshly fetched token. */
  getUrl: (token: string | null) => string;
  getToken: () => Promise<string | null>;
  onEvent: (entry: ActivityEntry) => void;
  onConnectionChange?: (state: 'open' | 'closed' | 'error') => void;
  createEventSource: (url: string) => EventSourceLike;
  random?: () => number;
  /**
   * Pauses the connection while the tab is hidden — no EventSource, no
   * reconnect timer. Omit to keep the pre-existing always-on behavior
   * (e.g. in tests that don't care about visibility).
   */
  visibility?: VisibilitySource;
}): { close: () => void } {
  let closed = false;
  let source: EventSourceLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Consecutive failed attempts; drives the backoff curve. Reset on every
  // successful open ('hello') so backoff only escalates while failing.
  let attempt = 0;
  // True while the tab is hidden and `visibility` was provided. Blocks new
  // connections and reconnect scheduling until the tab is visible again.
  let paused = false;
  let unsubscribeVisibility: (() => void) | null = null;

  const handleHello = () => {
    attempt = 0;
    onConnectionChange?.('open');
  };
  const handleActivity = (event: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(event.data) as ActivityEntry;
      onEvent(parsed);
    } catch {
      // Malformed line — drop silently. The next push will recover.
    }
  };
  const handleError = () => {
    onConnectionChange?.('error');
    closeSource();
    scheduleReconnect('error');
  };
  const handleBye = () => {
    onConnectionChange?.('closed');
    closeSource();
    scheduleReconnect('bye');
  };

  const closeSource = () => {
    source?.removeEventListener('hello', handleHello);
    source?.removeEventListener('activity', handleActivity);
    source?.removeEventListener('error', handleError);
    source?.removeEventListener('bye', handleBye);
    source?.close();
    source = null;
  };

  const connect = async () => {
    let token: string | null = null;
    try {
      token = await getToken();
    } catch {
      // A thrown token fetch must not silently kill the stream (previously
      // the rejection escaped and no reconnect was ever scheduled). Treat it
      // like a transport error: backoff and retry.
      if (!closed) {
        onConnectionChange?.('error');
        scheduleReconnect('error');
      }
      return;
    }
    // Tab may have gone hidden while the token fetch was in flight — don't
    // open a connection the visibility listener would just close again.
    if (closed || paused) return;
    closeSource();
    source = createEventSource(getUrl(token));
    source.addEventListener('hello', handleHello);
    source.addEventListener('activity', handleActivity);
    source.addEventListener('error', handleError);
    source.addEventListener('bye', handleBye);
  };

  const scheduleReconnect = (reason: 'error' | 'bye') => {
    // Paused (hidden tab): the visibility listener owns reconnection —
    // scheduling a timer here would just get cleared, or worse, fire while
    // still hidden.
    if (closed || reconnectTimer || paused) return;
    const delay = computeReconnectDelay({ reason, attempt, random: random() });
    if (reason === 'error') attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  if (visibility) {
    unsubscribeVisibility = visibility.subscribe(() => {
      if (visibility.isHidden()) {
        if (paused) return;
        paused = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        closeSource();
        onConnectionChange?.('closed');
      } else {
        if (!paused) return;
        paused = false;
        attempt = 0;
        // Reconnect from scratch rather than resume: `connect()` re-reads
        // `getUrl(token)`, so the caller's freshest `since` (tracked in a
        // ref outside this controller) goes straight into the new URL — no
        // gap to backfill, no replay of what already arrived before pause.
        void connect();
      }
    });
    if (visibility.isHidden()) {
      paused = true;
    } else {
      void connect();
    }
  } else {
    void connect();
  }

  return {
    close: () => {
      closed = true;
      unsubscribeVisibility?.();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      closeSource();
    },
  };
}

/**
 * Build the SSE URL with the same query-string contract as `/api/activity`,
 * plus the initial `since` cursor. Exported for unit tests.
 */
export function buildStreamUrl({
  filters,
  since,
  token,
}: {
  filters: ActivityFilters;
  since: string | null;
  token?: string | null;
}): string {
  const qs = new URLSearchParams();
  if (since) qs.set('since', since);
  if (token) qs.set('token', token);
  if (filters.clientName) qs.set('client_name', filters.clientName);
  if (filters.projectId) qs.set('project_id', filters.projectId);
  if (filters.agentsOnly) qs.set('agents_only', 'true');
  const s = qs.toString();
  return `/api/activity/stream${s ? `?${s}` : ''}`;
}
