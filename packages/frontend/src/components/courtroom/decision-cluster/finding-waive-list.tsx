'use client';

/**
 * FindingWaiveList — per-finding waive actions inside the Decision panel.
 *
 * Replaces the Waive button that used to live on each `<FindingCard />` in
 * the left findings column. User feedback: every other decision (Approve /
 * Request Changes / Reject) lives in the Decision panel, so the per-finding
 * Waive belonged there too — and nothing explained the difference between
 * waiving a finding and approving the case.
 *
 * Two groups:
 *   - Primary: blocking findings (per `isBlocking()` — author-blocking
 *     origin, high/critical severity, non-resolved status). Rows in status
 *     `open` get a "Waive…" action; `waiver_proposed` (agent-proposed
 *     waivers awaiting human confirmation, backend PR #704) get
 *     "Confirm waiver…" — both route into the same terminal `waive`
 *     decision flow (rationale sheet, audited). `accepted`/`contested`
 *     rows render without an action, matching the previous FindingCard
 *     capability (waive was only offered for `open`).
 *   - Secondary: remaining waivable non-blocking findings (low/medium/info
 *     in `open` or `waiver_proposed`), collapsed behind a disclosure. This
 *     preserves the previous ability to waive any open finding.
 *
 * Row click (not the action button) selects the finding so the center pane
 * shows its detail. Renders nothing when neither group has rows.
 */

import { useState } from 'react';
import type { Finding, FindingStatus } from '@arbitra/shared';
import { isBlocking } from '../../../lib/finding-selectors';
import { SeverityBadge } from '../../shared/severity-badge';
import { Badge } from '../../shared/badge';
import { findingStatusColor } from '../../../lib/badge-colors';

export interface FindingWaiveListProps {
  findings: readonly Finding[];
  /**
   * Starts the terminal `waive` decision flow for the finding (the page
   * selects the finding and opens the rationale sheet pre-set to Waive).
   */
  onWaive: (findingId: string) => void;
  /** Selects the finding so the center pane shows its detail. */
  onSelectFinding: (findingId: string) => void;
}

/**
 * Action label for a finding's waive affordance, or `null` when the row has
 * no per-finding action. `waiver_proposed` routes through the same terminal
 * `waive` decision type — the human confirmation IS the waive decision; the
 * rationale sheet already links the finding.
 *
 * `waived_on_completion` deliberately falls through to `null`: the case is
 * already `done`, so there is nothing left to confirm (issue #751).
 */
export function waiveActionLabel(status: FindingStatus): string | null {
  if (status === 'open') return 'Waive…';
  if (status === 'waiver_proposed') return 'Confirm waiver…';
  return null;
}

/**
 * Splits findings into the two list groups. Pure so the grouping is
 * unit-testable without markup assertions.
 *
 * - `blocking`: everything `isBlocking()` — these hold the approval gate.
 * - `nonBlocking`: findings that do NOT block approval but still carry a
 *   waive affordance (`open` or `waiver_proposed`). Resolved statuses and
 *   actionless non-blocking statuses (accepted/contested) are omitted —
 *   an accepted low finding neither blocks nor offers an action, so a row
 *   would be noise.
 */
export function partitionWaiveRows(findings: readonly Finding[]): {
  blocking: Finding[];
  nonBlocking: Finding[];
} {
  const blocking: Finding[] = [];
  const nonBlocking: Finding[] = [];
  for (const finding of findings) {
    if (isBlocking(finding)) {
      blocking.push(finding);
    } else if (waiveActionLabel(finding.status) !== null) {
      nonBlocking.push(finding);
    }
  }
  return { blocking, nonBlocking };
}

/**
 * Friendly status labels for actionless / awaiting-confirmation rows.
 * `open` deliberately absent — the "Waive…" action already communicates
 * the state, and every row in the primary group is unresolved anyway.
 */
const rowStatusLabels: Partial<Record<FindingStatus, string>> = {
  waiver_proposed: 'Waiver proposed',
  accepted: 'Accepted',
  contested: 'Contested',
};

function WaiveRow({
  finding,
  onWaive,
  onSelectFinding,
}: {
  finding: Finding;
  onWaive: (findingId: string) => void;
  onSelectFinding: (findingId: string) => void;
}) {
  const actionLabel = waiveActionLabel(finding.status);
  const statusLabel = rowStatusLabels[finding.status];

  function handleRowKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectFinding(finding.finding_id);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`waive-row-${finding.finding_id}`}
      onClick={() => onSelectFinding(finding.finding_id)}
      onKeyDown={handleRowKeyDown}
      className="flex items-center gap-2 rounded-md border border-gray-200 dark:border-border-subtle bg-surface-raised px-2.5 py-1.5 cursor-pointer transition-colors hover:border-gray-300 dark:hover:border-gray-600 hover:bg-surface-base dark:hover:bg-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <SeverityBadge severity={finding.severity} />
      <span
        className="min-w-0 flex-1 truncate text-xs font-medium text-gray-800 dark:text-gray-200"
        title={finding.title}
      >
        {finding.title}
      </span>
      {statusLabel && (
        <Badge
          size="xs"
          tone="solid"
          colorClassName={findingStatusColor(finding.status)}
          className="flex-shrink-0"
        >
          {statusLabel}
        </Badge>
      )}
      {actionLabel && (
        <button
          type="button"
          data-testid={`waive-action-${finding.finding_id}`}
          onClick={(e) => {
            e.stopPropagation();
            onWaive(finding.finding_id);
          }}
          title="Waives a single finding with an audited rationale. The case itself still needs a separate Approve decision."
          className="flex-shrink-0 inline-flex items-center rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-2 py-1 text-[11px] font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function FindingWaiveList({
  findings,
  onWaive,
  onSelectFinding,
}: FindingWaiveListProps) {
  const [nonBlockingOpen, setNonBlockingOpen] = useState(false);
  const { blocking, nonBlocking } = partitionWaiveRows(findings);

  if (blocking.length === 0 && nonBlocking.length === 0) return null;

  return (
    <div className="mb-4" data-testid="finding-waive-list">
      {blocking.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-900 dark:text-gray-100">
            Blocking findings
          </h4>
          <p className="mt-1 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
            Waive accepts the risk of a single finding — it requires a
            rationale and is recorded in the audit trail. Approve is the
            case-level decision and unlocks only when every blocking finding
            is fixed or waived.
          </p>
          <div className="mt-2 space-y-1.5">
            {blocking.map((finding) => (
              <WaiveRow
                key={finding.finding_id}
                finding={finding}
                onWaive={onWaive}
                onSelectFinding={onSelectFinding}
              />
            ))}
          </div>
        </div>
      )}

      {nonBlocking.length > 0 && (
        <div className={blocking.length > 0 ? 'mt-3' : ''}>
          <button
            type="button"
            data-testid="finding-waive-list-disclosure"
            aria-expanded={nonBlockingOpen}
            onClick={() => setNonBlockingOpen((open) => !open)}
            className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[11px] font-medium text-gray-500 dark:text-gray-400 transition-colors hover:text-gray-700 dark:hover:text-gray-300"
          >
            <svg
              className={`h-3 w-3 flex-shrink-0 transition-transform ${nonBlockingOpen ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2.5}
              stroke="currentColor"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m9 5 7 7-7 7" />
            </svg>
            {nonBlocking.length} open finding{nonBlocking.length === 1 ? '' : 's'} that{' '}
            {nonBlocking.length === 1 ? 'doesn’t' : 'don’t'} block approval
          </button>
          {nonBlockingOpen && (
            <div className="mt-1.5 space-y-1.5">
              {nonBlocking.map((finding) => (
                <WaiveRow
                  key={finding.finding_id}
                  finding={finding}
                  onWaive={onWaive}
                  onSelectFinding={onSelectFinding}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
