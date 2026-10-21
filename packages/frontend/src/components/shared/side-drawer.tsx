'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from 'react';
import { useEscapeKey } from '../../hooks/use-escape-key';

type DrawerWidth = 'sm' | 'md' | 'lg';

interface SideDrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  width?: DrawerWidth;
}

// Width maps to a pixel-ish max width on the panel. `lg` stays well under
// typical viewport width so the underlying case list stays partially visible
// (that context is the whole point of a side-rail vs. a centered modal).
const widthClasses: Record<DrawerWidth, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-xl',
};

// Matches the standard native focusable-element selector, minus anything
// inside `[aria-hidden="true"]` subtrees. Kept inline so there's no extra
// shared utility to keep in sync.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Reusable right-side drawer primitive. Slides in from the right, traps focus,
 * closes on Escape or backdrop click, and restores focus to the previously
 * active element on close. Intended for detail panels where the surrounding
 * list/table context should remain visible (unlike a centered modal).
 *
 * Animation is a pure Tailwind transform transition — no extra animation lib.
 */
export function SideDrawer({
  open,
  onClose,
  title,
  children,
  width = 'md',
}: SideDrawerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const handleEscape = useCallback(() => {
    onClose();
  }, [onClose]);
  useEscapeKey(handleEscape, open);

  // Focus management: on open, remember the currently focused element and
  // move focus to the first focusable node inside the panel. On close, put
  // focus back where it came from. Both guards are best-effort — elements
  // can vanish (route changes, re-renders) between open and close.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      typeof document !== 'undefined'
        ? (document.activeElement as HTMLElement | null)
        : null;

    // Defer one tick so the panel is in the DOM before we query it.
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      const first = focusables[0];
      if (first) {
        first.focus();
      } else {
        // Nothing tabbable inside — focus the panel itself so Escape still works.
        panel.focus();
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function') {
        prev.focus();
      }
      previouslyFocusedRef.current = null;
    };
  }, [open]);

  // Cheap focus trap: on Tab, if focus would leave the panel, wrap around.
  // Not a full accessibility-grade trap (doesn't handle shadow DOM or the
  // browser's own focus order quirks) but matches the rigor of the rest of
  // this repo's dialogs.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((el) => !el.hasAttribute('disabled'));
    if (focusables.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="side-drawer-backdrop"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`relative flex h-full w-full ${widthClasses[width]} flex-col bg-surface-raised shadow-xl outline-none transform transition-transform duration-200 ease-out translate-x-0 motion-safe:animate-[slideInFromRight_200ms_ease-out]`}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-gray-200 dark:border-border-subtle px-5 py-4">
            <h3
              id={titleId}
              className="text-base font-semibold text-gray-900 dark:text-gray-100"
            >
              {title}
            </h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close drawer"
              className="rounded p-1 text-gray-500 hover:bg-surface-base hover:text-gray-700 dark:text-gray-400 dark:hover:bg-border-subtle/40 dark:hover:text-gray-200"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
