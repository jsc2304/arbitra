'use client';

/**
 * @file ReviewNotApplicableAction — human escape hatch for a case stuck in
 * `in_review` after a permanent server-side review-run failure (e.g. a
 * provider billing error). Files a `review_not_applicable` decision
 * (`POST /api/cases/:caseId/decisions`), which sets `Case.review_not_applicable`
 * with a documented rationale + role check on the backend
 * (`DecisionService.createReviewNotApplicableDecision`).
 *
 * Follows the same local-dialog convention as `CaseDeleteDialog` (no
 * shadcn/ui `Dialog` primitive exists in this codebase) — a self-contained
 * backdrop + panel, Esc-to-cancel, disabled until the rationale gate opens.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { Run } from '@arbitra/shared';
import { useEscapeKey } from '../../hooks/use-escape-key';
import { api } from '../../lib/api-client';
import { Button } from '../ui/button';

const MIN_RATIONALE_LENGTH = 10;

/**
 * Pure eligibility gate — unit-testable without a DOM. Mirrors the spec:
 * show the affordance only when the case is `in_review`, is not already
 * flagged, and the review-run history is either the last-known-failed
 * state or entirely empty (no run has ever been attempted).
 */
export function isReviewNotApplicableEligible(
  caseStatus: string,
  reviewNotApplicable: boolean | undefined,
  runs: Pick<Run, 'run_type' | 'status' | 'created_at'>[],
): boolean {
  if (caseStatus !== 'in_review') return false;
  if (reviewNotApplicable) return false;

  if (runs.length === 0) return true;

  const reviewRuns = runs.filter((r) => r.run_type === 'review_run');
  if (reviewRuns.length === 0) return false;

  const latest = [...reviewRuns].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )[0];
  return latest?.status === 'failed';
}

/** Pure gate for the dialog's submit button — exported for direct testing. */
export function isReviewNotApplicableRationaleValid(rationale: string): boolean {
  return rationale.trim().length >= MIN_RATIONALE_LENGTH;
}

interface ReviewNotApplicableDialogProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  onConfirm: (rationale: string) => void;
  onCancel: () => void;
}

function ReviewNotApplicableDialog({
  open,
  loading,
  error,
  onConfirm,
  onCancel,
}: ReviewNotApplicableDialogProps) {
  const [rationale, setRationale] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();

  useEffect(() => {
    if (!open) setRationale('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => cancelRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEscapeKey(() => {
    if (!loading) onCancel();
  }, open);

  if (!open) return null;

  const canConfirm = isReviewNotApplicableRationaleValid(rationale) && !loading;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !loading) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${inputId}-title`}
        className="mx-4 w-full max-w-md rounded-lg bg-surface-raised shadow-xl"
      >
        <div className="p-6">
          <h3
            id={`${inputId}-title`}
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            Mark review not applicable
          </h3>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            This bypasses the AI review requirement and lets the case advance
            based on its other approval preconditions. Use this only when the
            review run has failed permanently and no retry can succeed (e.g. a
            provider billing error) — it is an operational unblock, not an
            approval.
          </p>
          <div className="mt-4">
            <label
              htmlFor={inputId}
              className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Rationale{' '}
              <span className="text-gray-400 dark:text-gray-500">
                (min {MIN_RATIONALE_LENGTH} characters)
              </span>
            </label>
            <textarea
              id={inputId}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              rows={4}
              disabled={loading}
              placeholder="Explain why the review run cannot complete..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent dark:bg-input-bg dark:border-border-default dark:text-gray-200 dark:placeholder-gray-500 dark:ring-accent dark:focus:border-accent"
            />
            <div className="mt-1 text-right text-[10px] text-gray-400 dark:text-gray-500">
              {rationale.trim().length} / {MIN_RATIONALE_LENGTH} min
            </div>
          </div>
          {error && (
            <div className="mt-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/50 px-3 py-2 text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          )}
        </div>
        <div className="border-t border-gray-200 dark:border-border-subtle px-6 py-4 flex justify-end gap-3">
          <Button
            ref={cancelRef}
            variant="ghost"
            onClick={onCancel}
            disabled={loading}
            className="text-gray-600 dark:text-gray-400 hover:bg-transparent dark:hover:bg-transparent hover:text-gray-800 dark:hover:text-gray-200"
          >
            Cancel
          </Button>
          <Button
            variant="warning"
            onClick={() => canConfirm && onConfirm(rationale.trim())}
            aria-disabled={!canConfirm}
            disabled={loading}
          >
            {loading ? 'Submitting…' : 'Mark not applicable'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface ReviewNotApplicableActionProps {
  caseId: string;
  caseStatus: string;
  reviewNotApplicable: boolean | undefined;
  runs: Pick<Run, 'run_type' | 'status' | 'created_at'>[];
  /** Called after a successful submission so the caller can refresh case data. */
  onSuccess: () => void;
}

export function ReviewNotApplicableAction({
  caseId,
  caseStatus,
  reviewNotApplicable,
  runs,
  onSuccess,
}: ReviewNotApplicableActionProps) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isReviewNotApplicableEligible(caseStatus, reviewNotApplicable, runs)) {
    return null;
  }

  async function handleConfirm(rationale: string) {
    setSubmitting(true);
    setError(null);
    try {
      await api.cases.submitDecision(caseId, {
        case_id: caseId,
        type: 'review_not_applicable',
        rationale,
      });
      setOpen(false);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button variant="warning" size="sm" onClick={() => setOpen(true)}>
        Mark review not applicable
      </Button>
      <ReviewNotApplicableDialog
        open={open}
        loading={submitting}
        error={error}
        onConfirm={handleConfirm}
        onCancel={() => {
          if (!submitting) setOpen(false);
        }}
      />
    </>
  );
}
