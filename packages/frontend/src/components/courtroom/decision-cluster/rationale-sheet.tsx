'use client';

/**
 * Inline-revealing rationale surface for the DecisionCluster.
 *
 * The rationale + linked-finding inputs + four-eyes warning + submit +
 * ConfirmDialog all appear inline below the Tier-1/Tier-2 buttons, only
 * when a decision type is selected. Tier buttons stay visible above
 * (dimmed visually) so the user can re-pick a different decision without
 * losing orientation.
 *
 * The rationale logic itself is fully delegated to `RationaleForm`. This
 * file is purely the inline-reveal styling + form-element wiring +
 * four-eyes warning + autofocus on open.
 */

import { useEffect, useRef } from 'react';
import useSWR from 'swr';
import type { DecisionType } from '@arbitra/shared';
import { api } from '@/lib/api-client';
import {
  RationaleForm,
  type RationaleFormHandle,
  type RationaleFormSubmit,
  type RationaleFormResult,
} from '../rationale-form';

export interface RationaleSheetProps {
  open: boolean;
  caseId: string;
  selectedType: DecisionType | null;
  findingId?: string;
  linkedFindingId: string;
  onLinkedFindingIdChange: (next: string) => void;
  approveBlockedByFindings: boolean;
  onExecute: (input: RationaleFormSubmit) => Promise<RationaleFormResult>;
}

export function RationaleSheet({
  open,
  caseId,
  selectedType,
  findingId,
  linkedFindingId,
  onLinkedFindingIdChange,
  approveBlockedByFindings,
  onExecute,
}: RationaleSheetProps) {
  const formRef = useRef<RationaleFormHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resolve the actual policy via SWR — same key as case-cockpit-hero /
  // case-header-gate-banner so the request dedupes. Gating on risk alone
  // misled users whose project sets four_eyes_required: false.
  const { data: requirements, error: requirementsError } = useSWR(
    open && selectedType === 'approve'
      ? ['case-evidence-requirements', caseId]
      : null,
    () => api.cases.evidenceRequirements(caseId),
  );
  // Fail-closed: if the requirements lookup errors, assume four-eyes is
  // required so we never silently drop the warning on transient failures.
  const fourEyesRequired = requirementsError
    ? true
    : requirements?.four_eyes_required ?? false;
  const requirementsLoading =
    requirements === undefined &&
    !requirementsError &&
    open &&
    selectedType === 'approve';

  // Autofocus the rationale textarea on open so the user can start typing
  // immediately after picking a decision type. Scoped to the container so
  // we don't clobber focus elsewhere.
  useEffect(() => {
    if (!open) return;
    const node = containerRef.current?.querySelector<HTMLTextAreaElement>(
      'textarea#rationale',
    );
    node?.focus();
  }, [open, selectedType]);

  if (!open || !selectedType) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void formRef.current?.submit(e);
  }

  return (
    <form
      ref={containerRef as unknown as React.RefObject<HTMLFormElement>}
      onSubmit={handleSubmit}
      className="mt-4 space-y-4 rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-base dark:bg-surface-base/40 p-4"
      data-testid="rationale-sheet"
    >
      {requirementsLoading && (
        <div
          aria-hidden="true"
          className="h-9 w-full rounded-lg bg-surface-muted/40 dark:bg-surface-muted/20 animate-pulse"
          data-testid="rationale-sheet-requirements-loading"
        />
      )}

      {fourEyesRequired && selectedType === 'approve' && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 px-3 py-2.5"
        >
          <svg
            className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5"
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
          <div>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-400">
              Four-eyes principle required
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              Approval requires a second reviewer to confirm the decision.
            </p>
          </div>
        </div>
      )}

      <RationaleForm
        ref={formRef}
        selectedType={selectedType}
        findingId={findingId}
        linkedFindingId={linkedFindingId}
        onLinkedFindingIdChange={onLinkedFindingIdChange}
        approveBlockedByFindings={approveBlockedByFindings}
        onExecute={onExecute}
      />
    </form>
  );
}
