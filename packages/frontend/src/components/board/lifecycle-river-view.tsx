'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import type { Case, CaseStatus, Run } from '@arbitra/shared';
import {
  MAIN_STAGES,
  BRANCH_STAGES,
  STAGE_BADGE_COLORS,
  STAGE_COLORS,
  StationSVG,
} from '../../lib/lifecycle-stages';
import { RISK_PILL_COLORS } from '../../lib/risk-colors';
import { Tooltip } from '../shared/tooltip';
import { CaseListCard } from './case-list-card';
import { useAuth } from '../../providers/auth-provider';

// ── Types ────────────────────────────────────────────────────────────────────

interface LifecycleRiverViewProps {
  cases: Case[];
  casesByStatus: Record<string, Case[]>;
  projectMap: Record<string, string>;
  findingCounts: Record<string, number>;
  activeRunsByCase: Record<string, Run[]>;
}

// ── CaseChip ─────────────────────────────────────────────────────────────────

function CaseChip({
  caseData,
  activeRuns,
}: {
  caseData: Case;
  activeRuns?: Run[];
}) {
  const riskLevel = caseData.risk_level ?? 'low';
  const riskColor = RISK_PILL_COLORS[riskLevel];

  return (
    <Tooltip
      label={
        <span className="block">
          <span className="block">{caseData.title}</span>
          <span className="block mt-0.5 font-mono text-[10px] opacity-80">
            {caseData.case_id}
          </span>
        </span>
      }
    >
      <Link
        href={`/cases/${caseData.case_id}`}
        className="flex items-start gap-1.5 rounded-md border border-gray-200 dark:border-border-subtle bg-surface-raised px-2 py-1 text-xs text-gray-700 dark:text-gray-300 shadow-sm w-full min-w-0 group transition-all hover:shadow-md hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 mt-0.5 ${riskColor.dot}`}
          style={{ boxShadow: riskColor.glow }}
        />
        <span className="line-clamp-2 break-words text-[10px] leading-tight flex-1 min-w-0">
          {caseData.title}
        </span>
        {(activeRuns?.length ?? 0) > 0 && (
          <span className="w-2 h-2 rounded-full border border-blue-400 border-t-transparent animate-spin flex-shrink-0 mt-0.5" />
        )}
      </Link>
    </Tooltip>
  );
}

// ── ExpandableCaseList ────────────────────────────────────────────────────────

function ExpandableCaseList({
  cases,
  activeRunsByCase,
  maxVisible = 4,
}: {
  cases: Case[];
  activeRunsByCase: Record<string, Run[]>;
  maxVisible?: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const visibleCases = expanded ? cases : cases.slice(0, maxVisible);
  const overflowCount = cases.length - maxVisible;

  return (
    <div className="mt-2 flex flex-col gap-1 items-center w-full max-w-full min-w-0 overflow-hidden">
      {visibleCases.map((c) => (
        <CaseChip
          key={c.case_id}
          caseData={c}
          activeRuns={activeRunsByCase[c.case_id]}
        />
      ))}
      {overflowCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer transition-colors max-w-full truncate"
        >
          {expanded ? 'Show less' : `+${overflowCount} more`}
        </button>
      )}
    </div>
  );
}

// ── StationColumn ─────────────────────────────────────────────────────────────

function StationColumn({
  status,
  label,
  shape,
  cases,
  activeRunsByCase,
}: {
  status: CaseStatus;
  label: string;
  shape: import('../../lib/lifecycle-stages').Shape;
  cases: Case[];
  activeRunsByCase: Record<string, Run[]>;
}) {
  const colors = STAGE_COLORS[status];
  const hasCases = cases.length > 0;

  const isTerminal = status === 'done' || status === 'approved' || status === 'rejected';
  const variant = isTerminal ? 'completed' : hasCases ? 'current' : 'future';
  const size = hasCases ? 26 : 16;

  // Check if any case in this station has active runs
  const hasActiveRuns = hasCases && cases.some((c) => (activeRunsByCase[c.case_id]?.length ?? 0) > 0);

  return (
    <div
      className={`flex flex-col items-center relative z-10 min-w-0 flex-1 basis-0 py-2 px-1 rounded-lg transition-colors ${
        hasCases
          ? 'bg-surface-base dark:bg-surface-base/50'
          : 'opacity-75'
      }`}
    >
      {/* Top area -- count badge */}
      <div className="h-8 flex items-end justify-center pb-1">
        {hasCases && (
          <span
            className={`rounded-full text-xs px-2 py-0.5 font-bold tabular-nums ring-1 ring-inset ${STAGE_BADGE_COLORS[status]?.pill ?? 'bg-gray-100 text-gray-700 ring-gray-200'}`}
          >
            {cases.length}
          </span>
        )}
      </div>

      {/* Station marker */}
      <div
        className={`${colors.station} flex-shrink-0`}
        style={{
          animation:
            hasCases && !isTerminal
              ? 'pulse-glow 2s ease-in-out infinite'
              : undefined,
        }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <StationSVG
            shape={shape}
            size={size}
            outlined={variant === 'future'}
          />
        </svg>
      </div>

      {/* Stage label */}
      <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300 mt-1.5 text-center whitespace-nowrap">
        {label}
      </span>

      {/* Case chips */}
      {hasCases && (
        <ExpandableCaseList
          cases={cases}
          activeRunsByCase={activeRunsByCase}
        />
      )}
    </div>
  );
}

// ── ShimmerRiverTrackBar ─────────────────────────────────────────────────────

function ShimmerRiverTrackBar({ hexValues }: { hexValues: string[] }) {
  const gradientStops = hexValues
    .map((hex, i) => `${hex} ${Math.round((i / (hexValues.length - 1)) * 100)}%`)
    .join(', ');

  const baseGradient = `linear-gradient(to right, ${gradientStops})`;

  return (
    <div className="absolute top-[calc(2rem+10px)] left-4 right-4 h-1.5 z-0 rounded-full overflow-hidden hidden sm:block shadow-sm">
      {/* Base gradient */}
      <div
        className="absolute inset-0 rounded-full"
        style={{ background: baseGradient }}
      />
      {/* Shimmer overlay */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: 'linear-gradient(90deg, transparent 20%, rgba(255,255,255,0.35) 50%, transparent 80%)',
          backgroundSize: '200% 100%',
          animation: 'shimmer-flow 3s linear infinite',
        }}
      />
    </div>
  );
}

// ── MainTrack ─────────────────────────────────────────────────────────────────

function MainTrack({
  casesByStatus,
  activeRunsByCase,
}: {
  casesByStatus: Record<string, Case[]>;
  activeRunsByCase: Record<string, Run[]>;
}) {
  const hexValues = MAIN_STAGES.map((s) => STAGE_COLORS[s.status].trackHex);
  const rejectedCases = casesByStatus.rejected ?? [];
  const hasRejected = rejectedCases.length > 0;

  return (
    <div className="pt-2">
      {/* Single-row pipeline that SHRINKS the stations to fit — never wraps,
          never scrolls. `flex-nowrap` keeps all 9 stages on one line; each
          station is `flex-1 basis-0 min-w-0` so they share the width equally and
          compress as the viewport narrows, down to the <640px mobile-accordion
          cutoff. (Replaces the old `flex-wrap`, which broke the last stages onto
          a disconnected second row.) The shimmer track bar lives INSIDE this row
          so it always spans the full pipeline width. */}
      <div className="relative flex flex-nowrap gap-x-0">
        <ShimmerRiverTrackBar hexValues={hexValues} />
        {MAIN_STAGES.map((stage) => (
          <StationColumn
            key={stage.status}
            status={stage.status}
            label={stage.label}
            shape={stage.shape}
            cases={casesByStatus[stage.status] ?? []}
            activeRunsByCase={activeRunsByCase}
          />
        ))}
        {hasRejected && (
          <StationColumn
            key="rejected"
            status="rejected"
            label="Rejected"
            shape="exclamation"
            cases={rejectedCases}
            activeRunsByCase={activeRunsByCase}
          />
        )}
      </div>
    </div>
  );
}

// ── BranchTrack ───────────────────────────────────────────────────────────────

function BranchTrack({
  casesByStatus,
  activeRunsByCase,
}: {
  casesByStatus: Record<string, Case[]>;
  activeRunsByCase: Record<string, Run[]>;
}) {
  return (
    <div className="relative mt-3">
      {/* Vertical stem connector -- only on wider screens */}
      <div className="hidden sm:flex items-center justify-center mb-1">
        <div className="w-[3px] h-4 rounded-full overflow-hidden">
          <div
            className="w-full h-full"
            style={{
              background: `linear-gradient(180deg, ${STAGE_COLORS.needs_human_decision.trackHex} 0%, rgba(255,255,255,0.5) 50%, ${STAGE_COLORS.needs_human_decision.trackHex} 100%)`,
              backgroundSize: '100% 300%',
              animation: 'shimmer-vertical 1.9s linear infinite',
            }}
          />
        </div>
      </div>

      {/* Branch label with shimmer rails */}
      <div className="flex items-center gap-2 mb-2 px-1">
        <div className="h-px flex-1 bg-gradient-to-r from-corp-yellow/50 via-corp-orange/50 to-corp-red/50 dark:from-corp-yellow/30 dark:via-corp-orange/30 dark:to-corp-red/30 rounded-full overflow-hidden relative">
          <div
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(90deg, transparent 20%, rgba(255,255,255,0.3) 50%, transparent 80%)',
              backgroundSize: '200% 100%',
              animation: 'shimmer-flow 3s linear infinite',
            }}
          />
        </div>
        <span className="text-[9px] uppercase tracking-wider text-corp-orange dark:text-corp-orange font-semibold whitespace-nowrap">
          Needs attention
        </span>
        <div className="h-px flex-1 bg-gradient-to-r from-corp-orange/50 to-corp-red/50 dark:from-corp-orange/30 dark:to-corp-red/30 rounded-full overflow-hidden relative">
          <div
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(90deg, transparent 20%, rgba(255,255,255,0.3) 50%, transparent 80%)',
              backgroundSize: '200% 100%',
              animation: 'shimmer-flow 3s linear 0.5s infinite',
            }}
          />
        </div>
      </div>

      {/* Branch station columns -- responsive flex-wrap */}
      <div className="flex flex-wrap gap-2 justify-center">
        {BRANCH_STAGES.map((stage) => {
          const stageInfo = MAIN_STAGES.find((s) => s.status === stage.status);
          const shape = stageInfo?.shape ?? 'exclamation';
          const stCases = casesByStatus[stage.status] ?? [];
          const colors = STAGE_COLORS[stage.status];
          const hasCases = stCases.length > 0;
          const size = hasCases ? 22 : 14;
          const hasActiveRuns = hasCases && stCases.some((c) => (activeRunsByCase[c.case_id]?.length ?? 0) > 0);
          const stageIsTerminal =
            stage.status === 'done' ||
            stage.status === 'approved' ||
            stage.status === 'rejected';

          return (
            <div
              key={stage.status}
              className={`flex flex-col items-center flex-1 min-w-[100px] max-w-[200px] py-2 px-1 rounded-lg transition-colors ${
                hasCases ? 'bg-corp-yellow/10 dark:bg-corp-yellow/5' : 'opacity-75'
              }`}
            >
              {/* Count badge */}
              <div className="h-6 flex items-end justify-center pb-0.5">
                {hasCases && (
                  <span
                    className={`rounded-full text-[10px] px-1.5 py-0.5 font-bold tabular-nums ring-1 ring-inset ${STAGE_BADGE_COLORS[stage.status]?.pill ?? 'bg-corp-yellow/20 text-corp-dark ring-corp-yellow/50'}`}
                  >
                    {stCases.length}
                  </span>
                )}
              </div>

              {/* Station marker */}
              <div
                className={`${colors.station} flex-shrink-0`}
                style={{
                  animation:
                    hasCases && !stageIsTerminal
                      ? 'pulse-glow 2s ease-in-out infinite'
                      : undefined,
                }}
              >
                <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                  <StationSVG shape={shape} size={size} outlined={!hasCases} />
                </svg>
              </div>

              {/* Label */}
              <span className="text-[10px] font-medium text-gray-600 dark:text-gray-300 mt-1.5 text-center whitespace-nowrap">
                {stage.label}
              </span>

              {/* Case chips */}
              {hasCases && (
                <ExpandableCaseList
                  cases={stCases}
                  activeRunsByCase={activeRunsByCase}
                  maxVisible={3}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── RiverTrack ────────────────────────────────────────────────────────────────

function RiverTrack({
  label,
  caseCount,
  casesByStatus,
  activeRunsByCase,
}: {
  label: string | null;
  caseCount?: number;
  casesByStatus: Record<string, Case[]>;
  activeRunsByCase: Record<string, Run[]>;
}) {
  const hasBranchCases = BRANCH_STAGES.some(
    (stage) => (casesByStatus[stage.status] ?? []).length > 0
  );

  return (
    <div
      className={
        label
          ? 'rounded-xl border border-gray-200 dark:border-border-subtle bg-surface-raised p-4 shadow-sm'
          : ''
      }
    >
      {label && (
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{label}</h3>
          {caseCount != null && caseCount > 0 && (
            <span className="rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-xs px-2 py-0.5 font-medium tabular-nums">
              {caseCount}
            </span>
          )}
        </div>
      )}
      <div className={hasBranchCases ? 'pb-2' : 'pb-1'}>
        <MainTrack
          casesByStatus={casesByStatus}
          activeRunsByCase={activeRunsByCase}
        />
        {hasBranchCases && (
          <BranchTrack
            casesByStatus={casesByStatus}
            activeRunsByCase={activeRunsByCase}
          />
        )}
      </div>
    </div>
  );
}

// ── MobileStageAccordion ──────────────────────────────────────────────────────
//
// Mobile rule: do NOT render the horizontal stage strip
// at <600 px — too many micro-columns, titles collapse to "M…" pills. Render a
// vertical accordion of stages instead, with the existing list-card design as
// each stage's body. Stages that have cases assigned to the current user are
// expanded by default; the rest are collapsed.

const ALL_STAGES: { status: CaseStatus; label: string }[] = [
  ...MAIN_STAGES.map((s) => ({ status: s.status, label: s.label })),
  ...BRANCH_STAGES.map((s) => ({ status: s.status, label: s.label })),
  { status: 'rejected' as CaseStatus, label: 'Rejected' },
];

function StageAccordion({
  stage,
  cases,
  activeRunsByCase,
  defaultOpen,
}: {
  stage: { status: CaseStatus; label: string };
  cases: Case[];
  activeRunsByCase: Record<string, Run[]>;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // `useAuth` resolves the current user asynchronously (Firebase
  // `onAuthStateChanged` fires after the first render). When that resolution
  // flips `defaultOpen` to true for a stage the user owns, auto-expand it —
  // `useState(defaultOpen)` alone only reads the initial (pre-auth) value.
  // We deliberately only react to `defaultOpen → true` so a late auth signal
  // never force-collapses a stage the user opened by hand.
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const colors = STAGE_BADGE_COLORS[stage.status];
  const hasCases = cases.length > 0;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-raised overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-surface-base dark:hover:bg-border-subtle/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="flex items-center gap-2 min-w-0">
          <svg
            className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-300 truncate">
            {stage.label}
          </span>
          <span
            className={`rounded-full text-xs px-2 py-0.5 font-bold tabular-nums ring-1 ring-inset flex-shrink-0 ${colors?.pill ?? 'bg-gray-100 text-gray-700 ring-gray-200'}`}
          >
            {cases.length}
          </span>
        </span>
      </button>
      {open && (
        <div className="divide-y divide-gray-100 dark:divide-gray-800 border-t border-gray-100 dark:border-border-subtle">
          {hasCases ? (
            cases.map((c) => (
              <CaseListCard
                key={c.case_id}
                caseData={c}
                activeRuns={activeRunsByCase[c.case_id]}
              />
            ))
          ) : (
            <p className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500">
              No cases in this stage.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function MobileLifecycleAccordion({
  casesByStatus,
  activeRunsByCase,
  currentUserId,
}: {
  casesByStatus: Record<string, Case[]>;
  activeRunsByCase: Record<string, Run[]>;
  currentUserId: string | null;
}) {
  // Default-expand stages that contain cases owned by or assigned to the
  // current user. If no such stages exist (e.g. anon viewer), default-expand
  // any non-empty stage so the view is never blank-by-default.
  const stages = ALL_STAGES;
  const nonEmptyStages = stages.filter(
    (s) => (casesByStatus[s.status] ?? []).length > 0,
  );

  const myStageStatuses = useMemo(() => {
    if (!currentUserId) return new Set<CaseStatus>();
    const out = new Set<CaseStatus>();
    for (const s of stages) {
      const stageCases = casesByStatus[s.status] ?? [];
      const mine = stageCases.some(
        (c) =>
          c.owner_user_id === currentUserId ||
          c.assigned_reviewer_id === currentUserId,
      );
      if (mine) out.add(s.status);
    }
    return out;
  }, [stages, casesByStatus, currentUserId]);

  const fallbackOpenStatuses = useMemo(() => {
    if (myStageStatuses.size > 0) return null;
    return new Set(nonEmptyStages.map((s) => s.status));
  }, [myStageStatuses, nonEmptyStages]);

  return (
    <div className="flex flex-col gap-2">
      {stages.map((stage) => {
        const stageCases = casesByStatus[stage.status] ?? [];
        // Empty stages stay rendered but collapsed, so the user can still
        // see the full pipeline at a glance.
        const isMine = myStageStatuses.has(stage.status);
        const fallbackOpen =
          fallbackOpenStatuses?.has(stage.status) ?? false;
        const defaultOpen = isMine || fallbackOpen;
        return (
          <StageAccordion
            key={stage.status}
            stage={stage}
            cases={stageCases}
            activeRunsByCase={activeRunsByCase}
            defaultOpen={defaultOpen}
          />
        );
      })}
    </div>
  );
}

// ── LifecycleRiverView (exported default) ─────────────────────────────────────

export default function LifecycleRiverView({
  cases,
  casesByStatus,
  projectMap,
  findingCounts,
  activeRunsByCase,
}: LifecycleRiverViewProps) {
  const [groupByProject, setGroupByProject] = useState(false);
  const { user } = useAuth();
  const currentUserId = user?.uid ?? null;

  const groups = useMemo(() => {
    if (!groupByProject) {
      return [{ label: null as string | null, casesByStatus, caseCount: cases.length }];
    }

    // Partition cases by project_id
    const byProject: Record<string, Case[]> = {};
    for (const c of cases) {
      const pid = c.project_id ?? '__none__';
      if (!byProject[pid]) byProject[pid] = [];
      byProject[pid]!.push(c);
    }

    return Object.entries(byProject).map(([pid, projectCases]) => {
      const grouped: Record<string, Case[]> = {};
      for (const status of Object.keys(casesByStatus)) {
        grouped[status] = projectCases.filter((c) => c.status === status);
      }
      const projectName = projectMap[pid] ?? pid;
      return { label: projectName, casesByStatus: grouped, caseCount: projectCases.length };
    });
  }, [groupByProject, cases, casesByStatus, projectMap]);

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4 px-1 py-2 border-b border-gray-100 dark:border-border-subtle">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 tabular-nums">
          {cases.length} case{cases.length !== 1 ? 's' : ''} in pipeline
        </span>
        <button
          type="button"
          onClick={() => setGroupByProject((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition-all ${
            groupByProject
              ? 'bg-accent-700 text-white border-accent hover:bg-accent-800 shadow-sm'
              : 'bg-surface-raised text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-surface-base dark:hover:bg-gray-700'
          }`}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="1" width="6" height="6" rx="1" />
            <rect x="9" y="1" width="6" height="6" rx="1" />
            <rect x="1" y="9" width="6" height="6" rx="1" />
            <rect x="9" y="9" width="6" height="6" rx="1" />
          </svg>
          Group by project
        </button>
      </div>

      {/* Desktop / tablet: river tracks. Hidden on <sm to avoid the
          "9 horizontal micro-columns" failure mode on phones. */}
      <div className="hidden sm:block space-y-6">
        {groups.map((group, i) => (
          <RiverTrack
            key={group.label ?? i}
            label={group.label}
            caseCount={group.caseCount}
            casesByStatus={group.casesByStatus}
            activeRunsByCase={activeRunsByCase}
          />
        ))}
      </div>

      {/* Mobile (<sm ≈ 640 px): vertical accordion of stages, list-card
          bodies. The list view at 390 px is fine, so we
          reuse its card design for each stage's body. */}
      <div className="sm:hidden space-y-4" data-testid="lifecycle-mobile-accordion">
        {groups.map((group, i) => (
          <div key={`m-${group.label ?? i}`}>
            {group.label && (
              <div className="flex items-center gap-2 mb-2 px-1">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                  {group.label}
                </h3>
                {group.caseCount != null && group.caseCount > 0 && (
                  <span className="rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-xs px-2 py-0.5 font-medium tabular-nums">
                    {group.caseCount}
                  </span>
                )}
              </div>
            )}
            <MobileLifecycleAccordion
              casesByStatus={group.casesByStatus}
              activeRunsByCase={activeRunsByCase}
              currentUserId={currentUserId}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
