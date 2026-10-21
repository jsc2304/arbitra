'use client';

/**
 * <HeartbeatTile> — replaces the placeholder `cluster:heartbeat:*` rows
 * shipped by PR #547 with a real, persistent component pinned to the top of
 * the System feed.
 *
 * Rendering contract:
 *
 *   Code Intelligence — healthy   ●
 *   N detectors · M deduped/run · 0 errors over last 4d
 *   Last run: 12m ago     [Open runs]   [View baseline]
 *
 * "Open runs" expands inline a sparkline of run durations and counts. The
 * sparkline is a tiny inline SVG — we deliberately do NOT add a chart
 * dependency (a tiny inline sparkline is fine; do NOT add a chart dep).
 *
 * Promotion of off-baseline runs to real rows is driven by the envelope's
 * `signal` field — the activity service already lifts runs that deviate from
 * the heartbeat baseline. This tile only renders the steady-state baseline;
 * the "promote anomalous runs" routing happens upstream and isn't part
 * of the tile's job.
 */

import { useMemo, useState } from 'react';
import type { ActivityEntry } from '@arbitra/shared';
import { RelativeTime } from '../shared/relative-time';
import { parseRunSummary, type ParsedRun } from '../../lib/activity-parsers';

interface HeartbeatTileProps {
  /**
   * Underlying intelligence_run workspace events that the tile aggregates.
   * Sorted desc-by-timestamp upstream — `entries[0]` is the most recent run.
   */
  entries: ActivityEntry[];
}

interface BaselineSummary {
  detectors: number;
  /** Avg deduped per run, rounded. */
  dedupedPerRun: number;
  /** Total errors across the visible window. */
  errorsTotal: number;
  /** Earliest run timestamp in the visible window. */
  earliestTs: string | undefined;
  /** Latest run timestamp in the visible window. */
  latestTs: string | undefined;
  /** Per-run durations, oldest first — drives the sparkline. */
  durationsMs: number[];
  /** Per-run nudge counts, oldest first — drives the second sparkline track. */
  nudgesPerRun: number[];
}

function summarizeBaseline(entries: ActivityEntry[]): BaselineSummary {
  const parsed = entries
    .map((e) => ({ entry: e, run: parseRunSummary(e.summary) }))
    .filter((p): p is { entry: ActivityEntry; run: ParsedRun } => p.run !== null);

  if (parsed.length === 0) {
    return {
      detectors: 0,
      dedupedPerRun: 0,
      errorsTotal: 0,
      earliestTs: entries[entries.length - 1]?.timestamp,
      latestTs: entries[0]?.timestamp,
      durationsMs: [],
      nudgesPerRun: [],
    };
  }

  const detectors = parsed[0]!.run.detectors;
  const dedupedTotal = parsed.reduce((acc, p) => acc + p.run.deduped, 0);
  const errorsTotal = parsed.reduce((acc, p) => acc + p.run.errors, 0);

  // Upstream feed is desc-by-timestamp; reverse so sparklines read left→right
  // as oldest→newest, matching ordinary chart conventions.
  const chronological = [...parsed].reverse();
  return {
    detectors,
    dedupedPerRun: Math.round(dedupedTotal / parsed.length),
    errorsTotal,
    earliestTs: chronological[0]!.entry.timestamp,
    latestTs: chronological[chronological.length - 1]!.entry.timestamp,
    durationsMs: chronological.map((p) => p.run.durationMs),
    nudgesPerRun: chronological.map((p) => p.run.newNudges),
  };
}

function windowDaysLabel(earliestTs: string | undefined, latestTs: string | undefined): string {
  if (!earliestTs || !latestTs) return '';
  const earliest = Date.parse(earliestTs);
  const latest = Date.parse(latestTs);
  if (Number.isNaN(earliest) || Number.isNaN(latest)) return '';
  const days = Math.max(1, Math.round((latest - earliest) / (1000 * 60 * 60 * 24)));
  return `last ${days}d`;
}

/**
 * Render a tiny inline SVG sparkline. `values` reads left→right as oldest→
 * newest. Renders nothing when there are fewer than two data points (a
 * one-point sparkline is misleading).
 */
function Sparkline({
  values,
  label,
  className,
}: {
  values: number[];
  label: string;
  className?: string;
}) {
  if (values.length < 2) return null;
  const w = 120;
  const h = 24;
  const pad = 2;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const stepX = (w - pad * 2) / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = pad + i * stepX;
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <div className={`flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 ${className ?? ''}`}>
      <span className="shrink-0">{label}</span>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width={w}
        height={h}
        role="img"
        aria-label={`${label} over time`}
        className="text-gray-400 dark:text-gray-500"
      >
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">
        min {min} · max {max}
      </span>
    </div>
  );
}

export function HeartbeatTile({ entries }: HeartbeatTileProps) {
  const [expanded, setExpanded] = useState(false);
  const baseline = useMemo(() => summarizeBaseline(entries), [entries]);

  const healthy = baseline.errorsTotal === 0;
  const statusLabel = healthy ? 'healthy' : 'degraded';
  const statusDot = healthy
    ? 'bg-green-500'
    : 'bg-red-500';
  const dayLabel = windowDaysLabel(baseline.earliestTs, baseline.latestTs);
  const latestTs = baseline.latestTs ?? entries[0]?.timestamp;

  const panelId = `heartbeat-tile-runs`;

  return (
    <li
      className="relative rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-base/40 dark:bg-border-subtle/20 px-4 py-3"
      data-testid="heartbeat-tile"
      data-status={healthy ? 'healthy' : 'degraded'}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              Code Intelligence
            </span>
            <span className="text-gray-400 dark:text-gray-500">—</span>
            <span className="text-gray-700 dark:text-gray-300">{statusLabel}</span>
            <span
              aria-hidden
              className={`ml-1 inline-block h-2 w-2 rounded-full ${statusDot}`}
            />
          </div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {baseline.detectors > 0 ? (
              <>
                {baseline.detectors} detector{baseline.detectors === 1 ? '' : 's'} ·{' '}
                {baseline.dedupedPerRun} deduped/run · {baseline.errorsTotal} error
                {baseline.errorsTotal === 1 ? '' : 's'}
                {dayLabel ? <> over {dayLabel}</> : null}
              </>
            ) : (
              <>No parseable run summaries in the visible window</>
            )}
          </div>
          {latestTs && (
            <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Last run: <RelativeTime timestamp={latestTs} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={panelId}
            className="rounded-md border border-gray-200 dark:border-border-subtle bg-surface-raised dark:bg-surface-raised/40 px-2 py-1 text-xs text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
          >
            {expanded ? 'Hide runs' : 'Open runs'}
          </button>
        </div>
      </div>

      {expanded && (
        <div
          id={panelId}
          className="mt-3 border-t border-gray-100 dark:border-border-subtle pt-3 space-y-1.5"
        >
          <Sparkline values={baseline.durationsMs} label="duration ms" />
          <Sparkline values={baseline.nudgesPerRun} label="new nudges" />
          {baseline.durationsMs.length < 2 && (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Need at least two runs to render a sparkline.
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export default HeartbeatTile;
