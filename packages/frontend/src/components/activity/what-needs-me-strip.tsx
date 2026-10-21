'use client';

import useSWR from 'swr';
import { api } from '../../lib/api-client';

/**
 * "What needs me" pinned strip. Renders four chips with counts above
 * the feed; clicking a chip applies the chip's filter via `onApplyFilter`.
 *
 * Step 4 ships this unconditionally — the "Signal mode
 * only" gating happens in step 5 once Signal/Raw chrome differentiation
 * lands.
 *
 * Chip filter payload uses the same shape as the `WhatNeedsMeFilter` union
 * exported here so the parent can type-narrow when wiring it into the feed.
 */
export type WhatNeedsMeFilter =
  | { needsMe: true }
  | { openedBy: 'detector' }
  | { kind: 'case_event'; subkind: string }
  | { kind: 'workspace_event'; subkind: string };

interface WhatNeedsMeStripProps {
  onApplyFilter: (filter: WhatNeedsMeFilter, label: string) => void;
}

interface ChipDef {
  id: keyof Awaited<ReturnType<typeof api.activity.needsMe>>;
  label: string;
  description: string;
}

const CHIPS: ChipDef[] = [
  {
    id: 'awaiting_decision',
    label: 'Awaiting your decision',
    description: 'Cases needing your gate or verification',
  },
  {
    id: 'idle_over_threshold',
    label: 'Idle over threshold',
    description: 'Arbitra-flagged stale cases on your projects',
  },
  {
    id: 'failed_builds_24h',
    label: 'Failed builds (24h)',
    description: 'Run failures in the last 24 hours',
  },
  {
    id: 'webhook_rejections',
    label: 'Webhook rejections',
    description: 'Unacknowledged webhook rejections',
  },
];

export function WhatNeedsMeStrip({ onApplyFilter }: WhatNeedsMeStripProps) {
  const { data } = useSWR(
    ['activity', 'needs-me'],
    () => api.activity.needsMe(),
    {
      // Refresh on the same cadence as the actionable badge — cheap and the
      // chip's "what's hot" semantics tolerate a 30s lag.
      refreshInterval: 30_000,
      revalidateOnFocus: true,
    },
  );

  // Render even before data arrives so the strip's height doesn't pop in;
  // the buttons render disabled with a `—` placeholder while loading.
  return (
    <div
      data-testid="what-needs-me-strip"
      className="mb-3 rounded-xl border border-gray-200 bg-surface-raised p-2 dark:border-border-subtle"
      aria-label="Items that need your attention"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          What needs me
        </span>
        {CHIPS.map((chip) => {
          const slot = data?.[chip.id];
          const count = slot?.count ?? null;
          const disabled = count === null || count === 0;
          return (
            <button
              key={chip.id}
              type="button"
              disabled={disabled}
              onClick={() => {
                if (slot) onApplyFilter(slot.filter as WhatNeedsMeFilter, chip.label);
              }}
              data-chip-id={chip.id}
              data-count={count ?? ''}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                disabled
                  ? 'cursor-default border-gray-200 bg-surface-base text-gray-400 dark:border-border-subtle dark:bg-surface-base/30 dark:text-gray-600'
                  : 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/15 dark:border-accent-300/40 dark:bg-accent/15 dark:text-accent-300'
              }`}
              title={chip.description}
              aria-label={`${chip.label}: ${count ?? 0}`}
            >
              <span className="font-medium">{chip.label}</span>
              <span
                className={`inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold ${
                  disabled
                    ? 'bg-gray-100 text-gray-400 dark:bg-border-subtle/40 dark:text-gray-500'
                    : 'bg-accent-700 text-white'
                }`}
              >
                {count ?? '—'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
