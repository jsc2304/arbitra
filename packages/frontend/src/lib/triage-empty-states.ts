/**
 * Per-view empty-state copy for the Board triage views.
 *
 * Each {@link TriageView} maps to a short title + description explaining *why*
 * the view is empty, plus an optional next view the user can jump to. The
 * board reads this lookup when `visibleCases.length === 0` and renders the
 * shared `EmptyState` (`components/shared/empty-state.tsx`, extended in PR
 * #232 with the `filter` variant).
 *
 * Strings are intentionally terse and non-patronizing — the goal is to make
 * the empty branch feel like a routed destination, not a dead end.
 */
import type { TriageView } from './triage-views';

export interface TriageEmptyState {
  /** Short, headline-style title. */
  title: string;
  /** One-sentence explanation of *why* the view is empty. */
  description: string;
  /** Optional next view the user can jump to. */
  nextView?: TriageView;
  /** Human-readable label for the next-view button. */
  nextViewLabel?: string;
}

/**
 * Empty-state copy keyed by {@link TriageView}. Every view has an entry; the
 * `nextView` links always point to a sibling triage view so the user stays in
 * the Board flow.
 */
export const TRIAGE_EMPTY_STATES: Record<TriageView, TriageEmptyState> = {
  all: {
    title: 'No cases yet',
    description:
      'This workspace has no cases. Create the first one or wait for an agent to open one.',
    nextView: 'needs-me',
    nextViewLabel: 'Needs Me',
  },
  'needs-me': {
    title: 'Nothing waiting on you',
    description:
      'No cases are assigned to you or pending your gate. Check the approval queue for cases ready for a decision.',
    nextView: 'ready-to-approve',
    nextViewLabel: 'Ready to Approve',
  },
  'ready-to-approve': {
    title: 'No cases ready for approval',
    description:
      'All cases are progressing without needing a decision right now. See what is still in flight.',
    nextView: 'waiting-on-others',
    nextViewLabel: 'Waiting on Others',
  },
  blocked: {
    title: 'No blocked cases',
    description:
      'Nothing is blocked by open findings or a rejection. See what changed in the last 24 hours.',
    nextView: 'recently-updated',
    nextViewLabel: 'Recently Updated',
  },
  'waiting-on-others': {
    title: 'None of your cases are in-flight',
    description:
      'No cases you own are currently being built, validated, or reviewed. See everything you still own.',
    nextView: 'my-active',
    nextViewLabel: 'My Active',
  },
  'recently-updated': {
    title: 'No recent activity',
    description:
      'No cases have been updated in the last 24 hours. Check the approval queue for cases waiting on a decision.',
    nextView: 'ready-to-approve',
    nextViewLabel: 'Ready to Approve',
  },
  'my-active': {
    title: 'You have no active cases',
    description:
      'None of the cases you own are currently in progress. See if anything needs your attention.',
    nextView: 'needs-me',
    nextViewLabel: 'Needs Me',
  },
};
