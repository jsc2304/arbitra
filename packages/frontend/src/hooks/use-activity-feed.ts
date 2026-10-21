'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import type { ActivityEntry } from '@arbitra/shared';
import { api } from '../lib/api-client';
import { useActivityStream } from './use-activity-stream';
import { useDocumentVisible } from './use-document-visible';

/**
 * How long a streamed-in row keeps `isFresh = true` (drives the row glow
 * and the live-tick variant of RelativeTime). About 6s.
 */
export const FRESH_ROW_TTL_MS = 6_000;

// ---------------------------------------------------------------------------
// Pure merge — exported for unit testing.
//
// SWR delta-fetches via `?since=<latest timestamp>` so polls only return new
// rows. `mergeActivity` prepends those new rows to the cached list while
// de-duping by `id` (stable per source, e.g. `"evidence:<id>"`). Calling with
// an empty `incoming` is a no-op, which is why we don't replace the whole
// list every 2s and avoid flicker.
// ---------------------------------------------------------------------------

export function mergeActivity(
  existing: ActivityEntry[],
  incoming: ActivityEntry[],
): ActivityEntry[] {
  if (incoming.length === 0) return existing;

  const seen = new Set<string>();
  const merged: ActivityEntry[] = [];

  // Incoming rows come back pre-sorted desc from the server; keep them on top.
  for (const row of incoming) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  for (const row of existing) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Pure feed-status derivation — exported for unit testing.
//
// Three states drive the live-pulse indicator:
//   - `live`         — the feed is receiving updates, either from SSE or the
//                      SWR poll fallback.
//   - `reconnecting` — no successful fetch has landed yet; also covers the
//                      short initial window before either transport proves
//                      itself healthy.
//   - `stopped`      — no transport has delivered recently. The user should
//                      refresh or check their connection.
//
// `lastSuccessAt === null` means "no successful fetch yet". We treat that as
// the initial-load window and report `reconnecting` rather than `stopped` so
// the first paint doesn't accuse the backend of being down before the very
// first request lands. Once a fetch succeeds, the staleness window kicks in.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pure poll-baseline decision — exported for unit testing.
//
// The delta-poll asks the server for entries newer than `since`. Two inputs
// decide what `since` to send:
//   - `latest`   — newest entry timestamp the feed currently holds, or `null`
//                  when the feed is still empty (e.g. an empty initial load,
//                  before any row has arrived).
//   - `baseline` — wall-clock ISO timestamp captured when the initial load
//                  landed. Used as the floor when the feed has no rows yet, so
//                  the poll fetches everything created *after the feed opened*
//                  rather than re-reading the whole table.
//
// Returns the `since` to poll with, or `null` to skip the poll entirely (no
// baseline available yet — the initial load hasn't landed). Previously the
// poll short-circuited whenever `latest` was null, so an empty initial load
// wedged the fallback forever: with SSE unavailable the user never saw newly
// created activity until a full reload (#630).
// ---------------------------------------------------------------------------

export function resolvePollSince({
  latest,
  baseline,
}: {
  latest: string | null;
  baseline: string | null;
}): string | null {
  if (latest) return latest;
  // Empty feed: poll for everything since the feed opened. Without a baseline
  // we have no floor yet (initial load not landed) — skip this tick.
  return baseline;
}

// ---------------------------------------------------------------------------
// shouldPollFallback — pure gate for the delta-poll effect, exported for
// unit testing (same idiom as `computeFeedStatus`).
//
// The poll is a FALLBACK, not a second transport. An open SSE stream already
// delivers every delta via push, so running the poll alongside it doubled
// `listActivity` reads for zero UI benefit — each open tab issued two calls
// per `refreshIntervalMs` tick instead of one (see the stream route's header
// comment for the production cost this caused). And a hidden tab renders
// nothing, so there's no list to keep fresh until the user looks again.
// ---------------------------------------------------------------------------

export function shouldPollFallback({
  streamState,
  visible,
}: {
  streamState: 'idle' | 'open' | 'error';
  visible: boolean;
}): boolean {
  return visible && streamState !== 'open';
}

export function computeFeedStatus({
  streamState,
  lastSuccessAt,
  refreshIntervalMs,
  now,
}: {
  streamState: 'idle' | 'open' | 'error';
  lastSuccessAt: number | null;
  refreshIntervalMs: number;
  now: number;
}): 'live' | 'reconnecting' | 'stopped' {
  if (streamState === 'open') return 'live';
  // Cold-start: no fetch has landed yet. Don't flag as stopped — give the
  // first request a chance.
  if (lastSuccessAt === null) return 'reconnecting';
  const swrHealthy = now - lastSuccessAt < 3 * refreshIntervalMs;
  return swrHealthy ? 'live' : 'stopped';
}

export interface ActivityFilters {
  agentsOnly?: boolean;
  clientName?: string;
  projectId?: string;
}

interface UseActivityFeedOptions {
  filters?: ActivityFilters;
  pageSize?: number;
  /** SWR poll interval (ms). Defaults to 2000. */
  refreshIntervalMs?: number;
  /**
   * Enable the SSE streaming connection that pushes new entries server-side
   * (rollout step 4). When disabled (default false until callers opt in),
   * the hook falls back to the existing SWR delta-poll only.
   */
  streaming?: boolean;
  /**
   * If true, new streamed-in entries are NOT inserted at the top of the
   * list; they are queued and exposed via `pendingCount` / `flushPending()`.
   * Used by the activity feed when the user has scrolled past the top so
   * the scroll position doesn't jump.
   */
  queuePending?: boolean;
}

const DEFAULT_POLL_MS = 2000;
const DEFAULT_PAGE_SIZE = 50;

/**
 * Workspace-wide activity feed hook.
 *
 * Does three things:
 *   1. Initial fetch of the most-recent `pageSize` entries.
 *   2. Polls `refreshIntervalMs` with `?since=<latest>` and prepends new rows
 *      (via `mergeActivity`) — existing rows are never replaced, so rendering
 *      doesn't flicker. This poll is a fallback (see `shouldPollFallback`):
 *      it's suspended while the SSE stream is open (deltas already arrive
 *      via push) or while the tab is hidden (nothing to keep fresh).
 *   3. `loadMore()` paginates backward with `?since=undefined&limit=pageSize`
 *      plus a client-side filter to drop entries we already hold. Good
 *      enough until SSE arrives.
 */
export function useActivityFeed({
  filters = {},
  pageSize = DEFAULT_PAGE_SIZE,
  refreshIntervalMs = DEFAULT_POLL_MS,
  streaming = false,
  queuePending = false,
}: UseActivityFeedOptions = {}) {
  // Serialize filters into the SWR key so changing them restarts the feed.
  const filtersKey = useMemo(() => JSON.stringify(filters), [filters]);
  const visible = useDocumentVisible();

  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  // Set of entry ids that arrived via stream within FRESH_ROW_TTL_MS. The
  // value is the wall-clock arrival time so we can age them out cheaply with
  // a single setInterval rather than one timer per row.
  const [freshIds, setFreshIds] = useState<Map<string, number>>(() => new Map());
  // Queued entries: pushed while the consumer has set queuePending=true (the
  // user has scrolled past the top of the feed). Calling `flushPending()`
  // moves them into the visible list.
  const [pending, setPending] = useState<ActivityEntry[]>([]);
  // Track whether the streaming connection believes itself live. The SWR
  // poll keeps things working even when this is false, so the only consumer
  // is the live-pulse indicator in the UI.
  const [streamState, setStreamState] = useState<'idle' | 'open' | 'error'>(
    'idle',
  );
  // Wall-clock of the last successful poll/initial-fetch. Combined with the
  // poll interval below, this lets us distinguish "feed still updating via
  // poll fallback" (live) from "everything down" (stopped).
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const latestRef = useRef<string | null>(null);
  // Wall-clock ISO baseline captured when the initial load lands. Used as the
  // poll floor while the feed is still empty (`latestRef` null) so the delta-
  // poll fetches everything created after the feed opened instead of wedging.
  const pollBaselineRef = useRef<string | null>(null);
  const queuePendingRef = useRef(queuePending);
  useEffect(() => {
    queuePendingRef.current = queuePending;
  }, [queuePending]);
  // Backward-pagination cursor: the `cursor` from the last list response.
  // Seeded from the initial response and updated each `loadMore()` call so
  // we don't re-fetch the top slice to infer the cutoff.
  const cursorRef = useRef<string | null>(null);

  // Initial load (and re-load when filters change). `revalidateOnFocus` is
  // OFF: SWR fires it on both the `focus` and `visibilitychange` browser
  // events, so every tab-refocus replayed a full top-`pageSize` fetch
  // (~2x pageSize + up to 200 findings + referenced cases/projects, ~700
  // docs) even though nothing needed it. The hidden->visible transition
  // already re-arms the delta-poll effect below (it's keyed on `visible`)
  // and, when `streaming` is on, reopens the EventSource — both resume from
  // `latestRef.current` via `since`, so a merged catch-up lands within one
  // `refreshIntervalMs` tick without re-reading the whole first page. A
  // `revalidateOnFocus`-driven reload wouldn't even close a real gap: it
  // calls the same `limit: pageSize` endpoint with no `since`, so a burst
  // that outgrew `pageSize` while hidden is truncated either way — the
  // since-bounded merge is strictly better there because it prepends onto
  // the existing (possibly `loadMore()`-extended) list instead of replacing
  // it outright.
  const initialKey = useMemo(() => ['activity:init', filtersKey, pageSize] as const, [filtersKey, pageSize]);
  const { data: initial, isLoading, error, mutate } = useSWR(
    initialKey,
    () =>
      api.activity.list({
        limit: pageSize,
        ...(filters.agentsOnly ? { agentsOnly: true } : {}),
        ...(filters.clientName ? { clientName: filters.clientName } : {}),
        ...(filters.projectId ? { projectId: filters.projectId } : {}),
      }),
    { revalidateOnFocus: false },
  );

  useEffect(() => {
    if (!initial) return;
    setEntries(initial.entries);
    latestRef.current = initial.entries.length > 0 ? (initial.entries[0]?.timestamp ?? null) : null;
    // Seed the poll baseline once per initial load. When the feed comes back
    // empty there's no row timestamp to delta from, so the poll uses this
    // wall-clock floor to pick up activity created after the feed opened (#630).
    pollBaselineRef.current = new Date().toISOString();
    cursorRef.current = initial.cursor;
    setLastSuccessAt(Date.now());
  }, [initial]);

  // Poll for deltas. Suspended while the SSE stream is open or the tab is
  // hidden — see `shouldPollFallback`.
  useEffect(() => {
    if (!initial) return;
    if (!shouldPollFallback({ streamState, visible })) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const since = resolvePollSince({
        latest: latestRef.current,
        baseline: pollBaselineRef.current,
      });
      if (!since) return; // No baseline yet; initial load will supply one.
      try {
        const result = await api.activity.list({
          limit: pageSize,
          since,
          ...(filters.agentsOnly ? { agentsOnly: true } : {}),
          ...(filters.clientName ? { clientName: filters.clientName } : {}),
          ...(filters.projectId ? { projectId: filters.projectId } : {}),
        });
        if (cancelled) return;
        setLastSuccessAt(Date.now());
        if (result.entries.length === 0) return;
        setEntries((prev) => {
          const merged = mergeActivity(prev, result.entries);
          const newest = merged[0]?.timestamp;
          if (newest) latestRef.current = newest;
          return merged;
        });
      } catch {
        // Soft-fail a poll; next tick will retry.
      }
    };

    const handle = setInterval(tick, refreshIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
    // `filters` is captured via its serialized key; `initial` drives the
    // baseline — we only poll once the initial load landed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, filtersKey, pageSize, refreshIntervalMs, streamState, visible]);

  const loadMore = useCallback(async () => {
    if (entries.length === 0) return;
    // Prefer the server-supplied cursor (timestamp of the oldest row in the
    // previous response). Fall back to our own oldest entry when the cursor
    // isn't populated yet — e.g. very first load.
    const before =
      cursorRef.current ?? entries[entries.length - 1]!.timestamp;
    const result = await api.activity.list({
      limit: pageSize,
      before,
      ...(filters.agentsOnly ? { agentsOnly: true } : {}),
      ...(filters.clientName ? { clientName: filters.clientName } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
    });
    if (result.entries.length === 0) {
      cursorRef.current = null;
      return;
    }
    cursorRef.current = result.cursor;
    setEntries((prev) => {
      const existingIds = new Set(prev.map((e) => e.id));
      const newRows = result.entries.filter((e) => !existingIds.has(e.id));
      if (newRows.length === 0) return prev;
      return [...prev, ...newRows];
    });
  }, [entries, filters.agentsOnly, filters.clientName, filters.projectId, pageSize]);

  // ---- streaming push ----------------------------------------------------
  //
  // SSE deltas. Each pushed entry either lands at the top of the visible
  // list (default) or is queued behind the "N new" pill (when the consumer
  // sets queuePending=true). Either way it gets marked fresh for ~6s so the
  // row glow + live-tick variant of RelativeTime can pick it up.

  const handleStreamEvent = useCallback((entry: ActivityEntry) => {
    const arrivedAt = Date.now();
    if (queuePendingRef.current) {
      setPending((prev) => {
        if (prev.some((e) => e.id === entry.id)) return prev;
        // Newest first so flushPending preserves order when prepended.
        return [entry, ...prev];
      });
    } else {
      setEntries((prev) => {
        const merged = mergeActivity(prev, [entry]);
        if (merged === prev) return prev;
        const newest = merged[0]?.timestamp;
        if (newest && (!latestRef.current || newest > latestRef.current)) {
          latestRef.current = newest;
        }
        return merged;
      });
      setFreshIds((prev) => {
        const next = new Map(prev);
        next.set(entry.id, arrivedAt);
        return next;
      });
    }
  }, []);

  useActivityStream({
    enabled: streaming,
    filters,
    since: latestRef.current,
    onEvent: handleStreamEvent,
    onConnectionChange: (state) => {
      setStreamState(state === 'open' ? 'open' : state === 'error' ? 'error' : 'idle');
    },
  });

  // Single shared interval ages out the fresh ids. Cheap O(N) sweep on a
  // small Map (only fresh rows live here, typically <10 at peak).
  useEffect(() => {
    if (freshIds.size === 0) return;
    const handle = setInterval(() => {
      const cutoff = Date.now() - FRESH_ROW_TTL_MS;
      setFreshIds((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, ts] of next) {
          if (ts <= cutoff) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1_000);
    return () => clearInterval(handle);
  }, [freshIds.size]);

  const flushPending = useCallback(() => {
    setPending((queued) => {
      if (queued.length === 0) return queued;
      const arrivedAt = Date.now();
      setEntries((prev) => {
        const merged = mergeActivity(prev, queued);
        const newest = merged[0]?.timestamp;
        if (newest && (!latestRef.current || newest > latestRef.current)) {
          latestRef.current = newest;
        }
        return merged;
      });
      setFreshIds((prev) => {
        const next = new Map(prev);
        for (const e of queued) next.set(e.id, arrivedAt);
        return next;
      });
      return [];
    });
  }, []);

  // Hidden -> visible transition: `lastSuccessAt` is now stale (it dates
  // from before the tab was hidden, potentially minutes ago, since both the
  // stream and the poll were suspended while hidden). Left alone,
  // `computeFeedStatus` would measure staleness against that old timestamp
  // and flash `stopped` for the sub-second window until the stream reopens
  // or the first poll lands. Resetting to `null` instead reports the
  // documented cold-start state (`reconnecting`), same as the very first
  // load.
  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setLastSuccessAt(null);
    }
    wasVisibleRef.current = visible;
  }, [visible]);

  // Tick once per poll interval so `feedStatus` flips to `stopped` even when
  // nothing else triggers a render (e.g. poll silently fails forever). Only
  // run while SSE is not open and the tab is visible — an open stream is its
  // own health signal and never decays into stopped, and a hidden tab has no
  // live-pulse indicator on screen to update, so either makes the extra
  // renders pure waste.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (streamState === 'open' || !visible) return;
    const handle = setInterval(() => setNowTick((n) => n + 1), refreshIntervalMs);
    return () => clearInterval(handle);
  }, [refreshIntervalMs, streamState, visible]);

  const feedStatus = computeFeedStatus({
    streamState,
    lastSuccessAt,
    refreshIntervalMs,
    now: Date.now(),
  });

  return {
    entries,
    isLoading,
    error,
    loadMore,
    refresh: mutate,
    /** Ids of entries that arrived via stream in the last ~6s. */
    freshIds,
    /** Entries arrived while queuing was on; not yet shown to the user. */
    pendingCount: pending.length,
    /** Move queued entries into the visible list. */
    flushPending,
    /** Streaming connection state — UI can flip the live pulse off on errors. */
    streamState,
    /** Combined SSE + SWR-poll health for the live-pulse indicator. */
    feedStatus,
    /** Poll cadence — used by the UI to phrase the reconnecting tooltip. */
    pollIntervalMs: refreshIntervalMs,
  };
}
