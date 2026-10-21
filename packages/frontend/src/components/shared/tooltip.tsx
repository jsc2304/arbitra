/**
 * @file Tooltip — visible on-hover/focus tooltip primitive for icon-only buttons.
 *
 * Behaviour:
 *   - Open delay 300 ms; close delay 100 ms (stable, non-noisy).
 *   - Visible on `mouseenter` and on `focus-visible` (keyboard tab); closes on
 *     `mouseleave`, `blur`, `Escape`, or scroll.
 *   - Suppressed on touch — pointer-event style "touch" tap will not surface a
 *     sticky tooltip. Touch users still get the underlying click action.
 *   - Viewport-constrained: side flips when the tooltip would clip the
 *     right/bottom edge; horizontally clamps to a 4-px viewport gutter.
 *   - Renders the bubble in a portal at the document body so it's not clipped
 *     by ancestor `overflow:hidden` containers.
 *   - Tooltip text is decorative — the primitive does NOT add aria-describedby
 *     because the trigger is expected to already carry an `aria-label`. This
 *     prevents screen-reader double-announce.
 *
 * Usage:
 *   <Tooltip label="Lifecycle view">
 *     <button aria-label="Lifecycle view" ...>{icon}</button>
 *   </Tooltip>
 *
 * Disabled buttons: still works because hover/focus events fire on the wrapper
 * span; pass the explanatory text as `label` (e.g. "Case is not in review —
 * Courtroom is read-only").
 */

'use client';

import {
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect as useLayoutEffectRaw,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  /** The text to render inside the tooltip bubble. If empty/undefined, the tooltip is disabled. */
  label: ReactNode;
  /** Preferred placement. The tooltip will flip to the opposite side if the preferred side clips. Default: 'bottom'. */
  side?: TooltipSide;
  /** Distance in px between the trigger and the tooltip bubble. Default: 6. */
  offset?: number;
  /** Time before the tooltip appears on hover/focus, in ms. Default: 300. */
  openDelay?: number;
  /** Time before the tooltip disappears once hover/focus leaves, in ms. Default: 100. */
  closeDelay?: number;
  /** The trigger element. Must be a single React element that accepts a ref + event handlers. */
  children: ReactElement;
}

// SSR-safe useLayoutEffect: silently downgrades to useEffect on the server so
// renderToStaticMarkup / Next.js SSR doesn't log a misleading warning. The
// effect itself only reads layout from the DOM, which is client-only anyway.
const useLayoutEffect = typeof window !== 'undefined' ? useLayoutEffectRaw : useEffect;

const VIEWPORT_GUTTER = 4;

/** Default open delay in ms before the tooltip appears on hover/focus. */
export const DEFAULT_OPEN_DELAY = 300;
/** Default close delay in ms before the tooltip disappears once hover/focus leaves. */
export const DEFAULT_CLOSE_DELAY = 100;

/**
 * Pure decision helpers extracted so the tooltip's open/close/dismiss branch
 * logic is unit-testable without a DOM (the frontend test suite is node-only —
 * no jsdom). Each mirrors a single guard inside the component's event handlers;
 * the DOM plumbing (portal, listeners, `:focus-visible` resolution) stays in the
 * component and is covered by the structural smoke tests + manual QA.
 */

/** Touch taps must never sticky-show the tooltip — the close path keys off this. */
export function isTouchPointer(pointerType: string | undefined): boolean {
  return pointerType === 'touch';
}

/** Pointer-enter opens only for non-touch pointers (mouse/pen). */
export function shouldOpenOnPointerEnter(pointerType: string | undefined): boolean {
  return !isTouchPointer(pointerType);
}

/**
 * Focus opens the tooltip only when the focus is keyboard-originated
 * (`:focus-visible`), never when it follows a mouse/touch click.
 */
export function shouldOpenOnFocus(isFocusVisible: boolean): boolean {
  return isFocusVisible;
}

/** Escape is the only key that dismisses an open tooltip. */
export function isDismissKey(key: string): boolean {
  return key === 'Escape';
}

/** An empty / whitespace-only / missing label disables the tooltip entirely. */
export function isLabelEmpty(label: ReactNode): boolean {
  return label === null || label === undefined || (typeof label === 'string' && label.trim() === '');
}

interface Position {
  top: number;
  left: number;
  side: TooltipSide;
}

function computePosition(
  triggerRect: DOMRect,
  tooltipRect: { width: number; height: number },
  preferredSide: TooltipSide,
  offset: number,
): Position {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 0;

  // Build candidate positions (preferred first, then opposite)
  const opposite: Record<TooltipSide, TooltipSide> = {
    top: 'bottom',
    bottom: 'top',
    left: 'right',
    right: 'left',
  };
  const sides: TooltipSide[] = [preferredSide, opposite[preferredSide]];

  for (const side of sides) {
    let top = 0;
    let left = 0;
    if (side === 'bottom') {
      top = triggerRect.bottom + offset;
      left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
    } else if (side === 'top') {
      top = triggerRect.top - offset - tooltipRect.height;
      left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
    } else if (side === 'right') {
      top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;
      left = triggerRect.right + offset;
    } else {
      // left
      top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;
      left = triggerRect.left - offset - tooltipRect.width;
    }
    const fitsVertical = top >= VIEWPORT_GUTTER && top + tooltipRect.height <= vh - VIEWPORT_GUTTER;
    const fitsHorizontal = left >= VIEWPORT_GUTTER && left + tooltipRect.width <= vw - VIEWPORT_GUTTER;
    if (fitsVertical && fitsHorizontal) {
      return { top, left, side };
    }
    // For top/bottom we still accept the side if vertical fits (horizontal will be clamped).
    if ((side === 'top' || side === 'bottom') && fitsVertical) {
      const clampedLeft = Math.min(
        Math.max(left, VIEWPORT_GUTTER),
        Math.max(VIEWPORT_GUTTER, vw - tooltipRect.width - VIEWPORT_GUTTER),
      );
      return { top, left: clampedLeft, side };
    }
    if ((side === 'left' || side === 'right') && fitsHorizontal) {
      const clampedTop = Math.min(
        Math.max(top, VIEWPORT_GUTTER),
        Math.max(VIEWPORT_GUTTER, vh - tooltipRect.height - VIEWPORT_GUTTER),
      );
      return { top: clampedTop, left, side };
    }
  }

  // Last resort: pin into the viewport on the preferred side, ignoring overlap.
  const fallbackSide = preferredSide;
  let top = 0;
  let left = 0;
  if (fallbackSide === 'top' || fallbackSide === 'bottom') {
    top = fallbackSide === 'top'
      ? Math.max(VIEWPORT_GUTTER, triggerRect.top - offset - tooltipRect.height)
      : Math.min(vh - tooltipRect.height - VIEWPORT_GUTTER, triggerRect.bottom + offset);
    left = Math.min(
      Math.max(triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2, VIEWPORT_GUTTER),
      Math.max(VIEWPORT_GUTTER, vw - tooltipRect.width - VIEWPORT_GUTTER),
    );
  } else {
    left = fallbackSide === 'left'
      ? Math.max(VIEWPORT_GUTTER, triggerRect.left - offset - tooltipRect.width)
      : Math.min(vw - tooltipRect.width - VIEWPORT_GUTTER, triggerRect.right + offset);
    top = Math.min(
      Math.max(triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2, VIEWPORT_GUTTER),
      Math.max(VIEWPORT_GUTTER, vh - tooltipRect.height - VIEWPORT_GUTTER),
    );
  }
  return { top, left, side: fallbackSide };
}

/**
 * Tooltip wraps a single trigger element. It does NOT replace the trigger's
 * `aria-label` — the trigger should already carry one. The visible bubble is
 * rendered via portal and is purely presentational.
 */
export function Tooltip({
  label,
  side = 'bottom',
  offset = 6,
  openDelay = DEFAULT_OPEN_DELAY,
  closeDelay = DEFAULT_CLOSE_DELAY,
  children,
}: TooltipProps) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointerTypeRef = useRef<string | null>(null);

  useEffect(() => {
    setMounted(true);
    return () => {
      if (openTimerRef.current) clearTimeout(openTimerRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const cancelTimers = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleOpen = useCallback(() => {
    cancelTimers();
    openTimerRef.current = setTimeout(() => setOpen(true), openDelay);
  }, [cancelTimers, openDelay]);

  const scheduleClose = useCallback(() => {
    cancelTimers();
    closeTimerRef.current = setTimeout(() => setOpen(false), closeDelay);
  }, [cancelTimers, closeDelay]);

  // Close on Escape, scroll, resize. Also close immediately if the trigger
  // unmounts/disabled state changes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (isDismissKey(e.key)) {
        cancelTimers();
        setOpen(false);
      }
    };
    const onScrollOrResize = () => {
      cancelTimers();
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, cancelTimers]);

  // Measure once mounted/open so we can place the bubble.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !tooltipRef.current) {
      setPosition(null);
      return;
    }
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipEl = tooltipRef.current;
    const tooltipRect = {
      width: tooltipEl.offsetWidth,
      height: tooltipEl.offsetHeight,
    };
    setPosition(computePosition(triggerRect, tooltipRect, side, offset));
  }, [open, side, offset, label]);

  if (!isValidElement(children)) {
    // Defensive: if a stray fragment/string is passed, render it untouched.
    return <>{children}</>;
  }

  if (isLabelEmpty(label)) {
    return children;
  }

  const onPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    lastPointerTypeRef.current = e.pointerType;
    // Touch tap should never sticky-show the tooltip.
    if (isTouchPointer(e.pointerType)) {
      cancelTimers();
      setOpen(false);
    }
  };
  const onPointerEnter = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (!shouldOpenOnPointerEnter(e.pointerType)) return;
    scheduleOpen();
  };
  const onPointerLeave = () => {
    scheduleClose();
  };
  const onFocus = (e: React.FocusEvent<HTMLSpanElement>) => {
    // Only open on keyboard focus, not on focus that follows a mouse/touch click.
    const target = e.target as HTMLElement;
    // `:focus-visible` matches when focus came from a non-pointer source.
    if (shouldOpenOnFocus(target.matches?.(':focus-visible') ?? false)) {
      cancelTimers();
      setOpen(true);
    }
  };
  const onBlur = () => {
    scheduleClose();
  };

  const bubbleStyle: CSSProperties = position
    ? { position: 'fixed', top: position.top, left: position.left, zIndex: 100 }
    : { position: 'fixed', top: -9999, left: -9999, zIndex: 100, visibility: 'hidden' };

  const bubble = open && mounted
    ? createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          style={bubbleStyle}
          className="pointer-events-none rounded-md bg-gray-900 px-2 py-1 text-xs font-medium text-white shadow-lg ring-1 ring-black/5 dark:bg-gray-100 dark:text-gray-900 dark:ring-white/10 max-w-xs"
        >
          {label}
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <span
        ref={triggerRef}
        // `inline-flex` so the wrapper hugs the trigger and doesn't perturb
        // toolbar layout. The wrapper carries the hover/focus listeners so it
        // also works for disabled buttons (which don't fire pointer events on
        // some browsers when `disabled`).
        className="inline-flex"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {children}
      </span>
      {bubble}
    </>
  );
}

export default Tooltip;
