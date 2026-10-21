'use client';

import { useState } from 'react';
import type { IntelligenceRun } from '@arbitra/shared';
import { RelativeTime } from '../shared/relative-time';
import { formatDurationMs } from './format-duration';

interface RunHistoryTableProps {
  runs: IntelligenceRun[];
  /**
   * If provided, a "Load older runs" button renders at the bottom of the
   * table and calls this on click. Parent is responsible for paging through
   * `next_cursor` and appending into `runs`.
   */
  onLoadMore?: () => void;
  /** Disables the "Load older runs" button while a page is in flight. */
  loadingMore?: boolean;
}

/**
 * Admin-only table of persisted `IntelligenceRun` records.
 *
 * Each row is collapsed by default and shows aggregate run-level metadata;
 * expanding a row reveals the per-detector `DetectorRunSummary` list. The
 * expansion is controlled purely by local state — no routing, no URL
 * fragment — because it's cheap and reversible.
 */
export function RunHistoryTable({ runs, onLoadMore, loadingMore }: RunHistoryTableProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 dark:border-border-subtle bg-surface-base dark:bg-surface-base/50 p-8 text-center text-sm text-gray-500 dark:text-gray-400">
        No intelligence runs have been persisted yet. Trigger one with the
        &ldquo;Run Now&rdquo; button above.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-raised">
      <table className="min-w-full divide-y divide-gray-100 dark:divide-border-subtle">
        <thead className="bg-surface-base dark:bg-surface-raised">
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            <th scope="col" className="px-4 py-2.5 w-10" aria-hidden="true" />
            <th scope="col" className="px-4 py-2.5">Started</th>
            <th scope="col" className="px-4 py-2.5">Duration</th>
            <th scope="col" className="px-4 py-2.5">Detectors</th>
            <th scope="col" className="px-4 py-2.5">Findings</th>
            <th scope="col" className="px-4 py-2.5">Trigger</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-border-subtle">
          {runs.map((run) => (
            <RunRow
              key={run.run_id}
              run={run}
              expanded={expanded[run.run_id] === true}
              onToggle={() =>
                setExpanded((prev) => ({ ...prev, [run.run_id]: !prev[run.run_id] }))
              }
            />
          ))}
        </tbody>
      </table>
      {onLoadMore && (
        <div className="border-t border-gray-100 dark:border-border-subtle p-3 text-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="text-xs font-medium text-accent hover:text-accent-700 dark:hover:text-accent-300 disabled:text-gray-400 dark:disabled:text-gray-600 disabled:cursor-not-allowed"
          >
            {loadingMore ? 'Loading…' : 'Load older runs'}
          </button>
        </div>
      )}
    </div>
  );
}

function RunRow({
  run,
  expanded,
  onToggle,
}: {
  run: IntelligenceRun;
  expanded: boolean;
  onToggle: () => void;
}) {
  const triggerClass =
    run.trigger === 'manual'
      ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
      : 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300';

  return (
    <>
      <tr
        className="hover:bg-surface-base dark:hover:bg-border-subtle/40 cursor-pointer"
        onClick={onToggle}
      >
        <td className="px-4 py-2.5 w-10 text-gray-400 dark:text-gray-500">
          <button
            type="button"
            aria-label={expanded ? 'Collapse run details' : 'Expand run details'}
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="text-sm"
          >
            {expanded ? '▾' : '▸'}
          </button>
        </td>
        <td className="px-4 py-2.5 text-sm text-gray-800 dark:text-gray-200">
          <RelativeTime timestamp={run.started_at} />
        </td>
        <td className="px-4 py-2.5 text-sm tabular-nums text-gray-700 dark:text-gray-300">
          {formatDurationMs(run.duration_ms)}
        </td>
        <td className="px-4 py-2.5 text-sm tabular-nums text-gray-700 dark:text-gray-300">
          {run.detector_count}
        </td>
        <td className="px-4 py-2.5 text-sm tabular-nums text-gray-700 dark:text-gray-300">
          {run.findings_total}
        </td>
        <td className="px-4 py-2.5">
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${triggerClass}`}
          >
            {run.trigger}
          </span>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-surface-base/60 dark:bg-surface-base/30">
          <td />
          <td colSpan={5} className="px-4 py-3">
            <RunDetailPanel run={run} />
          </td>
        </tr>
      )}
    </>
  );
}

function RunDetailPanel({ run }: { run: IntelligenceRun }) {
  if (run.error) {
    return (
      <div className="rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
        Run failed: {run.error}
      </div>
    );
  }
  if (run.summaries.length === 0) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400">
        No per-detector summaries recorded for this run.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      {run.summaries.map((s) => (
        <div
          key={s.detector_id}
          className="grid grid-cols-[1.5fr_auto_auto_auto] items-baseline gap-4 text-xs"
        >
          <div className="font-mono text-gray-800 dark:text-gray-200">
            {s.detector_id}
            {!s.enabled && (
              <span className="ml-2 inline-block rounded bg-gray-200 dark:bg-gray-700 px-1 py-0.5 text-[10px] uppercase tracking-wide text-gray-600 dark:text-gray-300">
                disabled
              </span>
            )}
          </div>
          <div className="tabular-nums text-gray-600 dark:text-gray-400">
            {s.finding_count} finding{s.finding_count === 1 ? '' : 's'}
          </div>
          <div className="tabular-nums text-gray-500 dark:text-gray-500">
            {formatDurationMs(s.duration_ms)}
          </div>
          <div className="text-red-600 dark:text-red-400 truncate max-w-[24ch]" title={s.error}>
            {s.error ? `error: ${s.error}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}
