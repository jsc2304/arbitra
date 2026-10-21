'use client';

import type { ActivityEntry } from '@arbitra/shared';
import { actorDisplayName } from '../../lib/actor-display';

/**
 * Streaming summary line under the page title:
 *   `Live · 4 events in the last minute · Code Intelligence, Cursor, Arbitra active`
 *
 * Pure derivation from the entries the parent already has — no network
 * calls. Updates on every parent re-render (the parent re-renders on each
 * push, which is exactly the "without page reload" cadence the spec asks
 * for).
 */
export const RECENT_WINDOW_MS = 60_000;
const MAX_ACTORS_LISTED = 3;

/**
 * Human phrase for the recent-activity window, derived from the actual window
 * length so the copy can't drift from the constant the derivation uses. The
 * default (60s) renders the original "in the last minute" wording verbatim;
 * other windows fall back to a "in the last N seconds/minutes" form.
 */
export function describeRecentWindow(windowMs: number): string {
  if (windowMs === 60_000) return 'in the last minute';
  const seconds = Math.round(windowMs / 1000);
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `in the last ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `in the last ${seconds} second${seconds === 1 ? '' : 's'}`;
}

export type FeedStatus = 'live' | 'reconnecting' | 'stopped';

export interface StreamingSummary {
  recentCount: number;
  actorLabels: string[];
  status: FeedStatus;
}

export function deriveStreamingSummary(
  entries: readonly ActivityEntry[],
  status: FeedStatus,
  now: number = Date.now(),
  windowMs: number = RECENT_WINDOW_MS,
): StreamingSummary {
  const cutoff = now - windowMs;
  let recentCount = 0;
  const actorOrder: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const ts = Date.parse(e.timestamp);
    if (Number.isNaN(ts) || ts < cutoff) continue;
    recentCount += 1;
    const clientName = e.actor_metadata?.client_name;
    const label = clientName
      ? actorDisplayName(undefined, { client_name: clientName }).label
      : null;
    if (label && !seen.has(label)) {
      seen.add(label);
      actorOrder.push(label);
    }
  }
  return { recentCount, actorLabels: actorOrder, status };
}

export function StreamingSummaryLine({
  entries,
  status,
  windowMs = RECENT_WINDOW_MS,
}: {
  entries: readonly ActivityEntry[];
  status: FeedStatus;
  /** Recent-activity window the counts derive from. Drives the copy. */
  windowMs?: number;
}) {
  const summary = deriveStreamingSummary(entries, status, Date.now(), windowMs);
  const actorsShown = summary.actorLabels.slice(0, MAX_ACTORS_LISTED);
  const overflow = summary.actorLabels.length - actorsShown.length;
  const actorsLabel =
    actorsShown.length === 0
      ? null
      : overflow > 0
        ? `${actorsShown.join(', ')} +${overflow}`
        : actorsShown.join(', ');

  return (
    <p
      data-testid="streaming-summary-line"
      className="text-xs text-gray-600 dark:text-gray-400"
      aria-live="polite"
    >
      <span
        className={`mr-1 inline-flex h-1.5 w-1.5 rounded-full align-middle ${
          summary.status === 'live'
            ? 'bg-green-500'
            : summary.status === 'reconnecting'
              ? 'bg-amber-500'
              : 'bg-gray-400'
        }`}
        aria-hidden
      />
      <span className="font-medium text-gray-800 dark:text-gray-200">
        {summary.status === 'live'
          ? 'Live'
          : summary.status === 'reconnecting'
            ? 'Reconnecting'
            : 'Stopped'}
      </span>
      <span className="mx-1.5 text-gray-400 dark:text-gray-500">·</span>
      <span>
        {`${summary.recentCount} event${summary.recentCount === 1 ? '' : 's'} ${describeRecentWindow(windowMs)}`}
      </span>
      {actorsLabel && (
        <>
          <span className="mx-1.5 text-gray-400 dark:text-gray-500">·</span>
          <span>{actorsLabel} active</span>
        </>
      )}
    </p>
  );
}
