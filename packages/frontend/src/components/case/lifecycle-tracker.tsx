'use client';

import { Fragment, useRef, useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { CaseEvent, CaseStatus, CaseType } from '@arbitra/shared';
import {
  STAGE_COLORS,
  MAIN_STAGES,
  STAGE_ENTRY_EVENT_TYPES,
  StationSVG,
  getLifecycleDefinition,
  getLifecycleStageMeta,
  isTerminalCaseStatus,
} from '../../lib/lifecycle-stages';
import type { Shape } from '../../lib/lifecycle-stages';
import { Tooltip } from '../shared/tooltip';

interface LifecycleTrackerProps {
  status: CaseStatus;
  /** Omitted means the unchanged engineering lifecycle. */
  caseType?: CaseType;
  orientation?: 'horizontal' | 'vertical';
  variant?: 'full' | 'compact';
  /**
   * Case events. When provided, the compact variant renders rich tooltips
   * (entry timestamp for past stages) and enables click-to-jump on past
   * stations whose entry event is present. Required for `showLabels` to
   * surface meaningful tooltip content.
   */
  events?: readonly CaseEvent[];
  /**
   * Render the stage label + rich hover/focus tooltips beneath each station
   * in the compact variant. Used by the case-detail lifecycle strip.
   * Defaults to false to preserve the unlabeled
   * compact treatment used by board cards and the review-session header.
   */
  showLabels?: boolean;
  /**
   * Invoked when a past-stage station is activated (click / Enter / Space).
   * Receives the `event_id` of the stage's entry event. Future stages and
   * stages with no matching event are non-interactive and never call this.
   */
  onStageClick?: (eventId: string) => void;
}

type Variant = 'completed' | 'current' | 'future' | 'branch';
type TrackStyle = CSSProperties & {
  '--lifecycle-track-color'?: string;
  '--lifecycle-track-delay'?: string;
};

/* ── Tooltip / aria-label helper ──
   Minimum-viable legend via native `title`. Polished tooltip system deferred.
   Timestamps per-station deferred — requires threading event data through the component. */
function stationTooltip(label: string, variant: Variant): string {
  const statusText =
    variant === 'completed' ? 'completed'
    : variant === 'current' ? 'current stage'
    : variant === 'future'  ? 'upcoming'
    : 'branch';
  return `${label} — ${statusText}`;
}

/* ── Station component ── */

function Station({
  shape,
  variant,
  colorClass,
  animate = false,
  tooltip,
}: {
  shape: Shape;
  variant: Variant;
  colorClass: string;
  /** Only the main-line current station gets the heartbeat — branch stations are always static */
  animate?: boolean;
  /** Tooltip text (applied as native `title` + `aria-label` for screen readers) */
  tooltip?: string;
}) {
  const isActive = variant === 'current' || variant === 'branch';
  const size = isActive ? 18 : 12;
  const outlined = variant === 'future';

  const finalColor = variant === 'future'
    ? 'text-gray-300 dark:text-gray-600'
    : colorClass;

  return (
    <div
      className={`flex-shrink-0 flex items-center justify-center ${finalColor} ${animate ? 'lifecycle-station-pulse' : ''}`}
      style={{
        width: 20, height: 20,
      }}
      title={tooltip}
      aria-label={tooltip}
      role="img"
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <StationSVG shape={shape} size={size} outlined={outlined} />
      </svg>
    </div>
  );
}

/* ── Shimmer track segment (completed tracks only) ── */

function ShimmerTrack({
  hex,
  stageIndex,
  active = false,
  className,
}: {
  hex: string;
  stageIndex: number;
  active?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex-1 h-[3px] mt-[8.5px] min-w-[28px] md:min-w-[20px] rounded-full overflow-hidden ${className ?? ''}`}>
      <div
        className={`w-full h-full rounded-full lifecycle-track-shimmer ${active ? 'lifecycle-track-active' : ''}`}
        style={{
          '--lifecycle-track-color': hex,
          '--lifecycle-track-delay': `${stageIndex * 180}ms`,
        } as TrackStyle}
      />
    </div>
  );
}

/* ── Main Component ── */

/* ── Lifecycle-strip tooltip body ──
   Bold name + one-line description + either entry timestamp (past stages)
   or expected gate condition (future stages). Current stage shows the
   description plus an "Active now" caption. Branch stations render a
   simpler caption — they're not part of the main-line lifecycle. */
/* ── Entry-event resolution (pure, exported for unit testing) ──
   For each main-line stage, find its "entry event": the *first* (oldest)
   event whose type is listed in STAGE_ENTRY_EVENT_TYPES for that stage. The
   events list is already ordered `created_at` ascending at the source (the
   BFF route `GET /cases/:id/events` → EventService.getHistory → Firestore
   `orderBy('created_at', 'asc')`), so we iterate it as-is and take the first
   match per type as the canonical entry. The resulting `eventId` is exactly
   the payload `onStageClick` receives when a past-stage button is clicked, so
   testing this map directly proves the click wiring without a DOM/renderer. */
export function resolveEntryEventByStatus(
  stages: readonly { status: CaseStatus }[],
  events?: readonly CaseEvent[],
): Record<string, { eventId: string; createdAt: string }> {
  const out: Record<string, { eventId: string; createdAt: string }> = {};
  if (!events || events.length === 0) return out;
  for (const stage of stages) {
    const types = STAGE_ENTRY_EVENT_TYPES[stage.status];
    if (!types) continue;
    for (const ev of events) {
      if (types.includes(ev.type)) {
        out[stage.status] = { eventId: ev.event_id, createdAt: ev.created_at };
        break;
      }
    }
  }
  return out;
}

export function StageTooltipBody({
  label,
  variant,
  description,
  gateText,
  enteredAtIso,
}: {
  label: string;
  variant: Variant;
  description?: string;
  gateText?: string;
  enteredAtIso?: string;
}) {
  let footer: string | null = null;
  if (variant === 'completed' && enteredAtIso) {
    try {
      const d = new Date(enteredAtIso);
      footer = `Entered ${d.toLocaleString()}`;
    } catch {
      footer = null;
    }
  } else if (variant === 'completed') {
    footer = 'Skipped';
  } else if (variant === 'current') {
    footer = 'Active now';
  } else if (variant === 'future' && gateText) {
    // gateText describes the condition that *advances into* this stage, so it
    // only reads correctly looking forward ("Next: <what unlocks this stage>").
    // Past stages have already cleared their gate, so showing it would be
    // redundant — their footer is the entry timestamp instead. Hence gateText
    // is intentionally surfaced for future stages only.
    footer = `Next: ${gateText}`;
  } else if (variant === 'branch') {
    footer = 'Branch state — needs human action';
  }
  return (
    <div className="text-left max-w-[14rem]">
      <div className="font-semibold leading-tight">{label}</div>
      {description && (
        <div className="mt-0.5 leading-snug opacity-90">{description}</div>
      )}
      {footer && (
        <div className="mt-1 text-[11px] leading-snug opacity-75">{footer}</div>
      )}
    </div>
  );
}

export function LifecycleTracker({
  status,
  caseType,
  orientation = 'horizontal',
  variant = 'full',
  events,
  showLabels = false,
  onStageClick,
}: LifecycleTrackerProps) {
  const lifecycle = useMemo(() => getLifecycleDefinition(caseType), [caseType]);
  const mainStages = lifecycle.mainStages;
  const branchStatusMap = useMemo<Record<string, { after: CaseStatus; label: string }>>(
    () => Object.fromEntries(
      lifecycle.branchStages.map((stage) => [
        stage.status,
        { after: stage.branchAfterStatus, label: stage.label },
      ]),
    ),
    [lifecycle],
  );

  // When rejected, show a shortened track ending at "Rejected" as a terminal state
  const stages = status === 'rejected'
    ? caseType === 'assistant_task' || caseType === 'observed'
      ? [
          ...mainStages.slice(0, mainStages.findIndex((stage) => stage.status === 'done')),
          { status: 'rejected' as CaseStatus, label: 'Rejected', shape: 'circle' as Shape },
        ]
      : [
          ...MAIN_STAGES.slice(0, MAIN_STAGES.findIndex(s => s.status === 'in_review') + 1),
          { status: 'rejected' as CaseStatus, label: 'Rejected', shape: 'circle' as Shape },
        ]
    : mainStages;

  const directIndex = stages.findIndex(s => s.status === status);
  const isBranch = status in branchStatusMap;
  // `isDone` drives the fully-muted (grey) treatment that is unique to the
  // success terminal. `isTerminal` (done OR rejected) only gates animation:
  // both terminals freeze the flow, but rejected keeps its red node/segments.
  const isDone = status === 'done';
  const isTerminal = isTerminalCaseStatus(status);
  const branchInfo = branchStatusMap[status];
  const effectiveIndex = directIndex >= 0
    ? directIndex
    : branchInfo ? stages.findIndex(s => s.status === branchInfo.after) : -1;
  const branchAfterIndex = branchInfo ? stages.findIndex((s) => s.status === branchInfo.after) : -1;
  const currentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to current station on mobile
  useEffect(() => {
    if (currentRef.current && scrollRef.current) {
      const container = scrollRef.current;
      const el = currentRef.current;
      const left = el.offsetLeft - container.offsetWidth / 2 + el.offsetWidth / 2;
      container.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
    }
  }, [effectiveIndex]);

  const getVariant = (i: number): Variant =>
    i < effectiveIndex ? 'completed' : i === effectiveIndex ? 'current' : 'future';

  const trackColorForSegment = (seg: number) =>
    isDone
      ? 'bg-gray-300 dark:bg-gray-600'
      : seg < effectiveIndex
      ? STAGE_COLORS[stages[seg]!.status].track
      : 'bg-gray-200 dark:bg-gray-700';

  const labelClass = (v: Variant, stageStatus: CaseStatus) => {
    if (isDone && v === 'current') return 'font-semibold text-gray-600 dark:text-gray-200';
    if (isDone) return 'text-gray-500 dark:text-gray-400';
    if (v === 'current') return `font-semibold ${STAGE_COLORS[stageStatus].label}`;
    if (v === 'completed') return 'text-gray-500 dark:text-gray-400';
    return 'text-gray-400 dark:text-gray-500';
  };

  const stationColorClass = (v: Variant, stageStatus: CaseStatus) => {
    if (isDone && v === 'current') return 'text-gray-500 dark:text-gray-300';
    if (isDone) return 'text-gray-400 dark:text-gray-500';
    return v === 'future'
      ? 'text-gray-300 dark:text-gray-600'
      : STAGE_COLORS[stageStatus].station;
  };

  const segmentIsAnimated = (seg: number) => !isTerminal && seg < effectiveIndex;
  const segmentIsActive = (seg: number) => !isTerminal && seg === effectiveIndex - 1;

  const branchColor = isBranch ? STAGE_COLORS[status] : null;

  /* Per-stage {eventId, createdAt} map. Memoised on the events array so we
     don't rebuild on every hover. Resolution logic lives in the exported pure
     `resolveEntryEventByStatus` (unit-tested directly). */
  const entryEventByStatus = useMemo(
    () => resolveEntryEventByStatus(stages, events),
    [events, stages],
  );

  /* ── Compact variant (case-cockpit hero, board cards, review-session) ──
     Lightweight: heartbeat on current station + shimmer on completed tracks.
     When `showLabels` is set (case-detail strip),
     stage labels render below each station and each station gets a rich
     hover/focus tooltip. Past stations whose entry event is present and
     `onStageClick` is provided become activatable buttons (click / Enter /
     Space) that scroll to the matching timeline event. Future stations are
     never interactive. The strip becomes horizontally scrollable so labels
     don't compress on viewports <900 px. */

  if (variant === 'compact') {
    return (
      <div
        className={
          showLabels
            ? 'overflow-x-auto scrollbar-none -mx-4 px-4 md:mx-0 md:px-0 select-none'
            : `flex items-center py-0.5 select-none ${isBranch ? 'pb-6' : ''}`
        }
      >
        <div
          className={
            showLabels
              ? `flex items-start min-w-max md:min-w-max py-0.5 ${isBranch ? 'pb-6' : ''}`
              : 'contents'
          }
        >
          {stages.map((stage, i) => {
            const v = getVariant(i);
            const isLast = i === stages.length - 1;
            const showBranch = isBranch && i === branchAfterIndex;
            const colors = STAGE_COLORS[stage.status];
            const trackIsCompleted = i < effectiveIndex;
            const meta = getLifecycleStageMeta(stage.status, caseType);
            const entry = entryEventByStatus[stage.status];
            const isClickable =
              showLabels && v === 'completed' && Boolean(entry) && Boolean(onStageClick);
            const tooltipLabel = showLabels ? (
              <StageTooltipBody
                label={stage.label}
                variant={v}
                description={meta?.description}
                gateText={meta?.gate}
                enteredAtIso={entry?.createdAt}
              />
            ) : null;

            const stationCore = (
              <div
                style={{
                  width: 16,
                  height: 16,
                }}
                className={`flex-shrink-0 flex items-center justify-center ${stationColorClass(v, stage.status)} ${v === 'current' && !isTerminal ? 'lifecycle-station-pulse' : ''}`}
                // Native title fallback — preserved for screen readers / when
                // the rich Tooltip is not active. The Tooltip primitive does
                // not add aria-describedby so this still anchors the SR text.
                title={showLabels ? undefined : stationTooltip(stage.label, v)}
                aria-label={stationTooltip(stage.label, v)}
                role="img"
              >
                {(() => {
                  const sz = v === 'current' || v === 'branch' ? 12 : 8;
                  return (
                    <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`} aria-hidden="true">
                      <StationSVG shape={stage.shape} size={sz} outlined={v === 'future'} />
                    </svg>
                  );
                })()}
              </div>
            );

            // Wrap the station so the click target spans the dot + label.
            // When clickable we render a real <button> for keyboard support;
            // otherwise a <div> so we don't add stray tab-stops.
            const stationCol = (() => {
              const colInner = (
                <>
                  {stationCore}
                  {showLabels && (
                    <span
                      className={`mt-1 text-[11px] whitespace-nowrap ${labelClass(v, stage.status)}`}
                    >
                      {stage.label}
                    </span>
                  )}
                </>
              );
              if (showLabels && isClickable && entry) {
                return (
                  <button
                    type="button"
                    onClick={() => onStageClick?.(entry.eventId)}
                    className="flex flex-col items-center cursor-pointer rounded-sm px-1 -mx-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
                    aria-label={`Jump to ${stage.label} in timeline`}
                  >
                    {colInner}
                  </button>
                );
              }
              if (showLabels) {
                return (
                  <div
                    className="flex flex-col items-center px-1 -mx-1"
                    // tabIndex 0 on the current station so keyboard users
                    // can focus and read the tooltip even when not
                    // interactive. Future stations remain non-tabbable.
                    tabIndex={v === 'current' ? 0 : -1}
                  >
                    {colInner}
                  </div>
                );
              }
              // Non-labelled compact: the station itself is the rendered
              // unit (no label column wrapper).
              return stationCore;
            })();

            return (
              <Fragment key={stage.status}>
                <div className="relative flex items-center justify-center">
                  {showLabels && tooltipLabel ? (
                    <Tooltip label={tooltipLabel} side="top">
                      {stationCol ?? stationCore}
                    </Tooltip>
                  ) : (
                    stationCol ?? stationCore
                  )}
                  {showBranch && branchInfo && branchColor && (
                    <div className="absolute top-full mt-0.5 flex flex-col items-center">
                      <div className={`w-[2px] h-2 rounded-full ${branchColor.track}`} />
                      <div
                        className={`flex-shrink-0 flex items-center justify-center ${branchColor.station}`}
                        style={{ width: 14, height: 14 }}
                        title={stationTooltip(branchInfo.label, 'branch')}
                        aria-label={stationTooltip(branchInfo.label, 'branch')}
                        role="img"
                      >
                        <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
                          <StationSVG shape="exclamation" size={12} />
                        </svg>
                      </div>
                    </div>
                  )}
                </div>
                {!isLast && (
                  trackIsCompleted && segmentIsAnimated(i) ? (
                    <div className={`flex-1 h-[2px] ${showLabels ? 'mt-[7px] min-w-[28px]' : 'min-w-[10px]'} rounded-full overflow-hidden`}>
                      <div
                        className={`w-full h-full rounded-full lifecycle-track-shimmer ${segmentIsActive(i) ? 'lifecycle-track-active' : ''}`}
                        style={{
                          '--lifecycle-track-color': colors.trackHex,
                          '--lifecycle-track-delay': `${i * 180}ms`,
                        } as TrackStyle}
                      />
                    </div>
                  ) : (
                    <div className={`flex-1 h-[2px] ${showLabels ? 'mt-[7px] min-w-[28px]' : 'min-w-[10px]'} rounded-full ${trackColorForSegment(i)}`} />
                  )
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
    );
  }

  /* ── Vertical variant (sidebar — heartbeat on station, no track shimmer) ── */

  if (orientation === 'vertical') {
    return (
      <div className="flex flex-col items-center py-1 select-none">
        {stages.map((stage, i) => {
          const v = getVariant(i);
          const isLast = i === stages.length - 1;
          const showBranch = isBranch && i === branchAfterIndex;
          const colors = STAGE_COLORS[stage.status];

          return (
            <Fragment key={stage.status}>
              <div className="relative flex items-center justify-center">
                <Station
                  shape={stage.shape}
                  variant={v}
                  colorClass={stationColorClass(v, stage.status)}
                  animate={v === 'current' && !isTerminal}
                  tooltip={stationTooltip(stage.label, v)}
                />
                {showBranch && branchInfo && branchColor && (
                  <div className="absolute left-full ml-1.5 flex items-center gap-1">
                    <div className={`w-2.5 h-[2px] rounded-full ${branchColor.track}`} />
                    <Station
                      shape="exclamation"
                      variant="branch"
                      colorClass={branchColor.station}
                      tooltip={stationTooltip(branchInfo.label, 'branch')}
                    />
                  </div>
                )}
              </div>
              {!isLast && (
                <div className={`w-[3px] h-3.5 rounded-full ${trackColorForSegment(i)}`} />
              )}
            </Fragment>
          );
        })}
      </div>
    );
  }

  /* ── Full horizontal variant (case detail — heartbeat + shimmer) ── */

  return (
    <div
      ref={scrollRef}
      className="overflow-x-auto scrollbar-none -mx-4 px-4 md:mx-0 md:px-0"
    >
      <div className="flex items-start min-w-max md:min-w-0 py-1">
        {stages.map((stage, i) => {
          const v = getVariant(i);
          const isLast = i === stages.length - 1;
          const isCurrent = i === effectiveIndex;
          const showBranch = isBranch && i === branchAfterIndex;
          const colors = STAGE_COLORS[stage.status];
          const trackIsCompleted = i < effectiveIndex;

          return (
            <Fragment key={stage.status}>
              <div
                ref={isCurrent ? currentRef : undefined}
                className="flex flex-col items-center"
              >
                <Station
                  shape={stage.shape}
                  variant={v}
                  colorClass={stationColorClass(v, stage.status)}
                  animate={v === 'current' && !isTerminal}
                  tooltip={stationTooltip(stage.label, v)}
                />
                <span className={`text-xs mt-1.5 whitespace-nowrap ${labelClass(v, stage.status)}`}>
                  {stage.label}
                </span>
                {showBranch && branchInfo && branchColor && (
                  <div className="flex flex-col items-center mt-1.5">
                    <div
                      className="h-3 w-[3px] rounded-full lifecycle-branch-track-shimmer"
                      style={{
                        '--lifecycle-track-color': branchColor.trackHex,
                      } as TrackStyle}
                    />
                    <div className="flex items-center gap-1 mt-0.5">
                      {/* Branch station is always static — only the main-line station animates */}
                      <Station
                        shape="exclamation"
                        variant="branch"
                        colorClass={branchColor.station}
                        tooltip={stationTooltip(branchInfo.label, 'branch')}
                      />
                      <span className={`text-xs font-semibold whitespace-nowrap ${branchColor.label}`}>
                        {branchInfo.label}
                      </span>
                    </div>
                  </div>
                )}
              </div>
              {!isLast && (
                trackIsCompleted && segmentIsAnimated(i) ? (
                  <ShimmerTrack hex={colors.trackHex} stageIndex={i} active={segmentIsActive(i)} />
                ) : (
                  <div className={`flex-1 h-[3px] mt-[8.5px] min-w-[28px] md:min-w-[20px] rounded-full ${trackColorForSegment(i)}`} />
                )
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
