'use client';

import useSWR from 'swr';
import Link from 'next/link';
import type { Case } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { StatusBadge } from '../shared/status-badge';
import { RiskBadge } from '../shared/risk-badge';
import { SkeletonRow } from '../shared/skeleton';
import ErrorCard from '../shared/error-card';
import { RelativeTime } from '../shared/relative-time';

interface RelatedCaseGroup {
  relation: string;
  label: string;
  value: string;
  cases: Case[];
}

interface RelatedCasesPanelProps {
  caseId: string;
}

const RELATION_ICONS: Record<string, React.JSX.Element> = {
  branch: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
    </svg>
  ),
  repository: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
    </svg>
  ),
  project: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
    </svg>
  ),
  owner: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
    </svg>
  ),
};

function RelatedCaseRow({ c }: { c: Case }) {
  return (
    <Link
      href={`/cases/${c.case_id}`}
      className="flex items-center gap-3 px-4 py-3 hover:bg-surface-base dark:hover:bg-border-subtle/50 transition-colors border-b border-gray-100 dark:border-border-subtle last:border-b-0"
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate" title={c.title}>
          {c.title}
        </p>
        <div className="flex items-center gap-2 mt-1">
          {c.current_branch && (
            <span className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[200px]">
              {c.current_branch}
            </span>
          )}
          <RelativeTime
            timestamp={c.updated_at}
            className="text-xs text-gray-400 dark:text-gray-500"
          />
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <RiskBadge level={c.risk_level} />
        <StatusBadge status={c.status} />
      </div>
    </Link>
  );
}

function GroupSection({ group }: { group: RelatedCaseGroup }) {
  const icon = RELATION_ICONS[group.relation] ?? RELATION_ICONS.project;

  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 bg-surface-base dark:bg-surface-base/50 border-b border-gray-200 dark:border-border-subtle">
        <span className="text-gray-500 dark:text-gray-400">{icon}</span>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          {group.label}
        </h3>
        <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
          {group.value}
        </span>
        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">
          {group.cases.length} case{group.cases.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div>
        {group.cases.map((c) => (
          <RelatedCaseRow key={c.case_id} c={c} />
        ))}
      </div>
    </div>
  );
}

export function RelatedCasesPanel({ caseId }: RelatedCasesPanelProps) {
  const { data, error, isLoading, mutate } = useSWR(
    caseId ? ['related', caseId] : null,
    () => api.cases.related(caseId),
  );

  const groups = data?.groups ?? [];

  if (isLoading) {
    return (
      <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg px-4 py-4 space-y-2">
        <SkeletonRow columns={4} />
        <SkeletonRow columns={4} />
        <SkeletonRow columns={4} />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorCard
        title="Failed to load related cases"
        message={error instanceof Error ? error.message : String(error)}
        onRetry={() => mutate()}
      />
    );
  }

  if (groups.length === 0) {
    return (
      <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg px-6 py-8 text-center">
        <svg className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
        </svg>
        <p className="mt-2 text-sm font-medium text-gray-700 dark:text-gray-300">No related cases</p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Cases sharing the same branch, repository, or project will appear here.
        </p>
      </div>
    );
  }

  // Deduplicate: cases that appear in multiple groups (e.g. same repo AND same project)
  // are shown in the most specific group only (branch > repository > project > owner)
  const seen = new Set<string>();
  const deduped = groups.map((group) => {
    const uniqueCases = group.cases.filter((c) => !seen.has(c.case_id));
    uniqueCases.forEach((c) => seen.add(c.case_id));
    return { ...group, cases: uniqueCases };
  }).filter((group) => group.cases.length > 0);

  return (
    <div className="space-y-4">
      {deduped.map((group) => (
        <GroupSection key={group.relation} group={group} />
      ))}
    </div>
  );
}
