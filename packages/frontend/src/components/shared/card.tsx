/**
 * @file Card primitive — shared layout surface.
 *
 * Extended by #656 (card-shell adoption) with `elevation` + `interactive`.
 *
 * Surface language is frozen: `rounded-lg` + `border border-gray-200
 * dark:border-border-subtle` + `bg-surface-raised`. Radius and border tokens
 * are NOT configurable — that's the whole point of the primitive (it kills
 * radius drift between `rounded-lg`/`rounded-xl`/`rounded-2xl`).
 *
 * Padding scale is `none | sm | compact | md | lg` — `md` (= `p-6`) matches
 * the spec's `default` and is the migration-default; `compact`/`sm` (both
 * = `p-4`) match the spec's `compact` token (`sm` is the #656 alias);
 * `lg` (= `p-8`) is an additional rung for large hero/cockpit surfaces.
 *
 * Elevation is `flat` (no shadow) or `raised` (= `shadow-sm`). Default is
 * `flat` to match the original v1 primitive (which had no shadow); shells
 * that carried `shadow-sm` pass `elevation="raised"` to stay pixel-identical.
 *
 * `interactive` adds a hover affordance (`transition-shadow hover:shadow-md`
 * + `hover:-translate-y-0.5`) for clickable cards — this is the variant the
 * observatory/dashboard stat cards needed and is why they bypassed the
 * primitive originally.
 */
import type { HTMLAttributes, ReactNode } from 'react';

export type CardPadding = 'none' | 'sm' | 'compact' | 'md' | 'lg';
export type CardElevation = 'flat' | 'raised';
export type CardElement = 'div' | 'section' | 'article';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode;
  /** Extra classes merged after (and so winning over) the defaults. */
  className?: string;
  /** Padding token. Defaults to `md` (= `p-6`, matches spec `default`). */
  padding?: CardPadding;
  /**
   * Drop shadow. `flat` = none (default, matches the original primitive),
   * `raised` = `shadow-sm`.
   */
  elevation?: CardElevation;
  /**
   * Adds a hover affordance for clickable cards
   * (`transition-shadow hover:shadow-md hover:-translate-y-0.5`).
   */
  interactive?: boolean;
  /** Underlying HTML element. Defaults to `div`. */
  as?: CardElement;
}

const PADDING_CLASS: Record<CardPadding, string> = {
  none: '',
  sm: 'p-4',
  compact: 'p-4',
  md: 'p-6',
  lg: 'p-8',
};

const ELEVATION_CLASS: Record<CardElevation, string> = {
  flat: '',
  raised: 'shadow-sm',
};

// Hover affordance for clickable cards. Kept additive (no `transition-all`)
// so it composes with framer-motion transforms at the call site without
// fighting them.
const INTERACTIVE_CLASS =
  'transition-shadow hover:shadow-md hover:-translate-y-0.5';

// Use the project's `bg-surface-raised` semantic token so dark/light flips
// via the existing CSS variable (defined in tailwind.config.ts). Migrators
// switching from the ad-hoc `bg-white dark:bg-gray-900` string keep the
// same semantic surface across both themes without re-specifying both.
const BASE_CLASSES =
  'rounded-lg border border-gray-200 bg-surface-raised dark:border-border-subtle';

export default function Card({
  children,
  className,
  padding = 'md',
  elevation = 'flat',
  interactive = false,
  as = 'div',
  ...rest
}: CardProps) {
  const Tag = as as 'div';
  const classes = [
    BASE_CLASSES,
    PADDING_CLASS[padding],
    ELEVATION_CLASS[elevation],
    interactive ? INTERACTIVE_CLASS : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  );
}
