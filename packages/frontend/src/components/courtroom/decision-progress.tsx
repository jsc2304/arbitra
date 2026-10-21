'use client';

import type { CaseStatus, Finding } from '@arbitra/shared';
import { countBlockers } from '../../lib/finding-selectors';

type ProgressStepState = 'complete' | 'current' | 'blocked' | 'pending';

interface ProgressStep {
  label: string;
  description: string;
  state: ProgressStepState;
}

export interface DecisionProgressModel {
  eyebrow: string;
  title: string;
  summary: string;
  progressPercent: number;
  steps: ProgressStep[];
  selectedFindingNote?: string;
}

export interface DecisionProgressProps {
  caseStatus?: CaseStatus;
  findings?: readonly Finding[];
  hasFinding: boolean;
  onClearFinding?: () => void;
  /**
   * Escape hatch for a stale approval (issue #765): a review can complete
   * against a pre-rebase diff, land the approval, and advance the case to
   * `pending_merge` before further commits arrive. There is otherwise no
   * courtroom affordance to send such a case back for a fresh review — the
   * backend transition (`request_changes` → `in_build`) already exists but
   * nothing surfaced it. Rendered only when `caseStatus === 'pending_merge'`
   * and only as a secondary action on the "Approved, waiting for merge"
   * card, never as a full Tier-1 row: re-showing Approve here would let a
   * reviewer "approve" an already-approved case, which is meaningless.
   */
  onRequestPendingMergeChanges?: () => void;
}

function findingWord(count: number): string {
  return count === 1 ? 'finding' : 'findings';
}

function blockerSummary(total: number, critical: number, high: number): string {
  return `${total} blocking ${findingWord(total)} (${critical} critical, ${high} high)`;
}

export function buildDecisionProgressModel({
  caseStatus,
  findings = [],
  hasFinding,
}: Omit<
  DecisionProgressProps,
  'onClearFinding' | 'onRequestPendingMergeChanges'
>): DecisionProgressModel {
  const blockers = countBlockers(findings);
  const hasBlockers = blockers.total > 0;
  const selectedFindingNote = hasFinding
    ? 'A finding is selected: Mark as resolved and Flag as blocking update that finding. Deselect it to submit a case-level Approve or Request Changes decision.'
    : undefined;

  if (caseStatus === 'pending_merge') {
    return {
      eyebrow: 'Step 3 of 3',
      title: 'Approved, waiting for merge',
      summary: 'The courtroom decision is complete. The case will finish when the merge lands.',
      progressPercent: 88,
      steps: [
        {
          label: 'Blocking findings cleared',
          description: 'No blocker is holding the approval gate.',
          state: 'complete',
        },
        {
          label: 'Case decision recorded',
          description: 'The case has already been approved.',
          state: 'complete',
        },
        {
          label: 'Merge completes',
          description: 'The case moves to done after the merge signal.',
          state: 'current',
        },
      ],
    };
  }

  if (caseStatus === 'approved') {
    return {
      eyebrow: 'Step 3 of 3',
      title: 'Case approved',
      summary: 'The courtroom decision is complete. The next lifecycle step can advance the case.',
      progressPercent: 100,
      steps: [
        {
          label: 'Blocking findings cleared',
          description: 'No blocker is holding the approval gate.',
          state: 'complete',
        },
        {
          label: 'Case decision recorded',
          description: 'Approval is documented in the audit trail.',
          state: 'complete',
        },
        {
          label: 'Case can advance',
          description: 'No further courtroom decision is required.',
          state: 'complete',
        },
      ],
    };
  }

  if (caseStatus === 'done' || caseStatus === 'rejected') {
    const rejected = caseStatus === 'rejected';
    return {
      eyebrow: 'Complete',
      title: rejected ? 'Case rejected' : 'Case done',
      summary: rejected
        ? 'The case was rejected and no further courtroom decision is available.'
        : 'The case is complete and no further courtroom decision is available.',
      progressPercent: 100,
      steps: [
        {
          label: 'Review finished',
          description: 'The courtroom phase is no longer active.',
          state: 'complete',
        },
        {
          label: 'Final decision recorded',
          description: rejected ? 'The rejection is terminal.' : 'The case reached done.',
          state: 'complete',
        },
        {
          label: 'No action needed',
          description: 'This case is closed.',
          state: 'complete',
        },
      ],
    };
  }

  if (caseStatus === 'verification_pending') {
    return {
      eyebrow: 'Step 2 of 3',
      title: 'Manual verification decision needed',
      summary: 'Approve confirms manual validation and records the case decision. Request Changes sends the case back for rework.',
      progressPercent: 58,
      steps: [
        {
          label: 'Review completed',
          description: 'The case is waiting for manual verification.',
          state: 'complete',
        },
        {
          label: 'Record manual decision',
          description: 'Approve, Request Changes, or Reject the case.',
          state: 'current',
        },
        {
          label: 'Case advances',
          description: 'Approval moves the case forward once four-eyes policy is satisfied.',
          state: 'pending',
        },
      ],
      selectedFindingNote,
    };
  }

  if (caseStatus === 'in_validation') {
    return {
      eyebrow: 'Before courtroom',
      title: 'Validation still running',
      summary: 'Courtroom decisions unlock after validation and review have produced a decision point.',
      progressPercent: 20,
      steps: [
        {
          label: 'Validation',
          description: 'Evidence is being checked.',
          state: 'current',
        },
        {
          label: 'Review decision',
          description: 'The decision controls will become active after review.',
          state: 'pending',
        },
        {
          label: 'Case advances',
          description: 'No courtroom action is needed yet.',
          state: 'pending',
        },
      ],
    };
  }

  if (caseStatus === 'in_review') {
    return {
      eyebrow: 'Step 1 of 3',
      title: 'Review running',
      summary: 'Courtroom decisions unlock after review produces findings and a decision point.',
      progressPercent: 35,
      steps: [
        {
          label: 'Validation',
          description: 'Evidence has been checked.',
          state: 'complete',
        },
        {
          label: 'Review in progress',
          description: 'Waiting for findings before case-level decisions become available.',
          state: 'current',
        },
        {
          label: 'Case advances',
          description: 'No courtroom action is needed yet.',
          state: 'pending',
        },
      ],
    };
  }

  if (hasBlockers) {
    return {
      eyebrow: 'Step 1 of 3',
      title: 'Clear blockers before approval',
      summary: `${blockerSummary(blockers.total, blockers.critical, blockers.high)} still prevent case approval. Low and medium findings do not block the approval gate.`,
      progressPercent: 18,
      steps: [
        {
          label: 'Resolve or waive blockers',
          description: `${blockerSummary(blockers.total, blockers.critical, blockers.high)} remain.`,
          state: 'blocked',
        },
        {
          label: 'Record case decision',
          description: 'Approve unlocks after blockers are cleared; Request Changes and Reject remain case-level choices.',
          state: 'pending',
        },
        {
          label: 'Case advances',
          description: 'A case-level decision transitions the case when gates are satisfied.',
          state: 'pending',
        },
      ],
      selectedFindingNote,
    };
  }

  return {
    eyebrow: 'Step 2 of 3',
    title: 'Ready for case decision',
    summary: 'No high or critical finding is blocking approval. Submit a case-level Approve, Request Changes, or Reject decision to finish the courtroom step.',
    progressPercent: 58,
    steps: [
      {
        label: 'Blocking findings cleared',
        description: 'Approval is no longer blocked by high or critical findings.',
        state: 'complete',
      },
      {
        label: 'Record case decision',
        description: hasFinding
          ? 'Deselect the finding to use the case-level decision controls.'
          : 'Choose the outcome for the case.',
        state: 'current',
      },
      {
        label: 'Case advances',
        description: 'Approval may move the case forward immediately if evidence and four-eyes gates are satisfied.',
        state: 'pending',
      },
    ],
    selectedFindingNote,
  };
}

const stepStateClasses: Record<ProgressStepState, string> = {
  complete: 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  current: 'border-accent bg-accent/10 text-accent dark:border-accent dark:bg-accent/15 dark:text-accent',
  blocked: 'border-amber-500 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  pending: 'border-gray-300 bg-surface-base text-gray-500 dark:border-border-default dark:bg-surface-base/50 dark:text-gray-400',
};

const stepDotLabels: Record<ProgressStepState, string> = {
  complete: 'Done',
  current: 'Now',
  blocked: 'Blocked',
  pending: 'Next',
};

export function DecisionProgress(props: DecisionProgressProps) {
  const model = buildDecisionProgressModel(props);

  return (
    <section
      aria-label="Courtroom decision progress"
      className="mb-4 rounded-lg border border-gray-200 bg-surface-base p-3 dark:border-border-subtle dark:bg-surface-base/40"
      data-testid="decision-progress"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {model.eyebrow}
          </p>
          <h4 className="mt-0.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {model.title}
          </h4>
        </div>
        <span className="rounded-full bg-gray-100 px-2 py-1 text-[11px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          {Math.round(model.progressPercent)}%
        </span>
      </div>

      <div
        role="progressbar"
        aria-valuenow={Math.round(model.progressPercent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Courtroom decision progress"
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"
      >
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${model.progressPercent}%` }}
        />
      </div>

      <p className="mt-3 text-xs leading-relaxed text-gray-600 dark:text-gray-400">
        {model.summary}
      </p>

      <div className="mt-3 space-y-2">
        {model.steps.map((step, index) => (
          <div key={step.label} className="flex gap-2">
            <div
              className={`mt-0.5 flex h-5 min-w-5 items-center justify-center rounded-full border text-[9px] font-semibold ${stepStateClasses[step.state]}`}
              aria-hidden="true"
            >
              {step.state === 'complete' ? '✓' : index + 1}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="text-xs font-medium text-gray-800 dark:text-gray-200">
                  {step.label}
                </p>
                <span
                  className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${stepStateClasses[step.state]}`}
                >
                  {stepDotLabels[step.state]}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
                {step.description}
              </p>
            </div>
          </div>
        ))}
      </div>

      {model.selectedFindingNote && (
        <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-2 text-[11px] leading-relaxed text-blue-800 dark:border-blue-900 dark:bg-blue-950/35 dark:text-blue-300">
          <p>{model.selectedFindingNote}</p>
          {props.onClearFinding && (
            <button
              type="button"
              onClick={props.onClearFinding}
              className="mt-2 inline-flex items-center rounded-md border border-blue-300 bg-white px-2 py-1 text-[11px] font-medium text-blue-800 transition-colors hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/60 dark:text-blue-200 dark:hover:bg-blue-900/60"
            >
              Deselect finding
            </button>
          )}
        </div>
      )}

      {props.caseStatus === 'pending_merge' && props.onRequestPendingMergeChanges && (
        <div className="mt-3 border-t border-gray-200 dark:border-border-subtle pt-3">
          <p className="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
            Diff changed since the approval? Request changes to reopen the build.
          </p>
          <button
            type="button"
            data-testid="pending-merge-request-changes"
            onClick={props.onRequestPendingMergeChanges}
            className="mt-2 inline-flex items-center rounded-md border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-border-default dark:bg-surface-raised dark:text-gray-300 dark:hover:bg-border-subtle"
          >
            Request changes
          </button>
        </div>
      )}
    </section>
  );
}
