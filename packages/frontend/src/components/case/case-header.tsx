'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  isBlockingFindingStatus,
  type Case,
  type CaseEvent,
  type CaseStatus,
  type Finding,
} from '@arbitra/shared';
import { TrackBadge } from '../shared/track-badge';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/api-client';
import { useToast } from '../../providers/toast-provider';
import { useUserMap } from '../../hooks/use-users';
import { useProjectMap } from '../../hooks/use-projects';
import { useRepositoryMap } from '../../hooks/use-repositories';
import { useIsAdmin } from '../../hooks/use-is-admin';
import { UserDisplay } from '../shared/user-display';
import { CaseDeleteDialog } from './case-delete-dialog';
import { CaseHeaderOverflowMenu } from './case-header-overflow-menu';
import { ExportDropdown } from './case-header-export-dropdown';
import { CollapsibleDescription } from './case-header-description';
import { GateBanner } from './case-header-gate-banner';
import { EditCaseModal } from './case-header-edit-modal';
import { RelativeTime } from '../shared/relative-time';
import { isOlderThanOneYear } from '../../lib/relative-time';
import { Tooltip } from '../shared/tooltip';

/**
 * Host of `CLERK_REPOSITORY_URL`, the no-source placeholder repository a Clerk
 * core provisions (backend `clerk-core-documents.ts`). Matched as a host here
 * rather than imported, because that constant lives in the server package and
 * this is a client component. A real repository can never carry it: the domain
 * is reserved and unresolvable by design.
 */
const PLACEHOLDER_REPOSITORY_HOST = 'clerk-placeholder.invalid';

interface CaseHeaderProps {
  caseData: Case;
  events?: CaseEvent[];
  findings?: Finding[];
  /**
   * Counts used by the type-to-confirm delete dialog to disclose what gets
   * destroyed. Optional — when absent the dialog falls back to whatever can
   * be derived from `findings` / `events` so the header still renders during
   * the brief window before the count fetches resolve.
   */
  relatedCounts?: {
    evidence: number;
    decisions: number;
    comments: number;
    related: number;
  };
  onTransition: () => void;
}

/**
 * Cases in these statuses are not deletable from the UI.
 *
 * The edge case "linked to a merged PR" — in this
 * codebase the post-merge state is `done` (the terminal status reached via
 * `pending_merge → done`; there is no separate `merged` status — see
 * `packages/shared/src/types/case.ts`). We block both `done` AND
 * `pending_merge`, which is intentionally *broader*: it also
 * prevents deletion while a merge is mid-flight, when removing the case
 * would orphan a landed (or about-to-land) PR and break the audit trail.
 * `rejected` is intentionally *not* blocked — rejected cases never produced
 * an external artifact, so deleting them is safe.
 *
 * This is a UX safety guard (the trash icon is visibly inert with an
 * explanatory tooltip rather than a surprising failure-on-submit); the
 * backend may impose its own server-side rules independently.
 */
const NON_DELETABLE_STATUSES: CaseStatus[] = ['done', 'pending_merge'];

function nonDeletableReason(status: CaseStatus): string | null {
  if (status === 'done') return 'Completed cases cannot be deleted (audit trail).';
  if (status === 'pending_merge') return 'Cannot delete while a merge is in flight.';
  return null;
}

const CASE_TYPE_LABELS: Record<string, string> = {
  ticket_implementation: 'Ticket Implementation',
  bugfix: 'Bug Fix',
  refactoring: 'Refactoring',
  pr_review: 'PR Review',
  manual_verification: 'Manual Verification',
  security_review: 'Security Review',
  assistant_task: 'Clerk Task', // Intentionally omitted from the edit selector; engineering cases must not be converted.
  other: 'Other',
};

const EDITABLE_PHASES: CaseStatus[] = ['open', 'exploration', 'ready_for_build'];

function externalUrl(value: string, repoId?: string): string | null {
  if (!value) return null;
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  // Branch name with repo context → GitHub tree URL
  if (repoId && !repoId.startsWith('repo_') && repoId.includes('/')) {
    return `https://github.com/${repoId}/tree/${value}`;
  }
  // org/repo format → GitHub repo URL
  if (value.includes('/') && !value.startsWith('repo_')) return `https://github.com/${value}`;
  return null;
}

const externalLinkIcon = (
  <svg
    className="h-3.5 w-3.5 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
    fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
  </svg>
);

function ExternalLink({ value, label, repoId }: { value: string; label?: string; repoId?: string }) {
  const url = externalUrl(value, repoId);
  if (!url) return <span>{label ?? value}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex items-center gap-1 hover:text-accent-hover transition-colors"
      title={`Open in new tab`}
    >
      {label ?? value}
      {externalLinkIcon}
    </a>
  );
}

const pencilIcon = (
  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
  </svg>
);

function CopyIdButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: ignore if clipboard API is not available
    }
  }

  return (
    <Tooltip label={copied ? 'Copied!' : 'Copy case ID'}>
    <button
      type="button"
      onClick={handleCopy}
      aria-label="Copy case ID"
      className="text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 transition-colors flex-shrink-0"
    >
      {copied ? (
        <svg className="h-3.5 w-3.5 text-green-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9.75a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
        </svg>
      )}
    </button>
    </Tooltip>
  );
}

/** Statuses where a pipeline error banner is relevant (non-terminal, potentially stuck). */
const STUCK_STATUSES: CaseStatus[] = [
  'in_review', 'in_validation', 'in_build', 'needs_human_decision', 'verification_pending', 'exploration',
];

/** Terminal statuses — never show pipeline errors for these. */
const TERMINAL_STATUSES: CaseStatus[] = ['done', 'rejected'];

/**
 * Created/Updated timestamp row. Created is always the canonical absolute
 * date; Updated is its relative companion (`Nm ago` / `MMM D` / …).
 *
 * Once `updatedAt` crosses the 365-day threshold the relative companion flips
 * to a full `MMM D, YYYY` date — which duplicates the absolute Created form and
 * makes "Created … · Updated …" read redundantly (issue #553). At that point we
 * collapse the pair into a single unified absolute range (`Created … → …`)
 * instead. Extracted so the >365d branching is unit-testable without the full
 * header dependency tree.
 */
export function CaseTimestamps({
  createdAt,
  updatedAt,
}: {
  createdAt: string;
  updatedAt: string;
}) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-gray-500 dark:text-gray-500">
      {isOlderThanOneYear(updatedAt) ? (
        <span className="inline-flex items-center gap-x-1">
          <span aria-hidden="true">Created</span>
          <RelativeTime timestamp={createdAt} mode="absolute" />
          <span aria-hidden="true">→</span>
          <RelativeTime timestamp={updatedAt} mode="absolute" />
        </span>
      ) : (
        <>
          <RelativeTime timestamp={createdAt} mode="absolute" prefix="Created" />
          <span aria-hidden="true">·</span>
          <RelativeTime timestamp={updatedAt} prefix="Updated" />
        </>
      )}
    </div>
  );
}

export function CaseHeader({ caseData, events, findings, relatedCounts, onTransition }: CaseHeaderProps) {
  const router = useRouter();
  const { isAdmin } = useIsAdmin();
  const { addToast } = useToast();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Core fields edit modal
  const [editingCore, setEditingCore] = useState(false);
  const [markingMerged, setMarkingMerged] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [syncingMerge, setSyncingMerge] = useState(false);

  const userIds = useMemo(() => {
    const ids = [caseData.owner_user_id];
    if (caseData.assigned_reviewer_id) ids.push(caseData.assigned_reviewer_id);
    return ids;
  }, [caseData.owner_user_id, caseData.assigned_reviewer_id]);
  const users = useUserMap(userIds);
  const projectMap = useProjectMap();
  const repoMap = useRepositoryMap();
  const repoInfo = repoMap[caseData.repository_id];
  // An unresolved repository counts as real, so no row that renders today stops
  // rendering: only a repository we have read and recognised is suppressed.
  const isPlaceholderRepository = (repoInfo?.url ?? '').includes(PLACEHOLDER_REPOSITORY_HOST);

  const isEditable = EDITABLE_PHASES.includes(caseData.status);
  const courtroomStatuses = ['in_review', 'needs_human_decision', 'verification_pending', 'pending_merge', 'in_validation'];
  const isCourtroomRelevant = courtroomStatuses.includes(caseData.status);

  // Extract the most recent pipeline system comment that occurred after the last status transition.
  // This surfaces errors like "Auto-review could not start" so users understand why a phase isn't progressing.
  const pipelineError = useMemo(() => {
    if (!events?.length || TERMINAL_STATUSES.includes(caseData.status) || !STUCK_STATUSES.includes(caseData.status)) {
      return null;
    }
    // Find the timestamp of the most recent status-changing event (any event that isn't a comment/finding/evidence)
    const statusChangeTypes = new Set([
      'case_created', 'exploration_requested', 'exploration_completed', 'case_ready_for_build',
      'build_started', 'validation_requested', 'validation_started', 'review_requested',
      'review_started', 'human_decision_requested', 'case_approved', 'merge_ready',
      'pr_merged', 'case_completed', 'case_rejected', 'changes_requested',
    ]);
    // Events are typically newest-first from the API
    const sortedEvents = [...events].sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const lastTransition = sortedEvents.find((e) => statusChangeTypes.has(e.type));
    const lastTransitionTime = lastTransition ? new Date(lastTransition.created_at).getTime() : 0;

    // Find the most recent pipeline system comment after the last transition
    const pipelineComment = sortedEvents.find(
      (e) =>
        e.type === 'comment_added' &&
        e.actor_id === 'system:pipeline' &&
        e.payload?.comment_type === 'system' &&
        new Date(e.created_at).getTime() >= lastTransitionTime
    );
    return (pipelineComment?.payload?.body as string) ?? null;
  }, [events, caseData.status]);

  // Compute next-step guidance for the human
  const nextStepGuidance = useMemo(() => {
    const status = caseData.status;
    if (!findings?.length) return null;

    const unresolvedHighCritical = findings.filter(
      (f) =>
        (f.severity === 'high' || f.severity === 'critical') &&
        isBlockingFindingStatus(f.status),
    );

    if (status === 'needs_human_decision' && unresolvedHighCritical.length > 0) {
      const count = unresolvedHighCritical.length;
      return `${count} high/critical finding${count > 1 ? 's' : ''} need${count === 1 ? 's' : ''} to be reviewed (approve, waive, or fix) before this case can advance.`;
    }

    if (status === 'in_review' && findings.length > 0 && findings.every((f) => !isBlockingFindingStatus(f.status))) {
      return 'All findings have been resolved. Waiting for the review run to complete.';
    }

    if (status === 'pending_merge') {
      return 'Case approved. Merge the pull request to complete this case.';
    }

    return null;
  }, [caseData.status, findings]);

  const isMergeReady = caseData.status === 'approved' || caseData.status === 'pending_merge';
  const prUrl = caseData.current_pr_ref ? externalUrl(caseData.current_pr_ref) : null;

  // Auto-check GitHub for PR merge status when case is pending_merge
  useEffect(() => {
    if (!isMergeReady || !caseData.current_pr_ref) return;
    let cancelled = false;
    setSyncingMerge(true);
    api.cases.syncMerge(caseData.case_id)
      .then((result) => {
        if (!cancelled && result.merged) {
          onTransition();
        }
      })
      .catch(() => {
        // Silent failure — manual button remains as fallback
      })
      .finally(() => {
        if (!cancelled) setSyncingMerge(false);
      });
    return () => { cancelled = true; };
  }, [caseData.case_id, caseData.current_pr_ref, isMergeReady]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleMarkMerged() {
    setMarkingMerged(true);
    try {
      await api.cases.emitEvent(caseData.case_id, 'pr_merged', {
        source: 'manual',
        pr_url: caseData.current_pr_ref ?? '',
      });
      setConfirmMerge(false);
      onTransition();
    } catch {
      // Silent failure — manual merge confirmation stays dismissable.
    } finally {
      setMarkingMerged(false);
    }
  }

  // Case header shows the absolute creation date
  // ("Created May 6, 2026") alongside the relative update time
  // ("Updated 5 minutes ago"). Both surfaces have a hover tooltip with the
  // full ISO-style datetime + timezone via <RelativeTime>.

  // Edge case: some statuses are not deletable. Render the
  // trash as visibly inert with an explanatory tooltip rather than letting
  // the click flow fail on submit.
  const deletableReason = nonDeletableReason(caseData.status);
  const isDeletable = !NON_DELETABLE_STATUSES.includes(caseData.status);

  const deleteCounts = {
    findings: findings?.length ?? 0,
    evidence: relatedCounts?.evidence ?? 0,
    decisions: relatedCounts?.decisions ?? 0,
    comments: relatedCounts?.comments ?? 0,
    related: relatedCounts?.related ?? 0,
  };

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.cases.delete(caseData.case_id);
      router.push('/board');
    } catch {
      setDeleting(false);
      setShowDeleteConfirm(false);
      addToast('error', 'Failed to delete case');
    }
  }

  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-3 md:p-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4">
        {/* Title lives in its own <h1> above the cockpit-hero card; this card renders status, not the heading. */}
        <div className="flex items-center gap-1 min-w-0">
          {/* Case-id rendered as a subtle reference chip. Previously used
              font-mono which made the ID read as load-bearing technical
              data; that reads as too aggressive for a management surface where the
              title is the primary handle. */}
          <span className="text-xs text-gray-400 dark:text-gray-500 tracking-tight truncate">
            {caseData.case_id}
          </span>
          <CopyIdButton value={caseData.case_id} />
          {isEditable && (
            <Tooltip label="Edit case details">
              <button
                onClick={() => setEditingCore(true)}
                aria-label="Edit case details"
                className="ml-1 text-gray-300 dark:text-gray-600 hover:text-accent-700 dark:hover:text-accent-300 transition-colors flex-shrink-0"
              >
                {pencilIcon}
              </button>
            </Tooltip>
          )}
          {isAdmin && (
            <>
              {/* Visual separator between safe (copy/edit) and destructive
                  (delete) icon groups. 12px left margin + 8px-tall divider +
                  12px right margin together create the >=20px gap so the trash no longer reads as part of the
                  copy button group. Hidden on <640px since the trash itself
                  moves into the overflow menu at that breakpoint (Tailwind's
                  `sm`, 640px, is the codebase convention — see PR #552). */}
              <span
                aria-hidden="true"
                className="hidden sm:inline-block mx-3 h-4 w-px bg-gray-200 dark:bg-border-subtle flex-shrink-0"
              />
              <Tooltip label={isDeletable ? 'Delete case (admin)' : (deletableReason ?? 'Delete case (admin)')}>
                <button
                  type="button"
                  // Use `aria-disabled` rather than the native `disabled`
                  // attribute so the button stays focusable and continues to
                  // emit pointer/focus events. The Tooltip primitive places
                  // its listeners on a wrapper span (which papers over the
                  // browser quirk where native-disabled buttons swallow
                  // pointer events), but keeping the button event-eligible
                  // also lets the explanatory tooltip surface on direct
                  // focus, and lets us no-op the click at the handler level
                  // without depending on the wrapper. (PR #552 review I3.)
                  onClick={(e) => {
                    if (!isDeletable) {
                      e.preventDefault();
                      return;
                    }
                    setShowDeleteConfirm(true);
                  }}
                  aria-label="Delete case"
                  aria-disabled={!isDeletable}
                  // Trash icon carries the destructive token at rest (red-500)
                  // so it visually announces its consequence even before
                  // hover; on hover it deepens to a red background. Disabled
                  // state collapses to neutral gray so the icon does not
                  // misleadingly invite a click.
                  className={
                    'hidden sm:inline-flex items-center justify-center rounded-md p-1 transition-colors flex-shrink-0 ' +
                    (isDeletable
                      ? 'text-red-500 dark:text-red-400 hover:bg-red-100 hover:text-red-700 dark:hover:bg-red-950 dark:hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500'
                      : 'text-gray-300 dark:text-gray-600 cursor-not-allowed')
                  }
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                  </svg>
                </button>
              </Tooltip>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0 flex-wrap">
          <Tooltip label="Open the chronological audit-trail dossier (print-friendly)">
          <a
            href={`/cases/${caseData.case_id}/dossier`}
            aria-label="View Dossier"
            className="inline-flex items-center gap-1.5 rounded-md bg-surface-raised px-3 py-1.5 text-xs sm:text-sm font-medium text-gray-700 dark:text-gray-300 ring-1 ring-border-default hover:bg-surface-base dark:hover:bg-surface-overlay transition-colors"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4 flex-shrink-0"
            >
              <path
                fillRule="evenodd"
                d="M4.5 2A1.5 1.5 0 0 0 3 3.5v13A1.5 1.5 0 0 0 4.5 18h11a1.5 1.5 0 0 0 1.5-1.5V7.621a1.5 1.5 0 0 0-.44-1.06l-4.12-4.122A1.5 1.5 0 0 0 11.378 2H4.5Zm2 6.5A.75.75 0 0 1 7.25 7.75h5.5a.75.75 0 0 1 0 1.5h-5.5A.75.75 0 0 1 6.5 8.5Zm.75 2.75a.75.75 0 0 0 0 1.5h5.5a.75.75 0 0 0 0-1.5h-5.5Zm0 3a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Z"
                clipRule="evenodd"
              />
            </svg>
            <span className="sm:hidden">Dossier</span>
            <span className="hidden sm:inline">View Dossier</span>
          </a>
          </Tooltip>
          {/* Courtroom is meaningless pre-escalation: an Observed Case has no
              findings to judge and no gate to confirm — the surface only
              means anything once the case escalates into the enforced
              lifecycle (issue #1018 / ADR-0001). */}
          {caseData.case_type !== 'observed' && (
            isCourtroomRelevant && !isMergeReady ? (
              <Tooltip label="Enter the courtroom to review findings and decide">
                <a
                  href={`/cases/${caseData.case_id}/courtroom`}
                  aria-label="Enter Courtroom"
                  className="inline-flex items-center rounded-md bg-accent-700 px-3 py-1.5 text-xs sm:text-sm font-medium text-white shadow-sm hover:bg-accent-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 dark:focus-visible:ring-offset-surface-base transition-colors"
                >
                  <span className="sm:hidden">Court</span>
                  <span className="hidden sm:inline">Enter Courtroom</span>
                </a>
              </Tooltip>
            ) : (
              <Tooltip label="Case is not in review — Courtroom is read-only">
                <a
                  href={`/cases/${caseData.case_id}/courtroom`}
                  aria-label="Courtroom (read-only — case is not in review)"
                  className="inline-flex items-center rounded-md bg-gray-100 dark:bg-gray-800 px-3 py-1.5 text-xs sm:text-sm font-medium text-gray-400 dark:text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-400 transition-colors"
                >
                  <span className="sm:hidden">Court</span>
                  <span className="hidden sm:inline">Courtroom</span>
                </a>
              </Tooltip>
            )
          )}

          {isMergeReady && prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md bg-surface-raised px-3 py-1.5 text-xs sm:text-sm font-medium text-gray-700 dark:text-gray-300 ring-1 ring-border-default hover:bg-surface-base dark:hover:bg-surface-overlay transition-colors"
            >
              <span className="sm:hidden">PR</span>
              <span className="hidden sm:inline">Open PR</span>
              {externalLinkIcon}
            </a>
          )}

          {isMergeReady && syncingMerge && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-gray-100 dark:bg-gray-800 px-3 py-1.5 text-xs sm:text-sm font-medium text-gray-500 dark:text-gray-400">
              Checking PR status&hellip;
            </span>
          )}

          {isMergeReady && !syncingMerge && (
            confirmMerge ? (
              <span className="inline-flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleMarkMerged}
                  disabled={markingMerged}
                  className="inline-flex items-center rounded-md bg-green-100 dark:bg-green-900/30 px-3 py-1.5 text-xs sm:text-sm font-medium text-green-800 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors ring-1 ring-green-200 dark:ring-green-800 disabled:opacity-50"
                >
                  {markingMerged ? 'Completing...' : 'Confirm'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmMerge(false)}
                  className="inline-flex items-center rounded-md bg-gray-100 dark:bg-gray-800 px-3 py-1.5 text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmMerge(true)}
                className="inline-flex items-center rounded-md bg-accent-700 px-3 py-1.5 text-xs sm:text-sm font-medium text-white shadow-sm hover:bg-accent-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 dark:focus-visible:ring-offset-surface-base transition-colors"
              >
                <span className="sm:hidden">Merged</span>
                <span className="hidden sm:inline">Mark as Merged</span>
              </button>
            )
          )}

          <ExportDropdown caseId={caseData.case_id} />

          {/* Mobile-only overflow menu carrying the admin Delete action.
              On viewports <640px (Tailwind `sm` breakpoint, matching the
              codebase convention) the inline trash icon
              is hidden and the same action is reachable
              here. Rendered only for admins, and only when there's
              something inside the menu. */}
          {isAdmin && (
            <CaseHeaderOverflowMenu
              isDeletable={isDeletable}
              nonDeletableReason={deletableReason}
              onDelete={() => setShowDeleteConfirm(true)}
            />
          )}

        </div>
      </div>

      {/* Compact metadata row — inline label:value pairs + secondary badges.
          Single wrap-row replaces the earlier dedicated chip row + 4-column grid
          (saved ~64px vertical). Created/Updated are rendered as a dim second
          line (timestamps are low-priority, pushed below primary metadata). */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span title="Validation track: 'direct' means the target system is programmatically testable; 'manual' means manual verification is required (e.g., remote desktop environments).">
          <TrackBadge track={caseData.validation_track} />
        </span>
        {caseData.case_type && (
          <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-400">
            {CASE_TYPE_LABELS[caseData.case_type] ?? caseData.case_type.replace(/_/g, ' ')}
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <span className="text-gray-500 dark:text-gray-400">Owner:</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">
            <UserDisplay userId={caseData.owner_user_id} users={users} showAvatar />
          </span>
        </span>
        <span className="inline-flex items-baseline gap-1">
          <span className="text-gray-500 dark:text-gray-400">Project:</span>
          <span
            className="font-medium text-gray-900 dark:text-gray-100 truncate max-w-[16ch]"
            title={projectMap[caseData.project_id] ?? caseData.project_id}
          >
            {projectMap[caseData.project_id] ?? caseData.project_id}
          </span>
        </span>
        {/* A Clerk core provisions a placeholder repository so its cases can carry
            a `repository_id` at all, and the row would only ever read
            `clerk-no-source-repository…`. Suppressed when the resolved repository
            IS that placeholder — not when the case type is `assistant_task`,
            because the type does not imply the placeholder: an assistant task
            created through the API in an engineering project has a real
            repository and should still link it. */}
        {!isPlaceholderRepository && (
          <span className="inline-flex items-baseline gap-1 min-w-0">
            <span className="text-gray-500 dark:text-gray-400">Repo:</span>
            <span className="font-medium text-gray-900 dark:text-gray-100 truncate max-w-[20ch]">
              <ExternalLink value={repoInfo?.url || caseData.repository_id} label={repoInfo?.name || caseData.repository_id} />
            </span>
          </span>
        )}
        {caseData.current_branch ? (
          <span className="inline-flex items-baseline gap-1 min-w-0">
            <span className="text-gray-500 dark:text-gray-400">Branch:</span>
            <span className="font-mono text-xs font-medium text-gray-900 dark:text-gray-100 truncate max-w-[20ch]">
              <ExternalLink value={caseData.current_branch} repoId={repoInfo?.url?.replace('https://github.com/', '') || caseData.repository_id} />
            </span>
          </span>
        ) : null}
        {caseData.assigned_reviewer_id && (
          <span className="inline-flex items-baseline gap-1">
            <span className="text-gray-500 dark:text-gray-400">Reviewer:</span>
            <span className="font-medium text-gray-900 dark:text-gray-100">
              <UserDisplay userId={caseData.assigned_reviewer_id!} users={users} showAvatar />
            </span>
          </span>
        )}
        {caseData.jira_refs && caseData.jira_refs.length > 0 && (
          <span className="inline-flex items-center gap-1">
            {caseData.jira_refs.map((ref) => (
              <span
                key={ref}
                className="inline-flex items-center rounded bg-blue-50 dark:bg-blue-950/50 px-1.5 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-400 ring-1 ring-inset ring-blue-200 dark:ring-blue-800"
              >
                {ref}
              </span>
            ))}
          </span>
        )}
      </div>

      {/* Timestamps — least load-bearing, dim & small. */}
      <CaseTimestamps
        createdAt={caseData.created_at}
        updatedAt={caseData.updated_at}
      />

      {/* Pending Gate Banner */}
      <GateBanner caseData={caseData} onTransition={onTransition} />

      {/* Pipeline Error Banner — shown when case is stuck due to a pipeline error */}
      {pipelineError && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <svg className="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          <span>{pipelineError}</span>
        </div>
      )}

      {/* Next Step Guidance — shown when the case needs human action */}
      {nextStepGuidance && !pipelineError && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/50 px-3 py-2 text-sm text-blue-700 dark:text-blue-400">
          <svg className="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
          </svg>
          <span>{nextStepGuidance}</span>
        </div>
      )}

      {caseData.description && (
        <CollapsibleDescription description={caseData.description} />
      )}

      {/* Edit Case Modal */}
      <EditCaseModal
        caseData={caseData}
        open={editingCore}
        onClose={() => setEditingCore(false)}
        onSaved={onTransition}
      />

      {/* Admin Delete Confirmation — type-to-confirm gate.
          The dialog itself is only mounted when shown so the input ref and
          autofocus effect run cleanly on each open. */}
      <CaseDeleteDialog
        open={showDeleteConfirm}
        caseId={caseData.case_id}
        caseTitle={caseData.title}
        counts={deleteCounts}
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
