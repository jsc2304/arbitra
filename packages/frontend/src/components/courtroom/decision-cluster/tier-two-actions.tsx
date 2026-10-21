'use client';

/**
 * Tier-2 (secondary) actions of the courtroom DecisionCluster.
 *
 * This layer hosts only Reject (the remaining
 * non-primary case-level action). Waive operates on a finding, not the
 * case, and lives in the in-panel `FindingWaiveList`
 * (`finding-waive-list.tsx`); Escalate is hidden until the backend
 * semantics are defined.
 *
 * Reject still selects through `selectedType` so the inline RationaleSheet
 * + destructive-confirm dialog (`RationaleForm`) keep firing unchanged.
 */

import type { CaseStatus, DecisionType } from '@arbitra/shared';
import { getDecisionOptions, type DecisionOption } from '../decision-options';

export interface TierTwoActionsProps {
  caseStatus: CaseStatus | undefined;
  hasFinding: boolean;
  selectedType: DecisionType | null;
  onSelect: (type: DecisionType) => void;
}

/**
 * Tier-2 = options that are NOT in Tier-1 (approve / request_changes) and
 * not finding-scoped (waive). Today this is
 * effectively just Reject. Kept as a filter so adding future case-level
 * secondary actions stays a one-liner.
 */
export function getTierTwoOptions(
  caseStatus: CaseStatus | undefined,
  hasFinding: boolean,
): DecisionOption[] {
  const all = getDecisionOptions(caseStatus, hasFinding);
  return all.filter((o) => {
    if (o.value === 'approve' || o.value === 'request_changes') return false;
    // Waive is finding-scoped — it's initiated from the per-finding rows
    // in `FindingWaiveList`, not from the case-level action tiers. Hide
    // here regardless of whether a finding is selected, so it doesn't sit
    // at the same visual level as case-level actions.
    if (o.value === 'waive') return false;
    return true;
  });
}

const variantClasses: Record<string, string> = {
  reject:
    'border-red-300 dark:border-red-800 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40',
  waive:
    'border-gray-300 dark:border-border-default text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-border-subtle',
  escalate:
    'border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40',
};

export function TierTwoActions({
  caseStatus,
  hasFinding,
  selectedType,
  onSelect,
}: TierTwoActionsProps) {
  const options = getTierTwoOptions(caseStatus, hasFinding);
  if (options.length === 0) return null;

  // Single-column layout when there is one option (the post-restructure
  // norm — just Reject); fall back to the legacy 2-col grid if a future
  // option re-enters the list.
  const gridCols = options.length === 1 ? 'grid-cols-1' : 'grid-cols-2';

  return (
    <div className={`grid ${gridCols} gap-2 mt-3`}>
      {options.map((option) => {
        const isSelected = selectedType === option.value;
        const variant =
          variantClasses[option.value] ??
          'border-gray-300 dark:border-border-default text-gray-700 dark:text-gray-300';
        return (
          <div key={option.value} className="space-y-1">
            <button
              type="button"
              title={option.tooltip}
              data-testid={`tier-two-${option.value}`}
              onClick={() => onSelect(option.value)}
              className={`w-full rounded-md border bg-transparent px-3 py-2 text-xs font-medium transition-colors ${variant}${
                isSelected ? ' ring-2 ring-offset-1 ring-accent' : ''
              }`}
            >
              {option.label}
            </button>
            {option.description && (
              <p className="text-[11px] text-gray-500 dark:text-gray-400 px-0.5">
                {option.description}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
