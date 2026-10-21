'use client';

interface UnknownUserPillProps {
  /**
   * The raw user id that failed to resolve. Preserved as a `title` attribute
   * so support / debugging can still read it on hover, but never rendered as
   * visible text.
   */
  userId: string;
}

/**
 * Fallback chip for human user ids that the user-map failed to resolve
 * (network failure, deleted account, ACL miss). Renders a neutral
 * "Unknown user" label and keeps the raw id reachable via tooltip.
 *
 * Replaces the prior `userId.slice(0, 10) + '...'` truncation, which leaked
 * opaque strings like `WvEOTfY8x...` into demo-facing surfaces.
 */
export function UnknownUserPill({ userId }: UnknownUserPillProps) {
  return (
    <span
      data-testid="unknown-user-pill"
      title={userId}
      className="italic text-gray-500 dark:text-gray-400"
    >
      Unknown user
    </span>
  );
}
