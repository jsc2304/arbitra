'use client';

/**
 * @file CaseDeleteDialog — type-to-confirm destructive dialog for case deletion.
 *
 * Load-bearing change: a routine "copy ID"
 * mis-click on the trash icon used to silently destroy a case. This dialog
 * gates the irreversible delete behind:
 *   - explicit confirmation copy that lists what gets destroyed (with real counts),
 *   - a type-to-confirm field where the user must reproduce the case ID exactly,
 *   - Cancel as the default focus,
 *   - Esc / outside-pointerdown closes (equivalent to Cancel),
 *   - a focus trap so Tab cycles Cancel → input → Delete inside the modal.
 *
 * The component is intentionally local to the case feature folder rather than a
 * generic primitive — its UX (type-to-confirm gating, fixed structure) is too
 * specific to belong in `shared/`. The neutral `ConfirmDialog` primitive
 * remains for non-load-bearing confirmations elsewhere.
 *
 * Focus-trap note (PR #552 review I1): the destructive button is rendered
 * with `aria-disabled="true"` instead of native `disabled` until the typed
 * value matches. That keeps it focusable, so natural tab order
 * (Cancel → input → Delete) stays inside the dialog even before the gate
 * opens, and we no-op the click/Enter when the gate is closed.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useEscapeKey } from '../../hooks/use-escape-key';

interface RelatedCounts {
  findings: number;
  evidence: number;
  decisions: number;
  comments: number;
  related: number;
}

interface CaseDeleteDialogProps {
  open: boolean;
  caseId: string;
  caseTitle: string;
  counts: RelatedCounts;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const TITLE_TRUNCATE_AT = 60;

function truncate(s: string, at: number): string {
  return s.length > at ? `${s.slice(0, at - 1).trimEnd()}…` : s;
}

function totalRelated(c: RelatedCounts): number {
  return c.findings + c.evidence + c.decisions + c.comments + c.related;
}

/**
 * Pure helper extracted so the gate logic is unit-testable without a DOM.
 * Returns whether the destructive confirm button should be enabled.
 */
export function canConfirmDelete(
  typed: string,
  caseId: string,
  loading: boolean,
): boolean {
  if (loading) return false;
  if (typed.length === 0) return false;
  return typed === caseId;
}

export function CaseDeleteDialog({
  open,
  caseId,
  caseTitle,
  counts,
  loading = false,
  onConfirm,
  onCancel,
}: CaseDeleteDialogProps) {
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();

  // Reset typed value whenever the dialog is closed/reopened so a previous
  // attempt does not pre-arm the destructive button on the next open.
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  // Cancel is the autofocused default per spec — focus it on open. We focus
  // the cancel button on the next animation frame so it lands after the modal
  // mounts and any transition settles.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => cancelRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEscapeKey(() => {
    if (!loading) onCancel();
  }, open);

  if (!open) return null;

  const canConfirm = canConfirmDelete(typed, caseId, loading);
  const total = totalRelated(counts);
  const truncatedTitle = truncate(caseTitle || caseId, TITLE_TRUNCATE_AT);

  // Focus trap: Tab from the destructive button wraps to Cancel; Shift+Tab
  // from Cancel wraps to the destructive button. Because the destructive
  // button uses `aria-disabled` instead of native `disabled`, it stays in
  // the tab order even when the gate is closed, so natural order
  // (Cancel → input → Delete) keeps focus inside the dialog.
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return;
    const target = e.target as HTMLElement;
    if (e.shiftKey && target === cancelRef.current) {
      e.preventDefault();
      confirmRef.current?.focus();
    } else if (!e.shiftKey && target === confirmRef.current) {
      e.preventDefault();
      cancelRef.current?.focus();
    }
  }

  function handleConfirmClick() {
    if (!canConfirm) return;
    onConfirm();
  }

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      // Use pointerdown + currentTarget check so a click that *starts* inside
      // the dialog and releases on the backdrop does not dismiss it.
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !loading) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${inputId}-title`}
        aria-describedby={`${inputId}-body`}
        onKeyDown={handleKeyDown}
        className="mx-4 w-full max-w-md rounded-lg bg-surface-raised shadow-xl"
      >
        <div className="p-6">
          <div className="flex items-start gap-3 mb-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-950">
              <svg
                className="h-5 w-5 text-red-600 dark:text-red-400"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
                />
              </svg>
            </div>
            <h3
              id={`${inputId}-title`}
              className="text-lg font-semibold text-gray-900 dark:text-gray-100"
            >
              Delete case &ldquo;{truncatedTitle}&rdquo;?
            </h3>
          </div>
          <p
            id={`${inputId}-body`}
            className="text-sm text-gray-600 dark:text-gray-400"
          >
            This permanently deletes the case and its {total} related item
            {total === 1 ? '' : 's'} (findings, decisions, evidence,
            comments). This action cannot be undone.
          </p>
          <div className="mt-4">
            <label
              htmlFor={inputId}
              className="block text-xs font-medium text-gray-700 dark:text-gray-300"
            >
              Type{' '}
              <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 py-0.5 font-mono text-xs text-gray-900 dark:text-gray-100">
                {caseId}
              </code>{' '}
              to confirm:
            </label>
            <input
              id={inputId}
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={loading}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-invalid={typed.length > 0 && typed !== caseId}
              className="mt-1 block w-full rounded-md border border-gray-300 dark:border-border-subtle bg-surface-base px-3 py-1.5 font-mono text-sm text-gray-900 dark:text-gray-100 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
            />
          </div>
        </div>
        <div className="border-t border-gray-200 dark:border-border-subtle px-6 py-4 flex justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-md"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={handleConfirmClick}
            // `aria-disabled` (not native `disabled`) so the button keeps
            // its place in the tab order — the focus trap relies on it
            // staying focusable even before the type-to-confirm gate opens.
            // The handler no-ops when `canConfirm` is false.
            aria-disabled={!canConfirm}
            className={
              'rounded-md text-white px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 ' +
              (canConfirm
                ? 'bg-red-600 hover:bg-red-700 cursor-pointer'
                : 'bg-red-600 opacity-50 cursor-not-allowed')
            }
          >
            {loading ? 'Deleting…' : 'Delete case'}
          </button>
        </div>
      </div>
    </div>
  );
}
