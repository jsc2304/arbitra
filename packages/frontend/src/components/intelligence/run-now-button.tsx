'use client';

import { useState } from 'react';
import type { IntelligenceRun } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useToast } from '../../providers/toast-provider';

interface RunNowButtonProps {
  /**
   * Called with the freshly-persisted run on success. The parent uses this
   * to revalidate its `listRuns` SWR key and/or inline the run while the
   * next page-fetch resolves.
   */
  onRunCompleted?: (run: IntelligenceRun) => void;
}

/**
 * Admin "Run Now" button. Disabled while a run is in flight. Surfaces the
 * backend's 409 ("another run is already in progress") as a toast rather
 * than a hard error — the admin can simply retry once the lock clears.
 */
export function RunNowButton({ onRunCompleted }: RunNowButtonProps) {
  const [busy, setBusy] = useState(false);
  const { addToast } = useToast();

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    try {
      const run = await api.intelligence.runNow();
      addToast(
        'success',
        `Run complete — ${run.findings_total} finding${run.findings_total === 1 ? '' : 's'} across ${run.detector_count} detector${run.detector_count === 1 ? '' : 's'}.`,
      );
      onRunCompleted?.(run);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Run failed';
      addToast('error', msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      aria-busy={busy}
      className="inline-flex items-center gap-2 rounded-md bg-accent-700 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-accent-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
    >
      {busy && (
        <svg
          className="h-3.5 w-3.5 animate-spin"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx={12}
            cy={12}
            r={10}
            stroke="currentColor"
            strokeWidth={4}
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      )}
      {busy ? 'Running…' : 'Run Now'}
    </button>
  );
}
