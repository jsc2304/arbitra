'use client';

import Link from 'next/link';
import type { WorkspaceEventBlockProps } from './index';

type DetectorSummary = {
  detector?: string;
  cases_created?: number;
  cases_skipped_existing?: number;
  duration_ms?: number;
  error?: string;
  // Older / future runs might surface a raw finding count; support both.
  findings?: number;
};

type IntelligenceEvidence = {
  detectors?: DetectorSummary[];
  duration_ms?: number;
  errors?: number;
  cases_created?: number;
  cases_skipped_existing?: number;
  error?: string;
  run_id?: string;
};

/**
 * Detail body for `intelligence_run` workspace events. Renders the per-
 * detector summary table that `IntelligenceService.run()` emits on the
 * event's `evidence.detectors[]` payload plus the top-level run totals.
 *
 * Columns: detector id, finding count (cases_created fallback — that IS the
 * intelligence run's "finding" in product terms), duration ms.
 *
 * If the evidence carries `run_id` (persistent runs landed in fresh main),
 * we link out to the full run page. Still gated on `run_id` being present
 * so very old events without a run id degrade cleanly.
 */
export function IntelligenceRunBlock({ event }: WorkspaceEventBlockProps) {
  const evidence = (event.evidence ?? {}) as IntelligenceEvidence;
  const detectors = Array.isArray(evidence.detectors) ? evidence.detectors : [];

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap gap-4">
        <Stat label="Duration" value={formatDuration(evidence.duration_ms)} />
        <Stat label="Detectors" value={String(detectors.length)} />
        {typeof evidence.cases_created === 'number' && (
          <Stat label="Nudges created" value={String(evidence.cases_created)} />
        )}
        {typeof evidence.errors === 'number' && (
          <Stat label="Errors" value={String(evidence.errors)} />
        )}
      </div>

      {evidence.error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          <span className="font-semibold">Run error:</span> {evidence.error}
        </div>
      )}

      {detectors.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-border-subtle">
          <table className="w-full text-xs">
            <thead className="bg-surface-base dark:bg-surface-base/40 text-left text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 font-medium">Detector</th>
                <th className="px-3 py-2 font-medium text-right">Findings</th>
                <th className="px-3 py-2 font-medium text-right">Duration</th>
              </tr>
            </thead>
            <tbody>
              {detectors.map((d, idx) => (
                <tr
                  key={`${d.detector ?? 'unknown'}:${idx}`}
                  className="border-t border-gray-100 dark:border-border-subtle"
                >
                  <td className="px-3 py-2 font-mono text-gray-900 dark:text-gray-100">
                    {d.detector ?? '(unknown)'}
                    {d.error && (
                      <span
                        className="ml-2 inline-flex items-center rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950/50 dark:text-red-300"
                        title={d.error}
                      >
                        error
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-700 dark:text-gray-300">
                    {findingCount(d)}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-700 dark:text-gray-300">
                    {formatDuration(d.duration_ms)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          No per-detector summaries on this run.
        </p>
      )}

      {evidence.run_id && (
        <div>
          <Link
            href={`/observatory/intelligence/runs/${evidence.run_id}`}
            className="text-accent hover:underline"
          >
            View full run →
          </Link>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[6rem]">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  );
}

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  return `${ms} ms`;
}

// Treat `findings` as authoritative when present; otherwise fall back to
// `cases_created`, which is the effective finding count for intelligence
// detectors (each surfaced finding materializes as a nudge case). Skipped
// duplicates are NOT counted — they are not new findings.
function findingCount(d: DetectorSummary): string {
  if (typeof d.findings === 'number') return String(d.findings);
  if (typeof d.cases_created === 'number') return String(d.cases_created);
  return '—';
}
