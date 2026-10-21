'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { DetectorConfig } from '@arbitra/shared';
import { RelativeTime } from '../shared/relative-time';
import { useToast } from '../../providers/toast-provider';
import { api } from '../../lib/api-client';

export interface DetectorCardData {
  detector_id: string;
  name: string;
  description: string;
  config: DetectorConfig;
  last_run?: { started_at: string; finding_count: number };
}

interface DetectorStatusCardProps {
  detector: DetectorCardData;
  /**
   * Called after a successful toggle so the parent can revalidate whatever
   * SWR key it owns. The optimistic flip lives inside this card.
   */
  onEnabledChanged?: (detectorId: string, enabled: boolean) => void;
}

/**
 * Admin card summarizing one detector. Renders name, description, last-run
 * stats, and a click-to-toggle enable switch.
 *
 * Toggle flow: optimistic flip → PATCH → on error roll back the flip and
 * emit a toast. We keep the local state instead of round-tripping through
 * SWR so the user sees an instantaneous response.
 */
export function DetectorStatusCard({ detector, onEnabledChanged }: DetectorStatusCardProps) {
  const { addToast } = useToast();
  const [enabled, setEnabled] = useState<boolean>(detector.config.enabled);
  const [busy, setBusy] = useState<boolean>(false);

  async function toggle() {
    if (busy) return;
    const next = !enabled;
    setEnabled(next);
    setBusy(true);
    try {
      await api.intelligence.setDetectorEnabled(detector.detector_id, next);
      onEnabledChanged?.(detector.detector_id, next);
    } catch (err) {
      // Roll back and surface the error. The detector stays in whatever
      // state the server persists.
      setEnabled(!next);
      const msg = err instanceof Error ? err.message : 'Failed to update detector';
      addToast('error', msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-border-subtle bg-surface-raised p-4 shadow-sm flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {detector.name}
          </h3>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 leading-snug line-clamp-3">
            {detector.description}
          </p>
        </div>
        <ToggleButton
          enabled={enabled}
          disabled={busy}
          onClick={toggle}
          label={`${enabled ? 'Disable' : 'Enable'} ${detector.name}`}
        />
      </div>

      <LastRunSummary lastRun={detector.last_run} />

      <div className="flex items-center justify-between pt-1 border-t border-gray-100 dark:border-border-subtle">
        <span className="font-mono text-[10px] text-gray-400 dark:text-gray-600 truncate">
          {detector.detector_id}
        </span>
        <Link
          href={`/observatory/intelligence/detectors/${detector.detector_id}`}
          className="text-xs font-medium text-accent hover:text-accent-700 dark:hover:text-accent-300"
        >
          View findings →
        </Link>
      </div>
    </div>
  );
}

function LastRunSummary({
  lastRun,
}: {
  lastRun?: { started_at: string; finding_count: number };
}) {
  if (!lastRun) {
    return (
      <p className="text-xs text-gray-400 dark:text-gray-500 italic">
        No runs persisted yet.
      </p>
    );
  }
  return (
    <LastRunSummaryInner
      startedAt={lastRun.started_at}
      findingCount={lastRun.finding_count}
    />
  );
}

function LastRunSummaryInner({
  startedAt,
  findingCount,
}: {
  startedAt: string;
  findingCount: number;
}) {
  return (
    <div className="flex items-baseline justify-between text-xs text-gray-600 dark:text-gray-400">
      <RelativeTime timestamp={startedAt} prefix="Last run" />
      <span className="tabular-nums font-medium text-gray-800 dark:text-gray-200">
        {findingCount} finding{findingCount === 1 ? '' : 's'}
      </span>
    </div>
  );
}

/**
 * Minimal in-house switch. The codebase has no `shadcn/ui` primitives yet;
 * rather than introduce a dependency we render a styled `<button role="switch">`
 * that carries the correct ARIA state.
 */
function ToggleButton({
  enabled,
  disabled,
  onClick,
  label,
}: {
  enabled: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
        enabled ? 'bg-accent' : 'bg-gray-300 dark:bg-gray-700'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
          enabled ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
