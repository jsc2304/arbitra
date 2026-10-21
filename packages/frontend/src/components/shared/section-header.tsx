/**
 * @file SectionHeader primitive — shared in-page section title.
 *
 * Variants:
 * - `title` (default) — sentence-case bold heading (`text-lg font-semibold`)
 *   + muted description + right-aligned actions slot. Used for case-detail
 *   Findings/Evidence/Decisions and dashboard cards.
 * - `eyebrow` — the small uppercase tracking-wide label used by Settings
 *   panels and Project detail (`text-sm font-semibold uppercase tracking-wide`,
 *   muted gray-700). Pass `eyebrow` to opt into this treatment.
 *
 * The optional inline `count` pill renders a rounded badge next to the
 * title (matching the dashboard "My Cases" / knowledge-list count chips),
 * so call-sites stop hand-rolling `({count})` parentheticals.
 */
import type { ReactNode } from 'react';

export type SectionHeaderLevel = 2 | 3;

export interface SectionHeaderProps {
  title: string;
  description?: string;
  /** Right-aligned slot, typically buttons. */
  actions?: ReactNode;
  className?: string;
  /** Heading tag level. Defaults to `2` (`<h2>`). */
  level?: SectionHeaderLevel;
  /**
   * Optional `id` forwarded to the heading element. Lets call-sites pair
   * `<section aria-labelledby={id}>` with the heading rendered here —
   * the existing pattern in observatory/intelligence, case-cockpit-hero,
   * and blocker-strip.
   */
  id?: string;
  /**
   * Render the title as a small uppercase "eyebrow" label instead of the
   * default bold heading. Matches the Settings/Project-detail section style.
   */
  eyebrow?: boolean;
  /**
   * Optional count rendered as an inline pill next to the title. `0` is
   * still rendered (call-sites that want to hide a zero count should omit
   * the prop). The pill adapts to the variant: a neutral rounded badge for
   * the title variant, a lighter parenthetical-weight badge for eyebrow.
   */
  count?: number;
}

// Visual tokens for the `title` variant.
const TITLE_CLASSES = 'text-lg font-semibold text-gray-900 dark:text-gray-100';
// Eyebrow variant — matches Settings/Project-detail section labels.
const EYEBROW_CLASSES =
  'text-sm font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300';
const DESCRIPTION_CLASSES = 'mt-1 text-sm text-gray-500 dark:text-gray-400';
const COUNT_PILL_CLASSES =
  'inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-500 dark:text-gray-400';

export default function SectionHeader({
  title,
  description,
  actions,
  className,
  level = 2,
  id,
  eyebrow = false,
  count,
}: SectionHeaderProps) {
  const Heading = (level === 3 ? 'h3' : 'h2') as 'h2';
  const wrapperClasses = ['flex items-start justify-between gap-4', className]
    .filter(Boolean)
    .join(' ');
  const headingClasses = eyebrow ? EYEBROW_CLASSES : TITLE_CLASSES;
  const hasCount = count !== undefined;

  return (
    <div className={wrapperClasses}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Heading id={id} className={headingClasses}>{title}</Heading>
          {hasCount && <span className={COUNT_PILL_CLASSES}>{count}</span>}
        </div>
        {description && <p className={DESCRIPTION_CLASSES}>{description}</p>}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
