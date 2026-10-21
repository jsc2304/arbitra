import type { Case, CaseStatus, Run } from '@arbitra/shared';
import { CaseCard } from './case-card';

const STATUS_LABELS: Record<CaseStatus, string> = {
  open: 'Open',
  exploration: 'Exploration',
  ready_for_build: 'Ready for Build',
  in_build: 'In Build',
  in_validation: 'In Validation',
  in_review: 'In Review',
  needs_human_decision: 'Needs Decision',
  verification_pending: 'Verification Pending',
  approved: 'Approved',
  pending_merge: 'Merge PR',
  done: 'Done',
  rejected: 'Rejected',
};

interface StatusColumnProps {
  status: CaseStatus;
  cases: Case[];
  projectMap: Record<string, string>;
  findingCounts?: Record<string, number>;
  activeRunsByCase?: Record<string, Run[]>;
}

export function StatusColumn({ status, cases, projectMap, findingCounts = {}, activeRunsByCase = {} }: StatusColumnProps) {
  const label = STATUS_LABELS[status] ?? status;

  return (
    <div className="flex flex-col w-full sm:w-auto sm:min-w-[260px] sm:max-w-[320px] bg-surface-base dark:bg-surface-base/50 rounded-lg border border-gray-200 dark:border-border-subtle">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-border-subtle">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{label}</h3>
        <span className="inline-flex items-center justify-center rounded-full bg-gray-200 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300">
          {cases.length}
        </span>
      </div>

      <div className="scrollbar-subtle flex-1 overflow-y-auto p-2 space-y-2 sm:max-h-[calc(100vh-240px)]">
        {cases.length === 0 ? (
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-6">No cases</p>
        ) : (
          cases.map((c) => <CaseCard key={c.case_id} caseData={c} projectMap={projectMap} findingCount={findingCounts[c.case_id]} activeRuns={activeRunsByCase[c.case_id]} />)
        )}
      </div>
    </div>
  );
}
