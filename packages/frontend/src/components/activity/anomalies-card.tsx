'use client';

/**
 * <AnomaliesCard> — right-rail card pulling from the same baseline used for
 * heartbeat suppression in HeartbeatTile (#562).
 *
 * Three rows:
 *   1. Detector errors — wired from intelligence_run summaries (errors > 0).
 *   2. Latency spikes  — STUB (data source not yet exposed at the API layer).
 *   3. Attribution drops — STUB (rolling-baseline metric not yet computed).
 *
 * Each click emits a {@link FilterDelta} the parent merges into the URL —
 * detector errors → Raw + kind=system pin so the user lands on the audit log
 * where the anomalous runs are visible. Stub rows render with a `coming soon`
 * tag and a count of 0; they DO NOT fabricate metrics (per task brief).
 *
 * The "real" detector-errors signal is derived client-side by parsing the
 * intelligence_run summary string the activity feed already exposes via the
 * shared `parseRunErrors` parser (`lib/activity-parsers.ts`, also used by
 * <HeartbeatTile>). When the activity service grows a structured `errors`
 * field on workspace-event payloads (tracked as follow-up envelope work),
 * that parser swaps to the structured signal in one line.
 */

import { useMemo } from 'react';
import useSWR from 'swr';
import type { ActivityEntry } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import type { FilterDelta } from '../../lib/activity-url-state';
import { parseRunErrors } from '../../lib/activity-parsers';

interface AnomaliesCardProps {
  onFilterClick?: (delta: FilterDelta) => void;
}

export function AnomaliesCard({ onFilterClick }: AnomaliesCardProps) {
  // Pull a generous 24h window of system rows. The activity API doesn't have
  // a server-side "errors only" filter, so we fetch + parse client-side. 200
  // rows is a comfortable cap; production volume of intelligence_run events
  // sits around ~24/h at current detector cadence.
  const { data } = useSWR(
    'activity:anomalies:24h',
    () => api.activity.list({ limit: 200 }),
    { refreshInterval: 60_000, revalidateOnFocus: true, keepPreviousData: true },
  );

  /**
   * Returns the total detector-error count for the last 24h window, or `null`
   * when the API page was exhausted before reaching 24h ago (the 200-row limit
   * means busy workspaces may have older intelligence_run rows fall off the page
   * before the cutoff). `null` is surfaced as "?" with a tooltip rather than an
   * undercount.
   */
  const detectorErrors = useMemo<number | null>(() => {
    const entries: ActivityEntry[] = data?.entries ?? [];
    let count = 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let sawRunBeforeCutoff = false;
    let oldestRunTs: number | null = null;
    for (const e of entries) {
      const errors = parseRunErrors(e.summary);
      if (errors === null) continue; // not an intelligence_run row
      const ts = Date.parse(e.timestamp);
      if (Number.isNaN(ts)) continue;
      if (oldestRunTs === null || ts < oldestRunTs) oldestRunTs = ts;
      if (ts < cutoff) {
        sawRunBeforeCutoff = true;
        continue;
      }
      count += errors;
    }
    // If no run reached beyond the cutoff AND the page is at the limit,
    // the 24h window may be incomplete — report null so we don't silently undercount.
    const pageIsExhausted = entries.length >= 200;
    if (pageIsExhausted && !sawRunBeforeCutoff) {
      // All 200 rows sit within 24h; the actual window may extend further.
      return null;
    }
    return count;
  }, [data]);

  const handleDetectorErrorsClick =
    detectorErrors !== null && detectorErrors > 0 && onFilterClick
      ? () => onFilterClick({ setMode: 'raw', toggleKind: 'system' })
      : undefined;

  return (
    <section
      className="bg-surface-raised rounded-xl border border-gray-200 dark:border-border-subtle"
      data-testid="anomalies-card"
    >
      <header className="flex items-baseline justify-between gap-3 px-4 py-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent/80">
            Anomalies
          </p>
          <h2 className="mt-1 text-base font-semibold text-gray-900 dark:text-gray-100">
            Off-baseline (24h)
          </h2>
        </div>
        <span className="text-[11px] text-gray-400 dark:text-gray-500">last 24h</span>
      </header>
      <ul className="divide-y divide-gray-100 px-4 pb-3 dark:divide-border-subtle">
        <AnomalyRow
          label="Detector errors"
          description="Intelligence runs that surfaced at least one detector error."
          count={detectorErrors}
          onClick={handleDetectorErrorsClick}
          stub={false}
        />
        <AnomalyRow
          label="Latency spikes"
          description="Runs ≥ 2× rolling-baseline duration."
          count={0}
          onClick={undefined}
          stub
        />
        <AnomalyRow
          label="Attribution drops"
          description="Coverage below rolling-baseline threshold."
          count={0}
          onClick={
            onFilterClick ? () => onFilterClick({ attributionMissing: true }) : undefined
          }
          stub
        />
      </ul>
    </section>
  );
}

function AnomalyRow({
  label,
  description,
  count,
  onClick,
  stub,
}: {
  label: string;
  description: string;
  /** Pass `null` when the 24h window may be incomplete due to page exhaustion. */
  count: number | null;
  onClick?: () => void;
  /** Render the `(coming soon)` tag instead of the count when the data source isn't wired. */
  stub: boolean;
}) {
  const isInteractive = !!onClick;
  const Body = (
    <div className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</p>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{description}</p>
      </div>
      <div className="text-right">
        {stub ? (
          <span
            className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-surface-base/40 dark:text-gray-400"
            data-testid="anomaly-stub-tag"
          >
            coming soon
          </span>
        ) : count === null ? (
          // Page limit hit before reaching 24h ago — show "?" to avoid silent undercount.
          <span
            className="text-lg font-semibold text-gray-400 dark:text-gray-500"
            data-testid="anomaly-count"
            title="Showing recent runs only — older entries may exist"
          >
            ?
          </span>
        ) : (
          <span
            className={`text-lg font-semibold ${
              count > 0
                ? 'text-rose-600 dark:text-rose-400'
                : 'text-gray-400 dark:text-gray-500'
            }`}
            data-testid="anomaly-count"
          >
            {count}
          </span>
        )}
      </div>
    </div>
  );

  if (isInteractive) {
    return (
      <li>
        <button
          type="button"
          onClick={onClick}
          className="block w-full text-left rounded-md hover:bg-surface-base dark:hover:bg-border-subtle/30 -mx-2 px-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {Body}
        </button>
      </li>
    );
  }
  return <li>{Body}</li>;
}

export default AnomaliesCard;
