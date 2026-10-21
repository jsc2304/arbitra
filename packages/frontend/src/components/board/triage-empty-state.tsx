'use client';

/**
 * Per-view empty state for the Board triage views.
 *
 * Thin wrapper around the shared `EmptyState` primitive that looks up
 * title/description/next-view copy in `lib/triage-empty-states.ts` and
 * renders a "Try {nextViewLabel}" action that navigates to `?view={nextView}`
 * via `router.replace` — same pattern as `triage-header.tsx`.
 */

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import EmptyState from '../shared/empty-state';
import { TRIAGE_EMPTY_STATES } from '../../lib/triage-empty-states';
import type { TriageView } from '../../lib/triage-views';

export interface TriageEmptyStateProps {
  /** The currently active triage view, whose empty-state copy will render. */
  view: TriageView;
}

export function TriageEmptyState({ view }: TriageEmptyStateProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const entry = TRIAGE_EMPTY_STATES[view] ?? TRIAGE_EMPTY_STATES['needs-me'];

  const handleNext = useCallback(() => {
    if (!entry.nextView) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', entry.nextView);
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [entry.nextView, pathname, router, searchParams]);

  const action =
    entry.nextView && entry.nextViewLabel
      ? { label: `Try ${entry.nextViewLabel}`, onClick: handleNext }
      : undefined;

  return (
    <EmptyState
      variant="filter"
      title={entry.title}
      description={entry.description}
      action={action}
    />
  );
}

export default TriageEmptyState;
