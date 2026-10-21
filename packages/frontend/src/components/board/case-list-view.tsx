'use client';

import Link from 'next/link';
import type { Case, Run } from '@arbitra/shared';
import { StatusBadge } from '../shared/status-badge';
import { RiskBadge } from '../shared/risk-badge';
import PriorityBadge from '../shared/priority-badge';
import { useMemo } from 'react';
import { useUserMap } from '../../hooks/use-users';
import { UserDisplay } from '../shared/user-display';
import { RelativeTime } from '../shared/relative-time';
import { isCaseStale, staleDuration } from '../../lib/case-staleness';
import { CaseListCard } from './case-list-card';

type SortField = 'updated_at' | 'created_at' | 'priority' | 'risk_level' | 'status';
type SortDir = 'asc' | 'desc';

const priorityOrder: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const riskOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const statusOrder: Record<string, number> = {
  open: 0, exploration: 1, ready_for_build: 2, in_build: 3, in_validation: 4,
  in_review: 5, needs_human_decision: 6, verification_pending: 7, approved: 8, pending_merge: 9, done: 10, rejected: 11,
};

interface CaseListViewProps {
  cases: Case[];
  sortField: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
  projectMap?: Record<string, string>;
  findingCounts?: Record<string, number>;
  activeRunsByCase?: Record<string, Run[]>;
}

export function CaseListView({ cases, sortField, sortDir, onSort, projectMap = {}, findingCounts = {}, activeRunsByCase = {} }: CaseListViewProps) {
  const ownerIds = useMemo(() => [...new Set(cases.map((c) => c.owner_user_id))], [cases]);
  const users = useUserMap(ownerIds);

  const sorted = [...cases].sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case 'updated_at':
        cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
        break;
      case 'created_at':
        cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        break;
      case 'priority':
        cmp = (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9);
        break;
      case 'risk_level':
        cmp = (riskOrder[a.risk_level] ?? 9) - (riskOrder[b.risk_level] ?? 9);
        break;
      case 'status':
        cmp = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
        break;
    }
    return sortDir === 'desc' ? -cmp : cmp;
  });

  function SortHeader({ field, label, className }: { field: SortField; label: string; className?: string }) {
    const isActive = sortField === field;
    return (
      <th
        className={`px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide cursor-pointer select-none hover:text-gray-900 dark:hover:text-gray-100 transition-colors ${
          isActive ? 'text-accent-700 dark:text-accent-400' : 'text-gray-500 dark:text-gray-400'
        } ${className ?? ''}`}
        onClick={() => onSort(field)}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {isActive && (
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="currentColor">
              {sortDir === 'asc' ? (
                <path d="M6 3l4 5H2z" />
              ) : (
                <path d="M6 9l4-5H2z" />
              )}
            </svg>
          )}
        </span>
      </th>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-raised shadow-sm">
      {/* Mobile: Card layout (shares CaseListCard with the lifecycle/board
          mobile accordions — single source of truth for the title/clamp,
          badge, and active-run rendering). The list view uses a 1-line title
          clamp for density; the accordions default to 2. */}
      <div className="md:hidden divide-y divide-gray-100 dark:divide-gray-800">
        {sorted.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-gray-400">
            No cases match the current filters.
          </div>
        ) : (
          sorted.map((c) => (
            <CaseListCard
              key={c.case_id}
              caseData={c}
              activeRuns={activeRunsByCase[c.case_id]}
              clamp={1}
            />
          ))
        )}
      </div>

      {/* Desktop: Table layout */}
      <div className="hidden md:block overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-surface-base dark:bg-surface-base/50">
            <tr>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide w-[35%]">
                Case
              </th>
              <SortHeader field="status" label="Status" />
              <SortHeader field="risk_level" label="Risk" />
              <SortHeader field="priority" label="Priority" />
              <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Project
              </th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Owner
              </th>
              <SortHeader field="updated_at" label="Updated" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-12 text-center text-sm text-gray-400">
                  No cases match the current filters.
                </td>
              </tr>
            ) : (
              sorted.map((c) => (
                <tr key={c.case_id} className="hover:bg-surface-base dark:hover:bg-border-subtle/50 transition-colors">
                  <td className="px-3 py-3">
                    <Link href={`/cases/${c.case_id}`} className="block group">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 group-hover:text-accent-700 dark:group-hover:text-accent-400 transition-colors">
                        {c.title}
                      </span>
                      <span className="block text-[11px] text-gray-400 dark:text-gray-500 tracking-tight mt-0.5">
                        {c.case_id}
                        {c.jira_refs && c.jira_refs.length > 0 && (
                          <span className="ml-2">
                            {c.jira_refs.map((ref) => (
                              <span
                                key={ref}
                                className="inline-flex items-center rounded bg-blue-50 px-1 py-0 text-[10px] font-medium text-blue-600 ml-1"
                              >
                                {ref}
                              </span>
                            ))}
                          </span>
                        )}
                        {(findingCounts[c.case_id] ?? 0) > 0 && (
                          <span className="ml-2 inline-flex items-center gap-0.5 rounded bg-amber-50 dark:bg-amber-900/30 px-1 py-0 text-[10px] font-semibold text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                            <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                            </svg>
                            {findingCounts[c.case_id]} findings
                          </span>
                        )}
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1.5">
                      <StatusBadge status={c.status} />
                      {isCaseStale(c) && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-yellow-50 dark:bg-yellow-900/30 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-700 dark:text-yellow-300 border border-yellow-200 dark:border-yellow-800" title={staleDuration(c)}>
                          Stale
                        </span>
                      )}
                      {(activeRunsByCase[c.case_id]?.length ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-blue-600 dark:text-blue-400" title={activeRunsByCase[c.case_id]!.map((r) => r.run_type.replace(/_/g, ' ')).join(', ')}>
                          <span className="animate-spin inline-block w-2.5 h-2.5 border-[1.5px] border-blue-400 border-t-transparent rounded-full" />
                          {activeRunsByCase[c.case_id]![0]!.run_type.replace(/_/g, ' ')}
                          {activeRunsByCase[c.case_id]!.length > 1 ? ` +${activeRunsByCase[c.case_id]!.length - 1}` : ''}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <RiskBadge level={c.risk_level} />
                  </td>
                  <td className="px-3 py-3">
                    <PriorityBadge priority={c.priority} />
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-600 dark:text-gray-400 truncate max-w-[120px]" title={c.project_id}>
                    {projectMap[c.project_id] ?? c.project_id}
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-600 dark:text-gray-400 truncate max-w-[120px]">
                    <UserDisplay userId={c.owner_user_id} users={users} />
                  </td>
                  <td className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    <RelativeTime timestamp={c.updated_at} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Footer (shared) */}
      <div className="border-t border-gray-200 dark:border-border-subtle bg-surface-base dark:bg-surface-base/50 px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
        {sorted.length} case{sorted.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
