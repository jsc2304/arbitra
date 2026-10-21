'use client';

/**
 * "Record" disclosure — the collapsed home for an assistant case's
 * governance artifacts (lifecycle tracker, evidence, event timeline, run and
 * decision context).
 *
 * Follows the same toggle-button chrome already used on this page:
 * `AssistantMethodDetails`'s "How this answer was produced" trigger in
 * assistant-answer-panel.tsx and the `AccordionItem` header in proof-tab.tsx
 * (chevron rotate, `aria-expanded`/`aria-controls`, hover background). No new
 * collapsible primitive is introduced — `components/ui` has none to reuse
 * (checked before writing this).
 *
 * Collapsed by default and unmounts its children while collapsed (same
 * choice as `AccordionItem`), so none of the panels inside — several of
 * which carry their own SWR fetch — do any work until a reader actually
 * asks for the record.
 */

import { useState } from 'react';

export function CaseRecordDisclosure({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="case-record-panel"
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-surface-base/50 dark:hover:bg-border-subtle/30 transition-colors"
      >
        <span className="inline-flex items-center gap-2">
          <svg
            className={`h-3.5 w-3.5 text-gray-400 dark:text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Record</span>
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Case details, lifecycle, evidence, and activity
        </span>
      </button>
      {open && (
        <div
          id="case-record-panel"
          role="region"
          aria-label="Case record"
          className="border-t border-gray-200 dark:border-border-subtle px-4 py-4 space-y-3"
        >
          {children}
        </div>
      )}
    </div>
  );
}

export default CaseRecordDisclosure;
