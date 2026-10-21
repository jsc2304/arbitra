'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from 'react';
import { useEscapeKey } from '../../hooks/use-escape-key';

type ModalWidth = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible dialog title. Rendered in the header and wired to `aria-labelledby`. */
  title?: string;
  /** Secondary line under the title (e.g. version hint). */
  description?: ReactNode;
  children: ReactNode;
  /** Footer slot — typically the action buttons. Rendered in a bordered footer. */
  footer?: ReactNode;
  width?: ModalWidth;
  /**
   * Disable backdrop-click and Escape close (e.g. while a save is in flight).
   * The close (×) button is still rendered but its handler is also guarded.
   */
  closeDisabled?: boolean;
}

// Centered-modal max widths. Mirrors the bespoke modals these replace
// (EditRolesModal used `max-w-sm`, EditPromptModal `max-w-2xl`).
const widthClasses: Record<ModalWidth, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
};

// Standard native focusable-element selector, minus `tabindex="-1"`. Matches
// the selector used by `<SideDrawer>` so both primitives trap focus the same way.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Reusable centered modal primitive. Unlike `<SideDrawer>` (a context-preserving
 * right rail), this dims the page and centers a card — the right shape for
 * focused forms and confirmations where the surrounding context should recede.
 *
 * A11y guarantees: labelled `role="dialog"` + `aria-modal`, Escape-to-close,
 * backdrop-click-to-close, focus moved into the dialog on open and restored to
 * the previously focused element on close, and a cheap Tab focus trap. Animation
 * is a pure Tailwind transition — no extra animation lib.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'sm',
  closeDisabled = false,
}: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const handleClose = useCallback(() => {
    if (!closeDisabled) onClose();
  }, [onClose, closeDisabled]);
  useEscapeKey(handleClose, open);

  // Focus management: on open, remember the active element and move focus into
  // the panel. On close, restore focus where it came from. Both are best-effort
  // — elements can vanish between open and close (re-renders, route changes).
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
        // Nothing tabbable inside — focus the panel so Escape still works.
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

  // Cheap focus trap: on Tab, wrap focus around so it stays inside the panel.
  // Matches the rigor of `<SideDrawer>` (not a full a11y-grade trap).
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
      data-testid="modal-backdrop"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`relative mx-4 flex max-h-[90vh] w-full ${widthClasses[width]} flex-col rounded-lg bg-surface-raised shadow-xl outline-none`}
      >
        {title && (
          <div className="flex items-start justify-between gap-3 border-b border-gray-200 dark:border-border-subtle px-6 py-4">
            <div className="min-w-0">
              <h2
                id={titleId}
                className="text-lg font-semibold text-gray-900 dark:text-gray-100"
              >
                {title}
              </h2>
              {description && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close dialog"
              className="rounded p-1 text-gray-400 hover:bg-surface-base hover:text-gray-600 dark:text-gray-500 dark:hover:bg-border-subtle/40 dark:hover:text-gray-300"
            >
              <svg
                className="h-5 w-5"
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
        <div className="flex-1 overflow-y-auto px-6 py-6">{children}</div>
        {footer && (
          <div className="flex justify-end gap-3 border-t border-gray-200 dark:border-border-subtle px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
