import type { ReactNode } from 'react';
import type { ActivityKind } from '@arbitra/shared';

/**
 * Shared visual vocabulary for activity rows. One source of truth used by
 * both the workspace-wide activity feed (`/activity`) and the per-case event
 * timeline (`components/case/event-timeline.tsx`). Keep icons inline-SVG,
 * stroke-width 1.5, sized by the consumer via Tailwind classes on the
 * wrapping element.
 */

export interface ActivityIconMeta {
  /** Inline SVG. Sized by the consumer via parent classes. */
  icon: ReactNode;
  /** Tailwind classes for the circular background chip behind the icon. */
  chipClass: string;
  /** Tailwind classes for a solid category dot (used by the compact timeline). */
  dotClass: string;
  /** Short human-readable label. */
  label: string;
}

// Compact dot/icon style — used on the left margin of a feed row.
function makeIcon(path: ReactNode) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      {path}
    </svg>
  );
}

const lifecycleIcon = makeIcon(
  <>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l3 3" />
    <circle cx="12" cy="12" r="9" strokeLinecap="round" strokeLinejoin="round" />
  </>,
);

const mergeIcon = makeIcon(
  <>
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 6a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M17 13a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.5 8.5h2.25A5.25 5.25 0 0 1 17 13.75V14" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M17 6v4" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 8h4" />
  </>,
);

const pullRequestIcon = makeIcon(
  <>
    <circle cx="7" cy="6" r="2.25" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="7" cy="18" r="2.25" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="17" cy="18" r="2.25" strokeLinecap="round" strokeLinejoin="round" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 8.5v7.25" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.25 6H12a5 5 0 0 1 5 5v4.75" />
  </>,
);

const checkCircleIcon = makeIcon(
  <>
    <path strokeLinecap="round" strokeLinejoin="round" d="m8.5 12 2.25 2.25L15.5 9.5" />
    <circle cx="12" cy="12" r="9" strokeLinecap="round" strokeLinejoin="round" />
  </>,
);

const readyIcon = makeIcon(
  <>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 17V7" />
    <path strokeLinecap="round" strokeLinejoin="round" d="m8.5 10.5 3.5-3.5 3.5 3.5" />
    <rect x="4" y="17" width="16" height="3" rx="1.5" />
  </>,
);

const flagIcon = makeIcon(
  <>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 20V5" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 5h9l-1.75 3L15 11H6" />
  </>,
);

const commentIcon = makeIcon(
  <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 0 1-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />,
);

const evidenceIcon = makeIcon(
  <path strokeLinecap="round" strokeLinejoin="round" d="m9 12.75 2.25 2.25L15 9.75M12 3l8.25 4.5v6c0 4.556-3.694 8.25-8.25 8.25S3.75 18.056 3.75 13.5v-6L12 3Z" />,
);

const findingIcon = makeIcon(
  <>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.5v.01" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3 2.25 20.25h19.5L12 3Z" />
  </>,
);

const decisionIcon = makeIcon(
  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />,
);

// Broadcast / signal icon — concentric arcs around a central dot. Used for
// workspace-level system events (scheduled intelligence runs, etc.) to read
// visually as "a heartbeat from the system".
const workspaceEventIcon = makeIcon(
  <>
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <path strokeLinecap="round" d="M8.5 15.5a5 5 0 0 1 0-7" />
    <path strokeLinecap="round" d="M15.5 15.5a5 5 0 0 0 0-7" />
    <path strokeLinecap="round" d="M5.75 18.25a9 9 0 0 1 0-12.5" />
    <path strokeLinecap="round" d="M18.25 18.25a9 9 0 0 0 0-12.5" />
  </>,
);

/**
 * Top-level mapping keyed by `ActivityKind`. Consumers can override per-row
 * when a finer subkind (e.g. `decision.type = 'reject'`) needs its own color;
 * see `getActivityMeta` below for the default merge behavior.
 */
export const ACTIVITY_ICONS: Record<ActivityKind, ActivityIconMeta> = {
  case_event: {
    icon: lifecycleIcon,
    chipClass: 'bg-accent/15 text-accent dark:bg-accent/20 dark:text-accent-300',
    dotClass: 'bg-accent',
    label: 'Lifecycle',
  },
  comment: {
    icon: commentIcon,
    chipClass: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    dotClass: 'bg-blue-500',
    label: 'Comment',
  },
  evidence: {
    icon: evidenceIcon,
    chipClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
    dotClass: 'bg-teal-500',
    label: 'Evidence',
  },
  finding: {
    icon: findingIcon,
    chipClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    dotClass: 'bg-amber-500',
    label: 'Finding',
  },
  decision: {
    icon: decisionIcon,
    chipClass: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    dotClass: 'bg-green-500',
    label: 'Decision',
  },
  workspace_event: {
    icon: workspaceEventIcon,
    // Muted palette — system rows shouldn't compete with case-scoped rows
    // for attention. Same chip tone as timeline pipeline events.
    chipClass: 'bg-gray-100 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300',
    dotClass: 'bg-gray-400 dark:bg-gray-500',
    label: 'System',
  },
};

/**
 * Per-subkind overrides for `decision` — approve/reject/request-changes
 * each get their own palette to match the existing `PayloadRenderer`
 * conventions in `event-timeline.tsx`.
 */
const DECISION_SUBKIND_CHIP: Record<string, string> = {
  approve: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  auto_approve: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  manual_validation_confirmed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  gate_confirmed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  reject: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  gate_rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  request_changes: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  waive: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  escalate: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
};

const FINDING_SEVERITY_CHIP: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  low: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  info: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
};

const CASE_EVENT_OVERRIDES: Record<string, Partial<ActivityIconMeta>> = {
  review_completed: {
    icon: checkCircleIcon,
    chipClass: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    label: 'Review',
  },
  review_marked_not_applicable: {
    chipClass: 'bg-gray-100 text-gray-600 dark:bg-gray-700/60 dark:text-gray-300',
    label: 'Review skipped',
  },
  review_not_applicable_marked: {
    icon: decisionIcon,
    chipClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    label: 'Review marked N/A',
  },
  review_not_applicable_cleared: {
    icon: checkCircleIcon,
    chipClass: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    label: 'Review re-enabled',
  },
  case_approved: {
    icon: checkCircleIcon,
    chipClass: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    label: 'Approved',
  },
  case_completed: {
    icon: flagIcon,
    chipClass: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    label: 'Completed',
  },
  case_rejected: {
    chipClass: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    label: 'Rejected',
  },
  human_decision_requested: {
    icon: decisionIcon,
    chipClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    label: 'Decision',
  },
  changes_requested: {
    icon: decisionIcon,
    chipClass: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
    label: 'Rework',
  },
  case_ready_for_build: {
    icon: readyIcon,
    chipClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
    label: 'Ready',
  },
  build_started: {
    icon: readyIcon,
    chipClass: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    label: 'Build',
  },
  pr_updated: {
    icon: pullRequestIcon,
    chipClass: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    label: 'PR',
  },
  pr_merged: {
    icon: mergeIcon,
    chipClass: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    label: 'Merged',
  },
  case_anomaly_merge_on_gated_status: {
    icon: findingIcon,
    chipClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    label: 'Anomaly',
  },
  merge_ready: {
    icon: readyIcon,
    chipClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
    label: 'Merge Ready',
  },
};

/**
 * Resolve an `ActivityIconMeta`, applying subkind-specific overrides for
 * decisions (by decision.type) and findings (by severity). Returns the
 * base `ACTIVITY_ICONS[kind]` unchanged when no override applies.
 */
export function getActivityMeta(
  kind: ActivityKind,
  subkind?: string,
): ActivityIconMeta {
  const base = ACTIVITY_ICONS[kind];
  if (kind === 'case_event' && subkind && CASE_EVENT_OVERRIDES[subkind]) {
    return { ...base, ...CASE_EVENT_OVERRIDES[subkind] };
  }
  if (kind === 'decision' && subkind && DECISION_SUBKIND_CHIP[subkind]) {
    return { ...base, chipClass: DECISION_SUBKIND_CHIP[subkind] };
  }
  if (kind === 'finding' && subkind && FINDING_SEVERITY_CHIP[subkind]) {
    return { ...base, chipClass: FINDING_SEVERITY_CHIP[subkind] };
  }
  return base;
}

/**
 * Shared event-category taxonomy used by the case event-timeline. Exported
 * here so both `event-timeline.tsx` and any future event-centric view can
 * stay aligned. The subkind (`event.type`) maps to one of four categories
 * which each get a dot color.
 */
export type TimelineEventCategory = 'lifecycle' | 'pipeline' | 'human' | 'artifact';

export const TIMELINE_EVENT_CATEGORIES: Partial<Record<string, TimelineEventCategory>> = {
  // Lifecycle — state machine milestones
  case_created: 'lifecycle',
  case_approved: 'lifecycle',
  case_completed: 'lifecycle',
  case_rejected: 'lifecycle',
  case_ready_for_build: 'lifecycle',
  build_started: 'lifecycle',
  exploration_completed: 'lifecycle',
  validation_started: 'lifecycle',
  review_started: 'lifecycle',
  auto_approve_decision: 'lifecycle',
  manual_validation_confirmed: 'lifecycle',
  status_changed: 'lifecycle',
  case_anomaly_merge_on_gated_status: 'lifecycle',
  // Pipeline — automated system events
  exploration_requested: 'pipeline',
  validation_requested: 'pipeline',
  review_requested: 'pipeline',
  run_created: 'pipeline',
  run_started: 'pipeline',
  run_completed: 'pipeline',
  review_completed: 'pipeline',
  review_marked_not_applicable: 'pipeline',
  review_not_applicable_cleared: 'pipeline',
  // Human-filed (not pipeline auto-attach) — categorized as `human` so it
  // sits alongside other user-driven decisions.
  review_not_applicable_marked: 'human',
  run_failed: 'pipeline',
  run_retries_exhausted: 'pipeline',
  track_assigned: 'pipeline',
  human_decision_requested: 'pipeline',
  evidence_missing_detected: 'pipeline',
  rule_results_attached: 'pipeline',
  manual_verification_requested: 'pipeline',
  // Human — user-driven decisions and actions
  human_decision_recorded: 'human',
  changes_requested: 'human',
  comment_added: 'human',
  risk_level_changed: 'human',
  case_updated: 'human',
  role_changed: 'human',
  evidence_registered: 'human',
  // Artifact — findings, decisions, knowledge
  finding_created: 'artifact',
  finding_updated: 'artifact',
  knowledge_asset_created: 'artifact',
  knowledge_asset_status_changed: 'artifact',
  decision_created: 'artifact',
};

export const TIMELINE_CATEGORY_DOT_CLASS: Record<TimelineEventCategory, string> = {
  lifecycle: 'bg-accent',
  pipeline: 'bg-gray-300 dark:bg-gray-600',
  human: 'bg-blue-500',
  artifact: 'bg-teal-500',
};
