/**
 * @file CaseListCard — single-card representation used by the mobile list
 * view and by the mobile-accordion bodies inside the lifecycle/board views.
 *
 * This is the "list-style" card design: full-width,
 * stacked, readable title with `line-clamp-2`, status/risk/priority badges
 * underneath, plus a relative-time stamp. The row is a single Link so the
 * whole card is tappable on touch.
 */
'use client';

import Link from 'next/link';
import type { Case, Run } from '@arbitra/shared';
import { StatusBadge } from '../shared/status-badge';
import { RiskBadge } from '../shared/risk-badge';
import PriorityBadge from '../shared/priority-badge';
import { isCaseStale, staleDuration } from '../../lib/case-staleness';
import { RelativeTime } from '../shared/relative-time';

export interface CaseListCardProps {
  caseData: Case;
  activeRuns?: Run[];
  /**
   * Number of lines the title may occupy before truncating. The lifecycle /
   * board mobile accordions use 2 lines (more breathing room); the dense
   * mobile list view in `CaseListView` uses 1. Defaults to 2.
   */
  clamp?: 1 | 2;
}

export function CaseListCard({ caseData, activeRuns = [], clamp = 2 }: CaseListCardProps) {
  const c = caseData;
  return (
    <Link
      href={`/cases/${c.case_id}`}
      className="block px-4 py-3 hover:bg-surface-base dark:hover:bg-border-subtle/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span
          className={`text-sm font-medium text-gray-900 dark:text-gray-100 break-words ${
            clamp === 1 ? 'line-clamp-1' : 'line-clamp-2'
          }`}
          title={c.title}
        >
          {c.title}
        </span>
        <span className="text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap flex-shrink-0">
          <RelativeTime timestamp={c.updated_at} />
        </span>
      </div>
      <div className="text-[11px] font-mono text-gray-400 dark:text-gray-500 tracking-tight mb-2">
        {c.case_id}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={c.status} />
        <RiskBadge level={c.risk_level} />
        <PriorityBadge priority={c.priority} />
        {isCaseStale(c) && (
          <span
            className="inline-flex items-center gap-0.5 rounded bg-yellow-50 dark:bg-yellow-900/30 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-700 dark:text-yellow-300 border border-yellow-200 dark:border-yellow-800"
            title={staleDuration(c)}
          >
            Stale
          </span>
        )}
        {activeRuns.length > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-blue-600 dark:text-blue-400">
            <span className="animate-spin inline-block w-2.5 h-2.5 border-[1.5px] border-blue-400 border-t-transparent rounded-full" />
            {activeRuns[0]!.run_type.replace(/_/g, ' ')}
            {activeRuns.length > 1 ? ` +${activeRuns.length - 1}` : ''}
          </span>
        )}
      </div>
    </Link>
  );
}

export default CaseListCard;
