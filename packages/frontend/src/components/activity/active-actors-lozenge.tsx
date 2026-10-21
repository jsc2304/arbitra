'use client';

import type { ActivityEntry } from '@arbitra/shared';
import { actorDisplayName } from '../../lib/actor-display';
import { RECENT_WINDOW_MS as DEFAULT_RECENT_WINDOW_MS, describeRecentWindow } from './streaming-summary-line';

/**
 * Active-actors lozenge. Shows up to N agents/clients that
 * have emitted events in the recent window with a small breathing dot per
 * agent. Click an avatar → filter the feed to that actor.
 *
 * Pure presentational: the parent passes the *raw* recent entries and we
 * derive the unique active set here. Keeps the component cheap to test
 * without spinning up the streaming hook.
 */
const RECENT_WINDOW_MS = DEFAULT_RECENT_WINDOW_MS;
const MAX_VISIBLE = 5;

export interface ActiveActor {
  clientName: string;
  label: string;
  lastTimestamp: string;
  /** Total events from this actor in the window — surfaced via title. */
  count: number;
}

export function deriveActiveActors(
  entries: readonly ActivityEntry[],
  now: number = Date.now(),
  windowMs: number = RECENT_WINDOW_MS,
): ActiveActor[] {
  const cutoff = now - windowMs;
  const seen = new Map<string, ActiveActor>();
  for (const e of entries) {
    const clientName = e.actor_metadata?.client_name;
    if (!clientName) continue;
    const ts = Date.parse(e.timestamp);
    if (Number.isNaN(ts) || ts < cutoff) continue;
    const existing = seen.get(clientName);
    if (existing) {
      existing.count += 1;
      if (e.timestamp > existing.lastTimestamp) {
        existing.lastTimestamp = e.timestamp;
      }
    } else {
      seen.set(clientName, {
        clientName,
        label: actorDisplayName(undefined, { client_name: clientName }).label,
        lastTimestamp: e.timestamp,
        count: 1,
      });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.lastTimestamp < b.lastTimestamp ? 1 : a.lastTimestamp > b.lastTimestamp ? -1 : 0,
  );
}

export function ActiveActorsLozenge({
  entries,
  onActorClick,
  windowMs = RECENT_WINDOW_MS,
}: {
  entries: readonly ActivityEntry[];
  onActorClick: (clientName: string) => void;
  /** Recent-activity window the active set derives from. Drives the copy. */
  windowMs?: number;
}) {
  const actors = deriveActiveActors(entries, Date.now(), windowMs);
  if (actors.length === 0) return null;

  const visible = actors.slice(0, MAX_VISIBLE);
  const overflow = actors.length - visible.length;
  const windowPhrase = describeRecentWindow(windowMs);
  // Screen-reader announcement for the breathing-dot updates (item 16). The
  // visual lozenge already conveys liveness via the ping animation; SR users
  // get a terse polite update naming who's currently active.
  const liveLabel =
    visible.length === 0
      ? null
      : `Active ${windowPhrase}: ${visible.map((a) => a.label).join(', ')}${
          overflow > 0 ? ` and ${overflow} more` : ''
        }`;

  return (
    <div
      data-testid="active-actors-lozenge"
      className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-surface-base px-2 py-1 dark:border-border-subtle dark:bg-surface-base/40"
      role="group"
      aria-label="Active actors"
    >
      {/*
        Polite live region (item 16): announces who's currently active as the
        breathing-dot set changes. The interactive buttons below stay in the
        a11y tree for keyboard/SR filtering; this region carries the live
        update so the visual ping has a screen-reader equivalent.
      */}
      {liveLabel && (
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {liveLabel}
        </span>
      )}
      <span
        aria-hidden
        className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
      >
        Active
      </span>
      <ul className="flex items-center gap-1">
        {visible.map((actor) => (
          <li key={actor.clientName} className="flex items-center">
            <button
              type="button"
              onClick={() => onActorClick(actor.clientName)}
              className="group inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-gray-700 transition-colors hover:bg-accent/10 hover:text-accent dark:text-gray-300 dark:hover:bg-accent/15 dark:hover:text-accent-300"
              title={`Filter by ${actor.label} (${actor.count} event${actor.count === 1 ? '' : 's'} ${windowPhrase})`}
              data-client-name={actor.clientName}
            >
              <span
                aria-hidden
                className="relative inline-flex h-1.5 w-1.5"
              >
                <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-70 animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
              </span>
              {actor.label}
            </button>
          </li>
        ))}
        {overflow > 0 && (
          <li className="text-[11px] text-gray-500 dark:text-gray-400">
            +{overflow}
          </li>
        )}
      </ul>
    </div>
  );
}
