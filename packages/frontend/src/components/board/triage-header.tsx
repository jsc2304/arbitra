'use client';

/**
 * Triage Header — six view switchers (tablist) for the Board.
 *
 * Reads the active view from the URL (`?view=`). Selecting a tab updates the
 * URL via `router.replace` to keep browser history clean. Counts come from a
 * pre-computed `Record<TriageView, number>` so re-renders stay cheap.
 *
 * Role-aware default resolution lives in the parent (`app/board/page.tsx`);
 * this component is a pure controlled view-switcher.
 */

import { useCallback, useMemo } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import {
  TRIAGE_VIEWS,
  TRIAGE_VIEW_LABELS,
  type TriageView,
} from '../../lib/triage-views';

export interface TriageHeaderProps {
  /** Currently active view (authoritative for selected state). */
  activeView: TriageView;
  /** Pre-computed count of cases matching each view. */
  counts: Record<TriageView, number>;
}

export function TriageHeader({ activeView, counts }: TriageHeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleSelect = useCallback(
    (view: TriageView) => {
      if (view === activeView) return;
      const params = new URLSearchParams(searchParams.toString());
      params.set('view', view);
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [activeView, pathname, router, searchParams],
  );

  const views = useMemo(() => TRIAGE_VIEWS, []);

  return (
    <div
      role="tablist"
      aria-label="Triage views"
      className="flex flex-wrap items-center gap-1 border-b border-gray-200 dark:border-border-subtle"
    >
      {views.map((view) => {
        const isActive = view === activeView;
        const count = counts[view] ?? 0;
        return (
          <button
            key={view}
            type="button"
            role="tab"
            id={`triage-tab-${view}`}
            aria-selected={isActive}
            aria-controls="triage-tabpanel"
            tabIndex={isActive ? 0 : -1}
            onClick={() => handleSelect(view)}
            className={`group inline-flex items-center gap-2 rounded-t-md px-3 py-2 text-sm font-medium transition-colors -mb-px border-b-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${
              isActive
                ? 'border-accent text-accent-700 dark:text-accent-300'
                : 'border-transparent text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-surface-base dark:hover:bg-gray-800'
            }`}
          >
            <span>{TRIAGE_VIEW_LABELS[view]}</span>
            <span
              aria-label={`${count} case${count === 1 ? '' : 's'}`}
              className={`inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                isActive
                  ? 'bg-accent-700 text-white'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 group-hover:bg-gray-300 dark:group-hover:bg-gray-600'
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default TriageHeader;
