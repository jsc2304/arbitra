/**
 * Shared layout primitives for top-level main pages (Activity, Cases,
 * Projects, Knowledge, Dashboard, Observatory, Settings).
 *
 * Goal: a single source of truth for container width, horizontal padding,
 * vertical rhythm, and headline typography so navigating between main pages
 * does not "spring" left/right or jump between font weights.
 *
 * Reference treatment (Activity page):
 *   - container: `max-w-7xl mx-auto px-4 md:px-6 py-8`
 *   - headline: `<h1 class="text-2xl font-extrabold">`
 *   - description: `text-sm text-gray-500 dark:text-gray-400`
 *
 * Pages with intentionally different shells (full-bleed Kanban on /board,
 * print layout on the dossier) opt out by simply not using these
 * primitives — that is documented in their files.
 */
import type { ReactNode } from 'react';

interface PageShellProps {
  children: ReactNode;
  /** Override the default `space-y-6` between header and body. */
  className?: string;
}

/**
 * Top-level page container. Apply once at the root of a main page.
 * Width: `max-w-7xl`. Padding: `px-4 md:px-6 py-8`. Vertical rhythm: `space-y-6`.
 */
export function PageShell({ children, className }: PageShellProps) {
  return (
    <div
      className={`max-w-7xl mx-auto px-4 md:px-6 py-8 space-y-6${
        className ? ` ${className}` : ''
      }`}
    >
      {children}
    </div>
  );
}

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned slot for action buttons / toggles. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Standard page header. Uses the Activity-page bolder headline treatment
 * (`text-2xl font-extrabold`) so all main pages share one weight.
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header
      className={`flex items-start justify-between gap-4${
        className ? ` ${className}` : ''
      }`}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </header>
  );
}
