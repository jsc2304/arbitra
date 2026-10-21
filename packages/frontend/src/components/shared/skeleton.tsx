'use client';

/**
 * Shared skeleton primitives for loading states.
 *
 * All wrappers set `role="status"` + `aria-busy="true"` and include a
 * visually-hidden "Loading…" label for screen readers. Visuals use
 * `animate-pulse` on neutral `bg-gray-200 dark:bg-gray-700` blocks so the
 * pulse cadence matches existing loading placeholders in the app.
 */

interface SkeletonTextProps {
  /** Number of lines to render. Default 3. */
  lines?: number;
  className?: string;
}

export function SkeletonText({ lines = 3, className = '' }: SkeletonTextProps) {
  const count = Math.max(1, lines);
  return (
    <div
      role="status"
      aria-busy="true"
      className={`animate-pulse space-y-2 ${className}`}
    >
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className={`h-3 rounded bg-gray-200 dark:bg-gray-700 ${
            idx === count - 1 ? 'w-2/3' : 'w-full'
          }`}
        />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

interface SkeletonCardProps {
  className?: string;
}

/**
 * Card-shaped placeholder. Matches the default card shell used by
 * `components/board/case-card.tsx` (rounded-lg, border, surface-raised,
 * p-3 padding).
 */
export function SkeletonCard({ className = '' }: SkeletonCardProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={`animate-pulse rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-raised p-3 shadow-sm ${className}`}
    >
      <div className="mb-2 h-4 w-3/4 rounded bg-gray-200 dark:bg-gray-700" />
      <div className="mb-2 flex gap-1.5">
        <div className="h-4 w-16 rounded bg-gray-200 dark:bg-gray-700" />
        <div className="h-4 w-12 rounded bg-gray-200 dark:bg-gray-700" />
        <div className="h-4 w-14 rounded bg-gray-200 dark:bg-gray-700" />
      </div>
      <div className="flex items-center justify-between">
        <div className="h-3 w-1/3 rounded bg-gray-200 dark:bg-gray-700" />
        <div className="h-3 w-1/4 rounded bg-gray-200 dark:bg-gray-700" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

interface SkeletonRowProps {
  /** Number of pseudo-columns to render. Default 4. */
  columns?: number;
  className?: string;
}

/**
 * Horizontal row placeholder for list/table-style views.
 */
export function SkeletonRow({ columns = 4, className = '' }: SkeletonRowProps) {
  const count = Math.max(1, columns);
  return (
    <div
      role="status"
      aria-busy="true"
      className={`animate-pulse flex items-center gap-3 py-2 ${className}`}
    >
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className={`h-3 rounded bg-gray-200 dark:bg-gray-700 ${
            idx === 0 ? 'flex-[2]' : 'flex-1'
          }`}
        />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
