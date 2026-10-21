'use client';

/**
 * Floating "N new since you scrolled" pill. Mounts above the
 * feed when `count > 0`. Clicking calls `onClick`, which the parent uses to
 * scroll back to the top and flush the queue.
 *
 * Visual: sticky inside the parent so it floats above the list without
 * leaving the column. Single accent button — no dismiss affordance, since
 * scrolling back to the top is the implicit dismiss.
 */
export function NewEventsPill({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  if (count <= 0) return null;
  return (
    <div
      data-testid="new-events-pill"
      className="pointer-events-none sticky top-2 z-20 flex justify-center"
    >
      <button
        type="button"
        onClick={onClick}
        className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-accent-700 px-3 py-1.5 text-xs font-medium text-white shadow-md hover:bg-accent-700/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        aria-live="polite"
      >
        <span aria-hidden>↑</span>
        {count} new event{count === 1 ? '' : 's'} — jump to top
      </button>
    </div>
  );
}
