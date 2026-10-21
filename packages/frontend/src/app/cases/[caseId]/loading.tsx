/**
 * Route-level loading state for `/cases/[caseId]` (UI/UX 3-bets plan 1.3, Q6).
 *
 * Renders a hero-shaped placeholder so the layout doesn't jump once the real
 * Cockpit Hero mounts. Server component — no hooks or client state. The
 * outer wrapper carries a single `role="status"`; inner blocks are plain
 * `animate-pulse` divs to avoid nested status regions.
 */
export default function CaseLoading() {
  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 py-4 md:py-6 space-y-4 md:space-y-6">
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading case"
        className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-4 md:p-5"
      >
        {/* Row 1 — badge row + CTA */}
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 md:gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="h-6 w-20 rounded-full bg-gray-200 dark:bg-gray-700 animate-pulse" />
              <div className="h-5 w-14 rounded-full bg-gray-200 dark:bg-gray-700 animate-pulse" />
              <div className="h-5 w-16 rounded-full bg-gray-200 dark:bg-gray-700 animate-pulse" />
              <div className="h-6 w-24 rounded-md bg-gray-200 dark:bg-gray-700 animate-pulse" />
            </div>
            {/* Row 2 — compact lifecycle strip */}
            <div className="mt-3 flex items-center gap-2">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="h-3 w-3 rounded-full bg-gray-200 dark:bg-gray-700 animate-pulse" />
                  {i < 6 && <div className="h-[2px] w-6 rounded-full bg-gray-200 dark:bg-gray-700 animate-pulse" />}
                </div>
              ))}
            </div>
          </div>
          {/* CTA placeholder */}
          <div className="flex-shrink-0">
            <div className="h-14 w-48 rounded-md bg-gray-200 dark:bg-gray-700 animate-pulse" />
          </div>
        </div>
        <span className="sr-only">Loading case…</span>
      </div>

      {/* Existing header + tabs placeholder — single card-shaped block so the layout is stable. */}
      <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-4 md:p-6 animate-pulse">
        <div className="h-6 w-2/3 rounded bg-gray-200 dark:bg-gray-700 mb-3" />
        <div className="h-4 w-1/3 rounded bg-gray-200 dark:bg-gray-700 mb-4" />
        <div className="flex gap-2">
          <div className="h-5 w-16 rounded bg-gray-200 dark:bg-gray-700" />
          <div className="h-5 w-16 rounded bg-gray-200 dark:bg-gray-700" />
          <div className="h-5 w-16 rounded bg-gray-200 dark:bg-gray-700" />
        </div>
      </div>
    </div>
  );
}
