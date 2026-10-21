'use client';

import type { PausedSchedulerFeature } from '@arbitra/shared';
import { usePausedSchedulers } from '../../hooks/use-paused-schedulers';

/**
 * Body copy per paused feature. Kept next to the banner (not in
 * `@arbitra/shared`) because it is UI copy, not a domain fact — the domain
 * fact is just "this feature's scheduler is paused", carried by
 * `PausedSchedulerFeature` itself.
 */
const FEATURE_COPY: Record<PausedSchedulerFeature, string> = {
  blueprint_tick:
    'Scheduled Clerk tasks do not fire on this environment. Run-now still works.',
  intelligence:
    'The daily intelligence run does not fire on this environment. A manual run from this page still works.',
  run_sweeper:
    "Stale-run cleanup does not run on this environment; runs that lose their worker stay in their last state until swept manually.",
};

interface SchedulerPausedBannerProps {
  feature: PausedSchedulerFeature;
  className?: string;
}

/**
 * Full-width red alert shown when `feature`'s scheduled job is paused on this
 * environment (see `packages/shared/src/utils/paused-schedulers.ts`). Renders
 * nothing when the feature isn't paused (no `ARBITRA_PAUSED_SCHEDULERS` set,
 * or the env var removed and the service redeployed).
 */
export function SchedulerPausedBanner({ feature, className = '' }: SchedulerPausedBannerProps) {
  const { isPaused } = usePausedSchedulers();
  if (!isPaused(feature)) return null;

  return (
    <div
      role="alert"
      className={`rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 p-4 ${className}`}
    >
      <p className="text-sm font-semibold text-red-800 dark:text-red-300">
        Paused on this instance
      </p>
      <p className="mt-0.5 text-xs text-red-700 dark:text-red-400">{FEATURE_COPY[feature]}</p>
    </div>
  );
}
