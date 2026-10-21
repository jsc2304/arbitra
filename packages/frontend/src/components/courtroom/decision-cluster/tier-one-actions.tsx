'use client';

/**
 * Tier-1 (primary) action row of the courtroom DecisionCluster.
 *
 * Renders the dominant row of the two primary decisions: Approve
 * (corp-orange `bg-accent`) + a neutral secondary (Request Changes for the
 * case-level flow, "Mark as resolved" + "Flag as blocking" relabel for
 * finding-level). Stacks vertically on narrow viewports, 50/50 on `md+`.
 *
 * Audit-critical behavior:
 *   - When `approveBlockedByFindings` is true, the Approve button is
 *     disabled (aria-disabled, click no-op) and a disabled-reason chip +
 *     tooltip is rendered below.
 *   - The labels come from `getDecisionOptions(...)` so the finding-level
 *     relabel ("Mark as resolved" / "Flag as blocking") is preserved
 *     without duplicating the table.
 */

import type { CaseStatus, DecisionType } from '@arbitra/shared';
import type { BlockerCounts } from '../../../lib/finding-selectors';
import { getDecisionOptions, type DecisionOption } from '../decision-options';

export interface TierOneActionsProps {
  caseStatus: CaseStatus | undefined;
  hasFinding: boolean;
  selectedType: DecisionType | null;
  approveBlockedByFindings: boolean;
  blockerCounts: BlockerCounts;
  onSelect: (type: DecisionType) => void;
}

/**
 * Returns up to 2 Tier-1 options for the given (caseStatus × hasFinding)
 * tuple. Always picks `approve` + `request_changes` from the canonical
 * option list so the labels (and tooltips) stay aligned with the legacy
 * form. Other actions fall through to Tier-2.
 */
export function getTierOneOptions(
  caseStatus: CaseStatus | undefined,
  hasFinding: boolean,
): DecisionOption[] {
  const all = getDecisionOptions(caseStatus, hasFinding);
  return all.filter(
    (o) => o.value === 'approve' || o.value === 'request_changes',
  );
}

export function TierOneActions({
  caseStatus,
  hasFinding,
  selectedType,
  approveBlockedByFindings,
  blockerCounts,
  onSelect,
}: TierOneActionsProps) {
  const options = getTierOneOptions(caseStatus, hasFinding);
  if (options.length === 0) return null;

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {options.map((option) => {
          const isApprove = option.value === 'approve';
          const isApproveBlocked = isApprove && approveBlockedByFindings;
          const isSelected = selectedType === option.value;

          const tooltip = isApproveBlocked
            ? `Cannot approve: ${blockerCounts.total} open finding(s) with blocking severity (${blockerCounts.critical} critical, ${blockerCounts.high} high). Fix or waive them in the blocking-findings list above.`
            : option.tooltip;

          // Variant: Approve = corp-orange `bg-accent`; secondary = neutral.
          // When selected we add a ring; when unselected we keep the variant
          // base color so the cluster stays visually dominant over Tier-2.
          // When Approve is blocked by findings we drop the accent entirely
          // and render a neutral disabled style — keeping the orange would
          // make the button read as active-but-dimmed instead of disabled.
          const neutralClasses =
            'bg-surface-base dark:bg-surface-raised text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-border-subtle border-gray-300 dark:border-border-default';
          const baseClasses = isApprove
            ? isApproveBlocked
              ? 'bg-gray-100 dark:bg-border-subtle text-gray-500 dark:text-gray-500 border-gray-200 dark:border-border-default'
              : 'bg-accent-700 text-white hover:bg-accent-700/90 border-accent'
            : neutralClasses;

          const selectedRing = isSelected
            ? ' ring-2 ring-offset-1 ring-accent'
            : '';

          const disabledClasses = isApproveBlocked
            ? ' opacity-60 cursor-not-allowed'
            : '';

          return (
            <div key={option.value} className="space-y-1">
              <button
                type="button"
                title={tooltip}
                aria-disabled={isApproveBlocked}
                data-testid={`tier-one-${option.value}`}
                onClick={() => {
                  if (!isApproveBlocked) onSelect(option.value);
                }}
                className={`w-full rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${baseClasses}${selectedRing}${disabledClasses}`}
              >
                {option.label}
              </button>
              {option.description && (
                <p
                  className="text-[11px] text-gray-500 dark:text-gray-400 px-0.5"
                  data-testid={`tier-one-${option.value}-caption`}
                >
                  {option.description}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {approveBlockedByFindings && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <svg
            className="h-4 w-4 flex-shrink-0 mt-0.5"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
          <span>
            Approve is disabled: <strong>{blockerCounts.total}</strong> open blocking finding
            {blockerCounts.total === 1 ? '' : 's'}
            {' '}({blockerCounts.critical} critical, {blockerCounts.high} high). Waive or resolve
            them in the list above before approving.
          </span>
        </div>
      )}
    </div>
  );
}
