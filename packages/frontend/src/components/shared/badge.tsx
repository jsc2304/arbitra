'use client';

import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

/**
 * `<Badge>` — the shared badge/chip STRUCTURAL primitive (issue #658).
 *
 * Owns the geometry that every badge in the app must share: radius, size
 * scale, ring-vs-border discipline, and the dot/icon slot. It deliberately
 * does NOT own the semantic COLOURS — those stay in the per-domain token maps
 * (`lib/lifecycle-stages`, `lib/risk-colors`, `lib/badge-colors`, and the
 * inline maps in the thin wrappers) and are passed in via `colorClassName`.
 *
 * Before #658, 9+ badge components drifted on every structural axis:
 *   - radius: all `rounded-full` EXCEPT `SystemActorPill` (bare `rounded`)
 *   - font size: `text-[10px]`, `text-[11px]`, `text-xs`, `text-sm`
 *   - colour application: `ring-1 ring-inset` vs `border` vs nothing
 * This primitive collapses all of that to one spec. The arbitrary
 * `text-[10px]`/`text-[11px]` sizes are gone — everything is on the
 * xs/sm/md scale below.
 *
 * `className` is merged LAST so a call site can still override or extend the
 * computed classes. All native `<span>` props pass through.
 */

export type BadgeSize = 'xs' | 'sm' | 'md';

/**
 * How the passed semantic colour is applied:
 *   - `soft`    — translucent fill + `ring-1 ring-inset` (the standard; we
 *                 standardise on RING, never `border`). The colour classes
 *                 supplied via `colorClassName` provide bg/text/ring-colour.
 *   - `outline` — neutral ring, no fill (low-weight outline pills).
 *   - `solid`   — filled chip; the supplied colour classes provide the fill.
 */
export type BadgeTone = 'soft' | 'outline' | 'solid';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Padding/text scale. Defaults to `'sm'`. */
  size?: BadgeSize;
  /** Colour-application mode. Defaults to `'soft'`. */
  tone?: BadgeTone;
  /**
   * Per-semantic colour classes (bg/text/ring-colour) computed by the wrapper
   * from its token map. Kept separate from `className` so intent is clear and
   * structural overrides via `className` still win (merged last).
   */
  colorClassName?: string;
  /**
   * Live-state indicator dot rendered before the label. Mutually exclusive
   * with `icon` — pass a dot for live/status state, an icon for a category.
   * If both are supplied the dot wins and a dev-mode warning fires.
   */
  dot?: boolean;
  /** Tailwind colour class for the dot (e.g. `bg-corp-green`). */
  dotClassName?: string;
  /** Category icon rendered before the label. Mutually exclusive with `dot`. */
  icon?: ReactNode;
  children?: ReactNode;
}

/** Minimal class-join helper — no `cn`/clsx dependency exists in this package. */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

const baseClasses =
  'inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap';

const sizeClasses: Record<BadgeSize, string> = {
  xs: 'px-2 py-0.5 text-xs',
  sm: 'px-2.5 py-0.5 text-xs',
  md: 'px-3 py-1 text-sm',
};

const toneClasses: Record<BadgeTone, string> = {
  // Standardise on RING (ring-1 ring-inset), never `border`. The colour of the
  // ring comes from `colorClassName` (e.g. `ring-corp-green/40`).
  soft: 'ring-1 ring-inset',
  // Neutral outline for low-weight pills (e.g. ProjectBadge); colour overrides
  // can still arrive via `colorClassName`.
  outline: 'ring-1 ring-inset ring-gray-200 dark:ring-border-subtle',
  // Filled chip — no ring; the fill comes entirely from `colorClassName`.
  solid: '',
};

const dotSizeClasses: Record<BadgeSize, string> = {
  xs: 'h-1.5 w-1.5',
  sm: 'h-1.5 w-1.5',
  md: 'h-2 w-2',
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  {
    size = 'sm',
    tone = 'soft',
    colorClassName,
    dot = false,
    dotClassName,
    icon,
    className,
    children,
    ...rest
  },
  ref,
) {
  if (process.env.NODE_ENV !== 'production' && dot && icon != null) {
    // eslint-disable-next-line no-console
    console.warn(
      '<Badge> received both `dot` and `icon` — they are mutually exclusive ' +
        '(dot = live state, icon = category). Rendering the dot only.',
    );
  }

  return (
    <span
      ref={ref}
      className={cn(
        baseClasses,
        sizeClasses[size],
        toneClasses[tone],
        colorClassName,
        className,
      )}
      {...rest}
    >
      {dot ? (
        <span
          className={cn('rounded-full flex-shrink-0', dotSizeClasses[size], dotClassName)}
          aria-hidden="true"
        />
      ) : (
        icon
      )}
      {children}
    </span>
  );
});
