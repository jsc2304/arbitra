'use client';

import type { WorkspaceEventBlockProps } from './index';

/**
 * Fallback block for unknown `WorkspaceEvent.type` values. Pretty-prints the
 * raw `evidence` payload so operators can still inspect the row without
 * blocking on a new per-type renderer. Guards against entirely missing
 * evidence — some event types legitimately omit it.
 */
export function DefaultBlock({ event }: WorkspaceEventBlockProps) {
  if (!event.evidence || Object.keys(event.evidence).length === 0) {
    return (
      <div className="text-sm text-gray-500 dark:text-gray-400">
        No details available for this event.
      </div>
    );
  }
  return (
    <pre className="rounded-md bg-surface-base dark:bg-surface-base/40 p-3 text-xs text-gray-700 dark:text-gray-300 overflow-x-auto whitespace-pre-wrap break-words">
      {JSON.stringify(event.evidence, null, 2)}
    </pre>
  );
}
