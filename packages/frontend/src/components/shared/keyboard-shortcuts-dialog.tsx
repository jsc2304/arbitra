'use client';

import { useEffect, useRef } from 'react';
import { useEscapeKey } from '../../hooks/use-escape-key';

interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

interface Shortcut {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  label: string;
  shortcuts: Shortcut[];
}

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/.test(navigator.platform);

// Only list shortcuts the app actually implements. Do not document aspirational
// bindings. Grep anchors:
//   - Cmd+K palette:        packages/frontend/src/components/layout/header-bar.tsx
//   - Esc to close:         packages/frontend/src/hooks/use-escape-key.ts +
//                           packages/frontend/src/providers/launcher-provider.tsx
//   - Arrow keys in list:   packages/frontend/src/components/shared/command-palette.tsx
//   - ? to open this help:  packages/frontend/src/components/layout/header-bar.tsx
const GROUPS: ShortcutGroup[] = [
  {
    label: 'Global',
    shortcuts: [
      { keys: [IS_MAC ? '⌘' : 'Ctrl', 'K'], description: 'Open search' },
      { keys: ['?'], description: 'Show keyboard shortcuts' },
      { keys: ['Esc'], description: 'Close overlay or dialog' },
    ],
  },
  {
    label: 'Search / list navigation',
    shortcuts: [
      { keys: ['↑', '↓'], description: 'Move selection up or down' },
      { keys: ['Enter'], description: 'Open the selected item' },
    ],
  },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border border-gray-200 dark:border-gray-600 bg-surface-base dark:bg-gray-800 px-1.5 py-0.5 text-[11px] font-mono leading-none text-gray-700 dark:text-gray-200 shadow-sm">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  useEscapeKey(onClose, open);

  // Focus trap: when the dialog opens, move focus to the close button and
  // restore it on close. Prevents keyboard users from tabbing back behind the
  // backdrop into the underlying page.
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-dialog-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-lg bg-surface-raised shadow-xl border border-gray-200 dark:border-border-subtle">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-border-subtle">
          <h2 id="shortcuts-dialog-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="rounded-md p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-surface-base dark:hover:bg-border-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-4 space-y-5 max-h-[70vh] overflow-y-auto">
          {GROUPS.map((group) => (
            <section key={group.label}>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                {group.label}
              </h3>
              <ul className="space-y-1.5">
                {group.shortcuts.map((s) => (
                  <li key={s.description} className="flex items-center justify-between gap-4">
                    <span className="text-sm text-gray-700 dark:text-gray-300">{s.description}</span>
                    <span className="flex items-center gap-1">
                      {s.keys.map((k, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && <span className="text-[11px] text-gray-400">+</span>}
                          <Kbd>{k}</Kbd>
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="px-6 py-3 border-t border-gray-200 dark:border-border-subtle text-[11px] text-gray-500 dark:text-gray-400">
          Press <Kbd>Esc</Kbd> to close this dialog.
        </div>
      </div>
    </div>
  );
}

export default KeyboardShortcutsDialog;
