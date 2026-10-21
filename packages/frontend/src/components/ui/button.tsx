'use client';

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * `<Button>` — the shared button primitive for the Arbitra frontend (issue #654).
 *
 * Centralises the brand-accent / surface / status colour discipline that was
 * previously hand-rolled at every Save/Cancel/confirm call site. Prefer this
 * over a raw `<button className="...">` for any actionable control so the
 * design tokens (accent, surface, corp-green, focus-ring) stay in one place.
 *
 * All native `<button>` props pass through (`type` defaults to `'button'`,
 * `onClick`, `disabled`, `aria-*`, …). `className` is merged LAST so a call
 * site can still override or extend the computed classes.
 */

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'link'
  | 'danger'
  | 'warning'
  | 'success'
  | 'neutral';

export type ButtonSize = 'xs' | 'sm' | 'md';
export type ButtonShape = 'rounded' | 'circle';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. Defaults to `'primary'`. */
  variant?: ButtonVariant;
  /** Padding/text scale. Ignored by the `link` variant. Defaults to `'md'`. */
  size?: ButtonSize;
  /** Border-radius shape. `circle` is intended for icon-only launchers. */
  shape?: ButtonShape;
  /** Show an inline spinner and disable the button (label is kept). */
  loading?: boolean;
  /**
   * Square-padding icon button. When set you SHOULD pass an `aria-label`
   * (or `aria-labelledby`) so the control has an accessible name — a dev-mode
   * `console.warn` fires otherwise.
   */
  iconOnly?: boolean;
  /** Icon rendered before the label. */
  leftIcon?: ReactNode;
  /** Icon rendered after the label. */
  rightIcon?: ReactNode;
  /** Stretch to the full width of the container. */
  fullWidth?: boolean;
}

/** Minimal class-join helper — no `cn`/clsx dependency exists in this package. */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

const baseClasses =
  'inline-flex items-center justify-center gap-2 font-medium transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ' +
  'dark:focus-visible:ring-offset-surface-base ' +
  'disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed';

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-accent-700 text-white shadow-sm hover:bg-accent-800',
  secondary:
    'border border-border-default bg-surface-raised text-gray-700 dark:text-gray-300 ' +
    'hover:bg-surface-base dark:hover:bg-surface-overlay',
  ghost:
    'text-gray-600 dark:text-gray-300 hover:bg-surface-base dark:hover:bg-surface-overlay ' +
    'hover:text-gray-900 dark:hover:text-gray-100',
  link: 'text-accent-700 dark:text-accent-300 hover:underline shadow-none px-0 py-0',
  danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700 focus-visible:ring-red-500',
  warning: 'bg-amber-500 text-white shadow-sm hover:bg-amber-600',
  success: 'bg-corp-green-dark text-white shadow-sm hover:bg-corp-green',
  // Neutral high-contrast confirm (e.g. ConfirmDialog default). Kept as a real
  // variant so call sites never override `bg-*` via className (the `cn` join is
  // not tailwind-merge, so conflicting utilities would both reach the DOM).
  neutral:
    'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 shadow-sm ' +
    'hover:bg-gray-800 dark:hover:bg-gray-200',
};

const sizeClasses: Record<ButtonSize, string> = {
  xs: 'px-2.5 py-1 text-xs',
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
};

const iconOnlySizeClasses: Record<ButtonSize, string> = {
  xs: 'p-1',
  sm: 'p-1.5',
  md: 'p-2',
};

/** Inline spinner — sized to the current font via `1em` so it scales per size. */
function Spinner() {
  return (
    <svg
      className="animate-spin h-[1em] w-[1em]"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      role="presentation"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    shape = 'rounded',
    loading = false,
    iconOnly = false,
    leftIcon,
    rightIcon,
    fullWidth = false,
    type = 'button',
    disabled,
    className,
    children,
    ...rest
  },
  ref,
) {
  const isLink = variant === 'link';

  // `link` opts out of size padding (it sets its own `px-0 py-0`); every other
  // variant takes the size scale, square-padded when `iconOnly`.
  const sizing = isLink ? '' : iconOnly ? iconOnlySizeClasses[size] : sizeClasses[size];
  const rounding = shape === 'circle' ? 'rounded-full' : 'rounded-md';

  if (
    process.env.NODE_ENV !== 'production' &&
    iconOnly &&
    rest['aria-label'] == null &&
    rest['aria-labelledby'] == null
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      '<Button iconOnly> rendered without an `aria-label`/`aria-labelledby` — ' +
        'icon-only buttons need an accessible name.',
    );
  }

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        baseClasses,
        rounding,
        variantClasses[variant],
        sizing,
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
