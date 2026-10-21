'use client';

import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSWRConfig } from 'swr';
import type { Case, Run } from '@arbitra/shared';
import { StatusBadge } from '../shared/status-badge';
import { RiskBadge } from '../shared/risk-badge';
import { TrackBadge } from '../shared/track-badge';
import { Tooltip } from '../shared/tooltip';
import { useUserMap } from '../../hooks/use-users';
import { UserDisplay } from '../shared/user-display';
import { RelativeTime } from '../shared/relative-time';
import { isCaseStale, staleDuration } from '../../lib/case-staleness';
import { useAuth } from '../../providers/auth-provider';
import { useToast } from '../../providers/toast-provider';
import { api } from '../../lib/api-client';

interface CaseCardProps {
  caseData: Case;
  activeRuns?: Run[];
  projectMap?: Record<string, string>;
  findingCount?: number;
}

export function CaseCard({ caseData, activeRuns = [], projectMap = {}, findingCount }: CaseCardProps) {
  const users = useUserMap([caseData.owner_user_id]);
  const stale = isCaseStale(caseData);
  const { user } = useAuth();
  const { addToast } = useToast();
  const { mutate } = useSWRConfig();
  const router = useRouter();
  const [acting, setActing] = useState<'gate' | 'assign' | null>(null);

  const isOwner = !!user && user.uid === caseData.owner_user_id;
  const hasPendingGate = !!caseData.pending_gate;
  // Hide Approve-gate for owners (anti-gaming per PR #226). Strict owner-check
  // is acceptable here; allow_self_approval lookup deferred.
  const showApproveGate = hasPendingGate && !isOwner;
  // Terminal statuses (`done`, `rejected`) don't need reviewer assignment —
  // the work is already concluded. Showing "Assign to me" on them is
  // misleading, so we hide the action.
  const isTerminal = caseData.status === 'done' || caseData.status === 'rejected';
  const showAssignToMe = !caseData.assigned_reviewer_id && !!user && !isTerminal;

  const caseHref = `/cases/${caseData.case_id}`;
  const courtroomHref = `/cases/${caseData.case_id}/courtroom`;
  const titleId = `case-${caseData.case_id}-title`;

  // Revalidate all cases list queries after mutations. Matches any SWR key of
  // the form ['cases', ...] as produced by use-cases.ts.
  function refreshCasesList() {
    mutate((key) => Array.isArray(key) && key[0] === 'cases', undefined, { revalidate: true });
  }

  async function handleApproveGate(e: ReactMouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!caseData.pending_gate) return;
    setActing('gate');
    try {
      await api.cases.submitDecision(caseData.case_id, {
        case_id: caseData.case_id,
        type: 'gate_confirmed',
        rationale: `Confirmed gate ${caseData.pending_gate.gate_id} to proceed to ${caseData.pending_gate.target_status}`,
      });
      addToast('success', 'Gate confirmed — case is proceeding');
      refreshCasesList();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to confirm gate');
    } finally {
      setActing(null);
    }
  }

  async function handleAssignToMe(e: ReactMouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!user) return;
    setActing('assign');
    try {
      await api.cases.update(caseData.case_id, { assigned_reviewer_id: user.uid });
      addToast('success', 'Assigned to you');
      refreshCasesList();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to assign case');
    } finally {
      setActing(null);
    }
  }

  // Body click handler for non-interactive regions. Paired with the real <Link>
  // on the title so keyboard users never depend on synthetic clicks.
  function handleBodyClick(e: ReactMouseEvent<HTMLElement>) {
    // Ignore clicks originating from interactive descendants (links, buttons).
    const target = e.target as HTMLElement;
    if (target.closest('a,button')) return;
    router.push(caseHref);
  }

  return (
    <article
      aria-labelledby={titleId}
      onClick={handleBodyClick}
      className="block rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-raised p-3 shadow-sm hover:shadow-md hover:border-gray-300 dark:hover:border-gray-600 transition-all cursor-pointer"
    >
      <h4 className="text-sm font-medium mb-2">
        <Tooltip
          label={
            <span className="block">
              <span className="block">{caseData.title}</span>
              <span className="block mt-0.5 font-mono text-[10px] opacity-80">
                {caseData.case_id}
              </span>
            </span>
          }
        >
          <Link
            id={titleId}
            href={caseHref}
            className="text-gray-900 dark:text-gray-100 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 rounded line-clamp-2 break-words"
          >
            {caseData.title}
          </Link>
        </Tooltip>
      </h4>

      <div className="flex flex-wrap gap-1.5 mb-2">
        <StatusBadge status={caseData.status} />
        <RiskBadge level={caseData.risk_level} />
        <TrackBadge track={caseData.validation_track} />
        {findingCount != null && findingCount > 0 && (
          <span className="inline-flex items-center gap-0.5 rounded bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
            <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
            {findingCount}
          </span>
        )}
        {caseData.pending_gate && (
          <span
            className="inline-flex items-center gap-0.5 rounded bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
            title={`Awaiting confirmation to proceed to ${caseData.pending_gate.target_status}`}
          >
            <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
            Gate
          </span>
        )}
        {stale && (
          <span
            className="inline-flex items-center gap-0.5 rounded bg-yellow-50 dark:bg-yellow-900/30 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-700 dark:text-yellow-300 border border-yellow-200 dark:border-yellow-800"
            title={staleDuration(caseData)}
          >
            <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
            Stale
          </span>
        )}
      </div>

      {caseData.jira_refs && caseData.jira_refs.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {caseData.jira_refs.map((ref) => (
            <span
              key={ref}
              className="inline-flex items-center rounded bg-blue-50 px-1 py-0.5 text-[10px] font-medium text-blue-700"
            >
              {ref}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span className="truncate max-w-[50%]">
          <UserDisplay userId={caseData.owner_user_id} users={users} />
        </span>
        <span className="truncate max-w-[40%]" title={caseData.project_id}>
          {projectMap[caseData.project_id] ?? caseData.project_id}
        </span>
      </div>

      {activeRuns.length > 0 && (
        <div className="flex items-center gap-1.5 mt-1.5 text-xs text-blue-600 dark:text-blue-400">
          <span className="animate-spin inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full" />
          <span className="truncate">
            {activeRuns[0]!.run_type.replace(/_/g, ' ')}
            {activeRuns.length > 1 ? ` +${activeRuns.length - 1}` : ''}
          </span>
        </div>
      )}

      <div className="mt-1.5 text-xs text-gray-400">
        {stale ? (
          <span className="text-yellow-600 dark:text-yellow-400">{staleDuration(caseData)}</span>
        ) : (
          <RelativeTime timestamp={caseData.created_at} />
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-gray-100 dark:border-border-subtle pt-2">
        {showApproveGate && (
          <button
            type="button"
            onClick={handleApproveGate}
            disabled={acting !== null}
            className="inline-flex items-center rounded-md bg-amber-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-1"
          >
            {acting === 'gate' ? 'Approving...' : 'Approve gate'}
          </button>
        )}
        {showAssignToMe && (
          <button
            type="button"
            onClick={handleAssignToMe}
            disabled={acting !== null}
            className="inline-flex items-center rounded-md bg-surface-raised px-2 py-1 text-[11px] font-medium text-gray-700 dark:text-gray-300 hover:bg-surface-base dark:hover:bg-gray-700 transition-colors ring-1 ring-gray-300 dark:ring-gray-600 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
          >
            {acting === 'assign' ? 'Assigning...' : 'Assign to me'}
          </button>
        )}
        <Link
          href={courtroomHref}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center rounded-md px-2 py-1 text-[11px] font-medium text-accent-700 dark:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-950/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
        >
          Open Courtroom
        </Link>
      </div>
    </article>
  );
}
