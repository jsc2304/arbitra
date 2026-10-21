'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { Run } from '@arbitra/shared';
import { formatRunElapsed, isActiveRun, runStatusLabel, runTypeLabel } from '../../lib/run-display';

interface ActiveRunBannerProps {
  runs: Run[];
  caseId: string;
  now?: Date;
}

export function ActiveRunBanner({ runs, caseId, now }: ActiveRunBannerProps) {
  const activeRuns = useMemo(() => runs.filter(isActiveRun), [runs]);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (now || activeRuns.length === 0) return;
    const handle = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(handle);
  }, [activeRuns.length, now]);

  if (activeRuns.length === 0) return null;

  const primary = activeRuns[0]!;
  const displayNow = now ?? new Date();
  const elapsed = formatRunElapsed(primary, displayNow);
  const extraCount = activeRuns.length - 1;

  return (
    <div className="rounded-lg border border-corp-green/30 bg-corp-green/10 px-4 py-3 text-sm text-corp-dark shadow-sm dark:border-corp-green/40 dark:bg-corp-green/15 dark:text-corp-green">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-1 flex h-3 w-3 shrink-0 rounded-full bg-corp-green shadow-[0_0_0_5px_rgba(34,197,94,0.14)]">
            <span className="h-3 w-3 animate-ping rounded-full bg-corp-green/70" />
          </span>
          <div className="min-w-0">
            <p className="font-semibold">
              {runTypeLabel(primary.run_type)} {runStatusLabel(primary.status)}
              {extraCount > 0 ? ` +${extraCount} more` : ''}
            </p>
            <p className="mt-0.5 truncate text-xs opacity-80">
              Active for {elapsed}
              {primary.summary ? ` · ${primary.summary}` : ''}
            </p>
          </div>
        </div>
        <Link
          href={`/cases/${caseId}?tab=runs`}
          className="inline-flex shrink-0 items-center justify-center rounded-md border border-corp-green/30 bg-white/70 px-3 py-1.5 text-xs font-semibold text-corp-dark transition-colors hover:bg-white dark:border-corp-green/50 dark:bg-surface-raised/60 dark:text-corp-green dark:hover:bg-surface-raised"
        >
          View runs
        </Link>
      </div>
    </div>
  );
}
