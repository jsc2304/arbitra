'use client';

/**
 * Rationale + linked-finding sub-form composed into the `DecisionCluster`
 * container. Contract is intentionally narrow:
 *
 *   - Owns local input state: rationale text, linked-finding id, the
 *     destructive-confirm dialog gate, and the submitting/error UX.
 *   - Receives the selected decision type + finding context from the parent;
 *     it does NOT render the decision-type selector grid (which sits above
 *     it in the DOM and is owned by the parent).
 *   - Delegates the actual API call + post-success orchestration (toast,
 *     KnowledgeCapturePrompt) to a parent-supplied `onExecute` callback. On
 *     success the parent returns `{ ok: true }` and this form resets its
 *     inputs. On failure the parent returns `{ ok: false, message }` and the
 *     form surfaces the inline error.
 *
 * ZERO visual / behavior diff vs. the pre-extraction inlined form: same DOM
 * shape, same classNames, same destructive-confirm copy, same 10-char min
 * gate, same auto-warning when waive lacks a linked finding.
 */

import { forwardRef, useImperativeHandle, useState } from 'react';
import type { DecisionType } from '@arbitra/shared';
import { ConfirmDialog } from '../shared/confirm-dialog';

const DESTRUCTIVE_DECISIONS: DecisionType[] = ['reject', 'request_changes'];

export interface RationaleFormSubmit {
  type: DecisionType;
  rationale: string;
  finding_id: string | undefined;
}

export type RationaleFormResult =
  | { ok: true }
  | { ok: false; message: string };

export interface RationaleFormProps {
  /** Currently selected decision type from the parent's selector grid. */
  selectedType: DecisionType | null;
  /** Sticky finding id passed by the parent (selection from the left list). */
  findingId?: string;
  /**
   * Controlled linked-finding id. Lifted to the parent so the selector grid
   * can react to free-text edits (changing case-level → finding-level
   * options) without round-tripping through a callback.
   */
  linkedFindingId: string;
  onLinkedFindingIdChange: (next: string) => void;
  /**
   * True when the parent's gate (e.g. open blocking findings on approve)
   * disables submission. The form trusts this flag and disables the submit
   * button accordingly — it does NOT recompute the gate.
   */
  approveBlockedByFindings: boolean;
  /**
   * Whether the currently selected decision type would, on submit, fire a
   * destructive-decision confirmation modal. Defaulted from
   * `DESTRUCTIVE_DECISIONS`; exposed as a prop so the tiered layout can
   * route differently if needed.
   */
  destructiveDecisions?: readonly DecisionType[];
  /**
   * The async submit callback. Returns `{ ok: true }` on success (form
   * resets) or `{ ok: false, message }` on failure (error surfaces inline +
   * via the parent's toast).
   */
  onExecute: (input: RationaleFormSubmit) => Promise<RationaleFormResult>;
}

/**
 * Imperative handle exposed to the parent so the outer `<form>` element's
 * `onSubmit` can route the event into this child component without lifting
 * state. Keeps the existing form-submit-on-Enter behavior intact.
 */
export interface RationaleFormHandle {
  submit: (e: React.FormEvent) => Promise<void> | void;
}

export const RationaleForm = forwardRef<RationaleFormHandle, RationaleFormProps>(function RationaleForm(
  {
    selectedType,
    findingId,
    linkedFindingId,
    onLinkedFindingIdChange,
    approveBlockedByFindings,
    destructiveDecisions = DESTRUCTIVE_DECISIONS,
    onExecute,
  },
  ref,
) {
  const [rationale, setRationale] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<DecisionType | null>(null);

  const isValid =
    selectedType !== null &&
    rationale.trim().length >= 10 &&
    !(selectedType === 'approve' && approveBlockedByFindings);

  async function execute() {
    if (!isValid || !selectedType) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onExecute({
        type: selectedType,
        rationale: rationale.trim(),
        finding_id: linkedFindingId || undefined,
      });
      if (result.ok) {
        setRationale('');
        onLinkedFindingIdChange('');
      } else {
        setError(result.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || !selectedType) return;
    if (destructiveDecisions.includes(selectedType)) {
      setPendingConfirm(selectedType);
      return;
    }
    await execute();
  }

  useImperativeHandle(ref, () => ({ submit: handleSubmit }), [
    handleSubmit,
  ]);

  return (
    <>
      {/* Rationale */}
      <div>
        <label
          htmlFor="rationale"
          className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Rationale{' '}
          <span className="text-gray-400 dark:text-gray-500">(min 10 characters)</span>
        </label>
        <textarea
          id="rationale"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          rows={4}
          placeholder="Explain the reasoning behind this decision..."
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent dark:bg-input-bg dark:border-border-default dark:text-gray-200 dark:placeholder-gray-500 dark:ring-accent dark:focus:border-accent"
        />
        <div className="mt-1 text-right text-[10px] text-gray-400 dark:text-gray-500">
          {rationale.trim().length} / 10 min
        </div>
      </div>

      {/* Linked finding ID — auto-filled from selected finding */}
      <div>
        <label
          htmlFor="linked-finding"
          className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Linked Finding{' '}
          <span className="text-gray-400 dark:text-gray-500">
            {findingId ? '(from selection)' : '(optional)'}
          </span>
        </label>
        {findingId ? (
          <div className="flex items-center gap-2 rounded-lg border border-secondary-200 dark:border-secondary-800 bg-secondary-50 dark:bg-secondary-950/50 px-3 py-2">
            <svg
              className="h-4 w-4 text-accent flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"
              />
            </svg>
            <span className="text-sm font-mono text-secondary-700 dark:text-secondary-400">
              {findingId}
            </span>
          </div>
        ) : (
          <input
            id="linked-finding"
            type="text"
            value={linkedFindingId}
            onChange={(e) => onLinkedFindingIdChange(e.target.value)}
            placeholder="Select a finding on the left, or enter ID"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent dark:bg-input-bg dark:border-border-default dark:text-gray-200 dark:placeholder-gray-500 dark:ring-accent dark:focus:border-accent"
          />
        )}
        {selectedType === 'waive' && !findingId && !linkedFindingId && (
          <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
            Waive applies to a specific finding — select one from the left panel.
          </p>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/50 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Submit — `type="submit"` so Enter inside the textarea still
          triggers the parent <form>'s onSubmit handler, which routes the
          event back into this component via the exposed imperative handle. */}
      <button
        type="submit"
        disabled={!isValid || submitting}
        className="w-full rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-2.5 text-sm font-medium text-white dark:text-gray-900 transition-colors hover:bg-gray-800 dark:hover:bg-gray-200 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:text-gray-500 dark:disabled:text-gray-500"
      >
        {submitting ? 'Submitting...' : 'Submit Decision'}
      </button>

      {/* Confirmation dialog for destructive decisions */}
      <ConfirmDialog
        open={pendingConfirm === 'reject'}
        title="Reject Case"
        message="Are you sure you want to reject this case? This action cannot be undone."
        confirmLabel="Reject"
        variant="danger"
        loading={submitting}
        onConfirm={async () => {
          setPendingConfirm(null);
          await execute();
        }}
        onCancel={() => setPendingConfirm(null)}
      />
      <ConfirmDialog
        open={pendingConfirm === 'request_changes'}
        title={linkedFindingId ? 'Flag finding as blocking' : 'Request Changes'}
        message={
          linkedFindingId
            ? 'Mark this finding as requiring a fix before the case can progress? This does not transition the case.'
            : 'Send this case back to the developer for rework?'
        }
        confirmLabel={linkedFindingId ? 'Flag as blocking' : 'Request Changes'}
        variant="warning"
        loading={submitting}
        onConfirm={async () => {
          setPendingConfirm(null);
          await execute();
        }}
        onCancel={() => setPendingConfirm(null)}
      />
    </>
  );
});
