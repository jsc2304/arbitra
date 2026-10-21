'use client';

/**
 * @file CaseHeaderOverflowMenu — mobile-only kebab carrying admin actions
 * that would otherwise live as inline icon buttons.
 *
 * On viewports <640 px the destructive trash icon must move
 * out of the inline ID row (where a "copy ID" mis-tap is most likely) and
 * into a deliberate overflow menu next to View Dossier / Export. Copy stays
 * inline because it's frequent and non-destructive.
 *
 * The component renders nothing on >=sm because the inline trash button
 * already covers the desktop case; this avoids two simultaneous entry points
 * to the same destructive action.
 */

import { useEffect, useRef, useState } from 'react';
import { Tooltip } from '../shared/tooltip';

interface CaseHeaderOverflowMenuProps {
  isDeletable: boolean;
  nonDeletableReason: string | null;
  onDelete: () => void;
}

export function CaseHeaderOverflowMenu({
  isDeletable,
  nonDeletableReason,
  onDelete,
}: CaseHeaderOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open]);

  return (
    <div className="relative sm:hidden" ref={ref}>
      <Tooltip label="More actions">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={open}
          className="inline-flex items-center justify-center rounded-md p-1.5 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
          </svg>
        </button>
      </Tooltip>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 w-48 rounded-md bg-surface-raised shadow-lg ring-1 ring-black/5 dark:ring-white/10 z-20 py-1"
        >
          <button
            type="button"
            role="menuitem"
            disabled={!isDeletable}
            onClick={() => {
              if (!isDeletable) return;
              setOpen(false);
              onDelete();
            }}
            title={!isDeletable ? (nonDeletableReason ?? undefined) : undefined}
            className={
              'w-full text-left px-3 py-2 text-sm transition-colors ' +
              (isDeletable
                ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40'
                : 'text-gray-400 dark:text-gray-600 cursor-not-allowed')
            }
          >
            Delete case (admin)
            {!isDeletable && nonDeletableReason && (
              <span className="block text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                {nonDeletableReason}
              </span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
