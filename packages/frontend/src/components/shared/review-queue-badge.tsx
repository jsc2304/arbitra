'use client';

import { useActionableCount } from '../../hooks/use-actionable-count';

// Mirrors <Badge size="sm" tone="soft"> structure (#658) on an <a> element
// (Badge renders a span; this needs a real link + hover affordance). Kills the
// old `py-1`/no-ring drift: sm = `px-2.5 py-0.5 text-xs`, soft = `ring-1
// ring-inset`. The corp-orange colour + hover-bg is the queue-specific token.
const BADGE_STRUCTURE =
  'inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap px-2.5 py-0.5 text-xs ring-1 ring-inset';
const QUEUE_COLOR =
  'bg-corp-orange/15 ring-corp-orange/40 text-corp-dark dark:bg-corp-orange/20 dark:text-corp-orange dark:ring-transparent ' +
  'hover:bg-corp-orange/25 dark:hover:bg-corp-orange/30 transition-colors';

export function ReviewQueueBadge() {
  const actionableCount = useActionableCount();

  if (actionableCount === 0) return null;

  return (
    <a
      href="/board?view=ready-to-approve"
      className={`${BADGE_STRUCTURE} ${QUEUE_COLOR}`}
      title="Cases requiring your attention"
    >
      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
      </svg>
      {actionableCount} needs review
    </a>
  );
}
