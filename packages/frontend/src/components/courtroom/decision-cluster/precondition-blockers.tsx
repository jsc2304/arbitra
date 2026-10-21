'use client';

/**
 * PreconditionBlockers — persistent "Approval blocked by" panel.
 *
 * Surfaces WHY an approve is currently blocked (which transition
 * preconditions are unmet) so a human reviewer sees it up-front, without
 * having to click Approve and read an ephemeral toast. NOT dismissible,
 * NOT a toast — it stays as long as blockers exist.
 *
 * Styling deliberately reuses the amber warning treatment from the
 * `approveBlockedByFindings` chip in `tier-one-actions.tsx` so the two read
 * as one consistent "blocked" language rather than competing palettes.
 *
 * Renders nothing when there are no blockers.
 */

export interface PreconditionBlocker {
  id: string;
  reason: string;
}

export interface PreconditionBlockersProps {
  blockers: readonly PreconditionBlocker[];
}

export function PreconditionBlockers({ blockers }: PreconditionBlockersProps) {
  if (blockers.length === 0) return null;

  return (
    <div
      className="mb-3 flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
      data-testid="precondition-blockers"
    >
      <svg
        className="h-4 w-4 flex-shrink-0 mt-0.5"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={2}
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
        />
      </svg>
      <div className="space-y-1">
        <p className="font-medium">
          Approval blocked — resolve before approving
        </p>
        <ul className="list-disc space-y-0.5 pl-4">
          {blockers.map((blocker) => (
            <li key={blocker.id}>{blocker.reason}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
