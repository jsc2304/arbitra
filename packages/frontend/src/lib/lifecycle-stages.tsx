'use client';

import { getTransitionsFrom, lifecycleStationsForCaseType } from '@arbitra/shared';
import type { CaseStatus, CaseType } from '@arbitra/shared';
import { CASE_STATUS_LABELS, caseStatusLabelShort } from './case-status-labels';

export type Shape = 'pipe' | 'circle' | 'square' | 'diamond' | 'exclamation';

export interface LifecycleStage {
  status: CaseStatus;
  label: string;
  shape: Shape;
}

export interface LifecycleBranchStage {
  status: CaseStatus;
  label: string;
  branchAfterStatus: CaseStatus;
}

export interface LifecycleDefinition {
  mainStages: readonly LifecycleStage[];
  branchStages: readonly LifecycleBranchStage[];
}

export interface StageColor {
  /** filled station marker */
  station: string;
  /** label text when current */
  label: string;
  /** track segment leading TO the next station (Tailwind class) */
  track: string;
  /** hex value for shimmer gradient (light mode — also used in dark mode) */
  trackHex: string;
}

export interface StageBadgeColor {
  /** background + text + ring tailwind classes for the pill container */
  pill: string;
  /** solid colour class for the inner dot (shares hue with tracker station) */
  dot: string;
}

/** Terminal statuses — no pulse, muted pill colours (source of truth for UI). */
export const TERMINAL_STATUSES: ReadonlySet<CaseStatus> = new Set(['done', 'rejected']);

export function isTerminalCaseStatus(status: CaseStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/* ── Per-stage color palette (aligned with status-badge) ── */

export const STAGE_COLORS: Record<CaseStatus, StageColor> = {
  // ── Not started ──────────────────────────────────────────────────────────
  open:                 { station: 'text-corp-blue-light dark:text-corp-blue-light', label: 'text-corp-blue-light dark:text-corp-blue-light', track: 'bg-corp-blue-light dark:bg-corp-blue-light', trackHex: '#5CBEE6' },
  // ── Planning phase ────────────────────────────────────────────────────
  exploration:          { station: 'text-corp-blue dark:text-corp-blue',       label: 'text-corp-blue dark:text-corp-blue',          track: 'bg-corp-blue dark:bg-corp-blue',       trackHex: '#149FD8' },
  ready_for_build:      { station: 'text-corp-blue dark:text-corp-blue',     label: 'text-corp-blue dark:text-corp-blue',        track: 'bg-corp-blue dark:bg-corp-blue',     trackHex: '#149FD8' },
  // ── Build phase ───────────────────────────────────────────────────────
  in_build:             { station: 'text-corp-blue dark:text-corp-blue', label: 'text-corp-blue dark:text-corp-blue',    track: 'bg-corp-blue dark:bg-corp-blue', trackHex: '#149FD8'},
  // ── Automated pipeline (teal/cyan) ────────────────────────────────────
  in_validation:        { station: 'text-corp-teal dark:text-corp-teal',     label: 'text-corp-teal dark:text-corp-teal',        track: 'bg-corp-teal dark:bg-corp-teal',     trackHex: '#3ECDBC' },
  in_review:            { station: 'text-corp-teal dark:text-corp-teal',     label: 'text-corp-teal dark:text-corp-teal',        track: 'bg-corp-teal dark:bg-corp-teal',     trackHex: '#3ECDBC' },
  // ── Terminal states ───────────────────────────────────────────────────
  approved:             { station: 'text-corp-green dark:text-corp-green', label: 'text-corp-green dark:text-corp-green', track: 'bg-corp-green dark:bg-corp-green', trackHex: '#97D33F' },
  pending_merge:        { station: 'text-corp-blue dark:text-corp-blue',   label: 'text-corp-blue dark:text-corp-blue',   track: 'bg-corp-blue dark:bg-corp-blue',   trackHex: '#149FD8' },
  done:                 { station: 'text-gray-500 dark:text-gray-400',     label: 'text-gray-600 dark:text-gray-300',       track: 'bg-gray-400 dark:bg-gray-500',     trackHex: '#9ca3af' },
  // ── Branch states: human action needed (amber/orange) ─────────────────
  needs_human_decision: { station: 'text-corp-yellow dark:text-corp-yellow',   label: 'text-corp-yellow dark:text-corp-yellow',      track: 'bg-corp-yellow dark:bg-corp-yellow',   trackHex: '#FCCB30' },
  verification_pending: { station: 'text-corp-orange dark:text-corp-orange', label: 'text-corp-orange dark:text-corp-orange',    track: 'bg-corp-orange dark:bg-corp-orange', trackHex: '#F79724' },
  rejected:             { station: 'text-corp-red dark:text-corp-red',       label: 'text-corp-red dark:text-corp-red',          track: 'bg-corp-red dark:bg-corp-red',       trackHex: '#EE481D' },
};

/* ── Per-stage pill colours (status badge — shares hue with STAGE_COLORS) ──
   Kept alongside STAGE_COLORS so any shift in the stage→hue mapping updates
   tracker + pill together. Dot colour intentionally matches the tracker's
   filled station so a pulsing pill dot reads as the "same marker" the
   current lifecycle node shows. */

export const STAGE_BADGE_COLORS: Record<CaseStatus, StageBadgeColor> = {
  // ── Just started — active accent:
  //    `Open` and `Done` previously read as the same hue family on quick scan.
  //    `Open` now uses the corp-blue-light "early/active" accent that already
  //    leads the planning phase, and `Done` (below) is muted neutral so the
  //    pair is unambiguously distinct.
  //    Three blue-light stages (Open / exploration / ready_for_build) are
  //    differentiated by bg-opacity + ring-opacity tiers — palette is locked
  //    to corp-blue-light so we tier the same hue instead of
  //    introducing a new colour:
  //      Open            → strongest fill + strongest ring  (just started, active)
  //      exploration     → faintest fill + faint ring       (still planning)
  //      ready_for_build → faint fill   + strong ring       ("primed" — about to advance)
  open:                 { pill: 'bg-corp-blue-light/25 text-corp-dark ring-corp-blue-light/60 dark:bg-corp-blue-light/30 dark:text-corp-blue-light dark:ring-transparent', dot: 'bg-corp-blue-light dark:bg-corp-blue-light' },
  // ── Planning phase (sky progression — opacity-tiered) ────────────────
  exploration:          { pill: 'bg-corp-blue-light/10 text-corp-dark ring-corp-blue-light/30 dark:bg-corp-blue-light/15 dark:text-corp-blue-light dark:ring-transparent', dot: 'bg-corp-blue-light dark:bg-corp-blue-light' },
  ready_for_build:      { pill: 'bg-corp-blue-light/10 text-corp-dark ring-corp-blue-light/70 dark:bg-corp-blue-light/15 dark:text-corp-blue-light dark:ring-corp-blue-light/60', dot: 'bg-corp-blue-light dark:bg-corp-blue-light' },
  // ── Build phase (mid blue) ───────────────────────────────────────────
  in_build:             { pill: 'bg-corp-blue/10 text-corp-dark ring-corp-blue/30 dark:bg-corp-blue/20 dark:text-corp-blue dark:ring-transparent',                         dot: 'bg-corp-blue dark:bg-corp-blue' },
  // ── Automated pipeline (teal/cyan) ───────────────────────────────────
  in_validation:        { pill: 'bg-corp-teal/10 text-corp-dark ring-corp-teal/30 dark:bg-corp-teal/20 dark:text-corp-teal-bright dark:ring-transparent',                  dot: 'bg-corp-teal dark:bg-corp-teal' },
  in_review:            { pill: 'bg-corp-teal/10 text-corp-dark ring-corp-teal/30 dark:bg-corp-teal/20 dark:text-corp-teal-bright dark:ring-transparent',                  dot: 'bg-corp-teal dark:bg-corp-teal' },
  // ── Human action needed (amber — your turn) ──────────────────────────
  needs_human_decision: { pill: 'bg-corp-yellow/20 text-corp-dark ring-corp-yellow/50 dark:bg-corp-yellow/30 dark:text-corp-yellow-bright dark:ring-transparent',          dot: 'bg-corp-yellow dark:bg-corp-yellow' },
  verification_pending: { pill: 'bg-corp-orange/10 text-corp-dark ring-corp-orange/30 dark:bg-corp-orange/20 dark:text-corp-orange dark:ring-transparent',                 dot: 'bg-corp-orange dark:bg-corp-orange' },
  // ── Terminal / late-phase states ─────────────────────────────────────
  approved:             { pill: 'bg-corp-green/10 text-corp-dark ring-corp-green/30 dark:bg-corp-green/20 dark:text-corp-green dark:ring-transparent',                     dot: 'bg-corp-green dark:bg-corp-green' },
  pending_merge:        { pill: 'bg-corp-blue-dark/10 text-corp-dark ring-corp-blue-dark/30 dark:bg-corp-blue-dark/20 dark:text-corp-blue-dark dark:ring-transparent',     dot: 'bg-corp-blue-dark dark:bg-corp-blue-dark' },
  // `Done` reads as completed/neutral (muted gray) so it is not confused with
  // the active `approved` (corp-green) or with `Open` which now leads with
  // the corp-blue-light accent.
  // Done uses a stronger 2-px ring + darker text so it is distinct from the
  // FALLBACK_PILL in status-badge.tsx (unknown/off-list states): same gray
  // family but Done reads as a deliberate terminal token, fallback reads as
  // a faint ghost. Follow-up #103.
  done:                 { pill: 'bg-gray-200 text-gray-800 ring-gray-400 dark:bg-gray-700 dark:text-gray-100 dark:ring-gray-500',                                          dot: 'bg-gray-500 dark:bg-gray-300' },
  rejected:             { pill: 'bg-corp-red/10 text-corp-dark ring-corp-red/30 dark:bg-corp-red/20 dark:text-corp-red dark:ring-transparent',                             dot: 'bg-corp-red dark:bg-corp-red' },
};

export const MAIN_STAGES: LifecycleStage[] = [
  { status: 'open',            label: 'Open',       shape: 'pipe'    },
  { status: 'exploration',     label: 'Exploring',  shape: 'diamond' },
  { status: 'ready_for_build', label: 'Ready',      shape: 'square'  },
  { status: 'in_build',        label: 'Building',   shape: 'diamond' },
  { status: 'in_validation',   label: 'Validating', shape: 'circle'  },
  { status: 'in_review',       label: 'AI Review',  shape: 'square'  },
  { status: 'approved',        label: 'Approved',   shape: 'diamond' },
  { status: 'pending_merge',   label: 'Merge PR',   shape: 'square'  },
  { status: 'done',            label: 'Done',       shape: 'circle'  },
];

/* ── Per-stage description + gate copy used by lifecycle-strip tooltips ──
   `description` is shown for every stage (one-liner, neutral tense).
   `gate` is the entry condition shown for *future* stages (what unlocks it).
   Branch states are not main-line stages and are not included here. */

export const STAGE_META: Partial<Record<CaseStatus, { description: string; gate: string }>> = {
  open: {
    description: 'Case has been created and is awaiting an exploration run.',
    gate: 'Case is created.',
  },
  exploration: {
    description: 'Agent is mapping the change and gathering context.',
    gate: 'An agent starts exploring the case.',
  },
  ready_for_build: {
    description: 'Plan is in place; the case is queued for build.',
    gate: 'Exploration completes and the case is marked ready.',
  },
  in_build: {
    description: 'Agent is implementing the change against the plan.',
    gate: 'A build run begins.',
  },
  in_validation: {
    description: 'Automated checks (lint, type, tests) are running on the build.',
    gate: 'The build completes and validation is requested.',
  },
  in_review: {
    description: 'AI reviewer is grading findings and deciding next steps.',
    gate: 'Validation completes and AI review begins.',
  },
  approved: {
    description: 'Reviewer approved the change; ready to merge.',
    gate: 'Review concludes with an approval (auto or human).',
  },
  pending_merge: {
    description: 'Approval is in; awaiting the PR to be merged.',
    gate: 'Case is approved and a PR is open.',
  },
  done: {
    description: 'Case is complete.',
    gate: 'PR is merged or the case is otherwise closed.',
  },
  rejected: {
    description: 'Case was rejected and will not be merged.',
    gate: 'A reviewer rejects the change.',
  },
};

const ASSISTANT_STAGE_META: Partial<
  Record<CaseStatus, { description: string; gate: string }>
> = {
  open: {
    description: 'The Clerk request has been recorded and is waiting to start.',
    gate: 'The request is accepted into the private Clerk project.',
  },
  in_build: {
    description: 'Clerk is reading the requester-scoped data needed to answer.',
    gate: 'The assistant run is claimed.',
  },
  done: {
    description: 'Clerk stored the answer and its supporting evidence.',
    gate: 'A task-result artifact is stored as evidence.',
  },
  rejected: {
    description: 'Clerk stopped without producing an answer.',
    gate: 'The request is cancelled or fails permanently.',
  },
};

/**
 * Observed Case stage copy (issue #1018 / ADR-0001). Honest about what the
 * shortened lifecycle actually does: it records activity, it does not build
 * or gate anything. `in_build`'s gate text doubles as the escalation note —
 * the only way an Observed Case leaves this rail is policy escalating it
 * into the full engineering lifecycle (`case_type` flips away from
 * `'observed'`), which the rail's caller must re-render entirely rather
 * than show as a fourth station here.
 */
const OBSERVED_STAGE_META: Partial<
  Record<CaseStatus, { description: string; gate: string }>
> = {
  open: {
    description: 'Arbitra noticed activity on this branch and created a case to record it.',
    gate: 'A session signal or PR webhook is observed with no case bound to the branch yet.',
  },
  in_build: {
    description: 'Recording the work as it happens — nothing is blocked or gated.',
    gate: 'Policy escalation would move this case into the full enforced lifecycle instead.',
  },
  done: {
    description: 'The branch merged (or the case otherwise closed) with nothing further to record.',
    gate: 'The PR merges, or the case is otherwise closed.',
  },
};

export function getLifecycleStageMeta(
  status: CaseStatus,
  caseType?: CaseType,
): { description: string; gate: string } | undefined {
  if (caseType === 'assistant_task') return ASSISTANT_STAGE_META[status];
  if (caseType === 'observed') return OBSERVED_STAGE_META[status];
  return STAGE_META[status];
}

/* ── Map main-line stages to the canonical "entry event" type(s) ──
   Used by the lifecycle strip to (a) display the entry timestamp in tooltips
   for past stages and (b) provide a target for click-to-scroll into the
   timeline. Tried in order — the first match wins. */

export const STAGE_ENTRY_EVENT_TYPES: Partial<Record<CaseStatus, readonly string[]>> = {
  open: ['case_created'],
  exploration: ['exploration_requested'],
  ready_for_build: ['case_ready_for_build', 'exploration_completed'],
  in_build: ['build_started', 'assistant_task_started', 'observed_case_started'],
  in_validation: ['validation_started', 'validation_requested'],
  in_review: ['review_started', 'review_requested'],
  approved: ['case_approved', 'auto_approve_decision'],
  pending_merge: ['merge_ready'],
  done: ['case_completed', 'pr_merged', 'case_auto_closed_on_merge', 'assistant_task_completed'],
  rejected: ['case_rejected', 'assistant_task_cancelled'],
};

export const BRANCH_STAGES: LifecycleBranchStage[] = [
  { status: 'needs_human_decision', label: 'Needs Decision',      branchAfterStatus: 'in_review' },
  { status: 'verification_pending', label: 'Verification Pending', branchAfterStatus: 'in_review' },
];

/**
 * Derive a scoped case type's lifecycle definition from the shared
 * `lifecycleStationsForCaseType` BFS (issue #1018 / #986) — the transition
 * matrix is the only source of truth for which stations exist and in what
 * order; this only adds the UI-side label/shape/branch presentation on top.
 * Used for every `SCOPED_CASE_TYPES` member (`assistant_task`, `observed`)
 * so a new scoped case type never needs a third hand-copied rail.
 */
function deriveScopedLifecycleDefinition(caseType: CaseType): LifecycleDefinition {
  const mainStatuses = lifecycleStationsForCaseType(caseType);
  const mainIndex = new Map(mainStatuses.map((status, index) => [status, index]));
  const scopedStatuses = new Set<CaseStatus>(['open']);
  const queue: CaseStatus[] = ['open'];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const transition of getTransitionsFrom(current, caseType)) {
      if (scopedStatuses.has(transition.to)) continue;
      scopedStatuses.add(transition.to);
      queue.push(transition.to);
    }
  }
  const transitions = [...scopedStatuses].flatMap((status) =>
    getTransitionsFrom(status, caseType),
  );

  const branchStatuses = [...scopedStatuses].filter(
    (status) => !mainIndex.has(status) && status !== 'rejected',
  );
  const branchStages = branchStatuses.map((status): LifecycleBranchStage => {
    const anchors = transitions.flatMap((transition) => {
      if (transition.to === status && transition.from !== 'any' && mainIndex.has(transition.from)) {
        return [transition.from];
      }
      if (transition.from === status && mainIndex.has(transition.to)) {
        return [transition.to];
      }
      return [];
    });
    const branchAfterStatus = anchors.reduce(
      (latest, candidate) =>
        (mainIndex.get(candidate) ?? -1) > (mainIndex.get(latest) ?? -1)
          ? candidate
          : latest,
      mainStatuses[0]!,
    );
    return {
      status,
      label: CASE_STATUS_LABELS[status],
      branchAfterStatus,
    };
  });

  return {
    mainStages: mainStatuses.map((status) => ({
      status,
      label: caseStatusLabelShort(status, caseType),
      shape: MAIN_STAGES.find((stage) => stage.status === status)?.shape ?? 'circle',
    })),
    branchStages,
  };
}

const ASSISTANT_LIFECYCLE_DEFINITION = deriveScopedLifecycleDefinition('assistant_task');
const OBSERVED_LIFECYCLE_DEFINITION = deriveScopedLifecycleDefinition('observed');

/**
 * Engineering remains the byte-for-byte default. `assistant_task` and
 * `observed` (issue #1018) each get their scoped definition derived above —
 * a shortened rail with honest station labels instead of the nine-station
 * engineering chrome.
 */
export function getLifecycleDefinition(caseType?: CaseType): LifecycleDefinition {
  if (caseType === 'assistant_task') return ASSISTANT_LIFECYCLE_DEFINITION;
  if (caseType === 'observed') return OBSERVED_LIFECYCLE_DEFINITION;
  return { mainStages: MAIN_STAGES, branchStages: BRANCH_STAGES };
}

/* ── SVG geometric station markers (Mini Metro style) ── */

export function StationSVG({ shape, size, outlined }: { shape: Shape; size: number; outlined?: boolean }) {
  const s = size;
  const h = s / 2;
  const sw = 2;
  const props = outlined
    ? { fill: 'none' as const, stroke: 'currentColor', strokeWidth: sw }
    : { fill: 'currentColor' as const };

  switch (shape) {
    case 'pipe': {
      /* Bold vertical bar — signals "start of track" */
      const w = s * 0.42;
      const inset = outlined ? sw / 2 + 0.5 : 0.5;
      return <rect x={(s - w) / 2} y={inset} width={w} height={s - inset * 2} rx={1.5} {...props} />;
    }
    case 'circle': {
      const r = outlined ? h - sw / 2 - 0.5 : h - 0.5;
      return <circle cx={h} cy={h} r={r} {...props} />;
    }
    case 'square': {
      const inset = outlined ? sw / 2 + 0.5 : 0.5;
      return (
        <rect
          x={inset} y={inset}
          width={s - inset * 2} height={s - inset * 2}
          rx={2}
          {...props}
        />
      );
    }
    case 'diamond': {
      const d = outlined ? s * 0.2 : s * 0.12;
      return (
        <rect
          x={d} y={d}
          width={s - d * 2} height={s - d * 2}
          rx={1.5}
          transform={`rotate(45 ${h} ${h})`}
          {...props}
        />
      );
    }
    case 'exclamation': {
      const r = h - 0.5;
      const markBodyW = s * 0.2;
      const markBodyH = s * 0.38;
      const markBodyX = h - markBodyW / 2;
      const markBodyY = s * 0.17;
      const markDotR = s * 0.11;
      const markDotCY = s * 0.76;
      return (
        <>
          <circle cx={h} cy={h} r={r} fill="currentColor" />
          <rect x={markBodyX} y={markBodyY} width={markBodyW} height={markBodyH} rx={markBodyW / 2} fill="white" fillOpacity={0.92} />
          <circle cx={h} cy={markDotCY} r={markDotR} fill="white" fillOpacity={0.92} />
        </>
      );
    }
  }
}
