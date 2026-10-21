'use client';

import { useEffect, useState } from 'react';
import { formatRelativeTime } from './relative-time';

/**
 * Two shared broadcast ticks power every `<RelativeTime>` subscriber:
 *  - 60s "slow" tick — minute-resolution refreshes for the bulk of the feed.
 *  - 1s  "fast" tick — second-resolution refreshes for fresh rows whose
 *    delta is still under a minute.
 *
 * One `setInterval` per granularity for the whole app — not one per row —
 * so a list of N rendered timestamps costs at most two timers regardless of N.
 */
const SLOW_TICK_MS = 60_000;
const FAST_TICK_MS = 1_000;

type TickListener = (now: number) => void;

function makeTickRegistry(intervalMs: number) {
  const listeners = new Set<TickListener>();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  return function subscribe(listener: TickListener): () => void {
    listeners.add(listener);
    if (intervalId === null && typeof window !== 'undefined') {
      intervalId = setInterval(() => {
        const now = Date.now();
        listeners.forEach((cb) => cb(now));
      }, intervalMs);
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
  };
}

const subscribe = makeTickRegistry(SLOW_TICK_MS);
const subscribeFast = makeTickRegistry(FAST_TICK_MS);

/**
 * Returns a relative-time label (see `formatRelativeTime`) that refreshes
 * itself while the component remains mounted. All instances share a small
 * pool of global ticks — no per-row timers.
 *
 * @param liveSeconds When true, the label re-renders every 1s while the
 *   timestamp is younger than 60s (every second up to 60s for
 *   fresh rows). Once the delta crosses one minute the subscription is
 *   automatically downgraded to the shared 60s tick. When false (default),
 *   only the 60s tick drives refreshes.
 */
export function useRelativeTime(
  timestamp: string | number | Date,
  liveSeconds = false,
): string {
  const [label, setLabel] = useState(() => formatRelativeTime(timestamp));

  useEffect(() => {
    setLabel(formatRelativeTime(timestamp));

    const tsMs = (() => {
      const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
      const ms = d.getTime();
      return Number.isNaN(ms) ? null : ms;
    })();

    const useFast =
      liveSeconds &&
      tsMs !== null &&
      Date.now() - tsMs < 60_000;

    if (useFast) {
      // Subscribe to BOTH ticks. Fast tick handles second-resolution updates
      // while the row is still under a minute; slow tick covers the long-tail
      // bucketed labels ("12m ago" → "13m ago"). The unsub for fast cleans
      // itself up the moment we cross the minute boundary, so we don't
      // perpetually pay the 1s tick cost for an aged-out row.
      let fastUnsub: (() => void) | null = subscribeFast((now) => {
        if (tsMs !== null && now - tsMs >= 60_000) {
          fastUnsub?.();
          fastUnsub = null;
          return;
        }
        setLabel(formatRelativeTime(timestamp, now));
      });
      const slowUnsub = subscribe((now) => {
        setLabel(formatRelativeTime(timestamp, now));
      });
      return () => {
        fastUnsub?.();
        slowUnsub();
      };
    }

    return subscribe((now) => {
      setLabel(formatRelativeTime(timestamp, now));
    });
  }, [timestamp, liveSeconds]);

  return label;
}
