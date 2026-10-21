'use client';

import { memo } from 'react';
import Link from 'next/link';
import type { ActivityEntry, ActivitySeverity } from '@arbitra/shared';
import { getActivityMeta } from '../../lib/activity-icons';
import {
  actorDisplayName,
  isDetectorActor,
  isSystemActorId,
  type ActorDisplay,
} from '../../lib/actor-display';
import { useUserMap } from '../../hooks/use-users';
import { ProjectBadge } from '../shared/project-badge';
import { RelativeTime } from '../shared/relative-time';
import { resolveRowSeverity } from '../../lib/activity-feed-presentation';

interface ActivityEntryRowProps {
  entry: ActivityEntry;
  /** Clicking the actor signature applies a filter via this callback. */
  onActorClick?: (clientName: string) => void;
  /** Clicking the project label applies a project filter via this callback. */
  onProjectClick?: (projectId: string) => void;
  /**
   * Clicking the summary of a workspace-event row (non case-scoped) fires this
   * callback. Intended to open a detail drawer; caller owns the drawer state.
   * Case-scoped rows ignore this callback and keep their existing link behavior.
   */
  onWorkspaceEventClick?: (entry: ActivityEntry) => void;
  /**
   * True when the row is the first occurrence of its kind in the visible
   * 24h window. Drives the small `new` glyph on the meta row.
   */
  isFirstOfDay?: boolean;
  /**
   * True for ~6s after a row arrives via a streaming push.
   * Drives the fresh-row glow class; the feed sets it from the ids that
   * arrived via the stream.
   */
  isFresh?: boolean;
}

function isLikelyFirebaseUid(id: string): boolean {
  return /^[A-Za-z0-9]{20,}$/.test(id);
}

/**
 * <ActivityRow> v2. Layout:
 *
 *   <SeverityDot /> <ActorAvatar />
 *   <Headline>{Actor} {verb} <CaseLink/></Headline>
 *   <MetaRow>{ProjectChip} {SourceChip?} {RelTime} {FirstOfDayBadge?}</MetaRow>
 *   <PreviewSnippet?/>
 *
 * Key differences from v1:
 *  - Actor is INSIDE the headline (not a sibling on the meta row).
 *  - Severity comes from the envelope's `entry.severity` (or, as a transitional
 *    fallback, finding subkind), not from `entry.kind`.
 *  - Detector vs human openedBy routing reads `entry.opened_by` from the
 *    envelope; the legacy `isDetectorActor(actor_user_id)` heuristic is kept
 *    only as a fallback for rows that haven't been backfilled yet.
 *  - The redundant "Lifecycle" chip is removed (it was on every other row,
 *    carrying zero information).
 */
function ActivityEntryRowImpl({
  entry,
  onActorClick,
  onProjectClick,
  onWorkspaceEventClick,
  isFirstOfDay,
  isFresh,
}: ActivityEntryRowProps) {
  const meta = getActivityMeta(entry.kind, entry.subkind);
  const isWorkspaceEvent = entry.kind === 'workspace_event' || !entry.case_id;
  const caseTitle = entry.case_title || entry.case_id;
  const summary = entry.summary ?? '';
  const href = entry.href || (isWorkspaceEvent ? '' : `/cases/${entry.case_id}`);

  const needsLookup =
    !!entry.actor_user_id &&
    !isSystemActorId(entry.actor_user_id) &&
    isLikelyFirebaseUid(entry.actor_user_id);
  const userMap = useUserMap(needsLookup ? [entry.actor_user_id!] : []);

  const summaryAsLink =
    entry.kind === 'finding' ||
    entry.kind === 'evidence' ||
    entry.kind === 'decision' ||
    entry.kind === 'comment';

  // Detector-routing — prefer the envelope's `opened_by`, fall back to the
  // legacy heuristic for older rows. This only applies to case_created
  // lifecycle events; webhook-opened cases stay on the normal path.
  const openedBy = entry.opened_by;
  const isDetectorOpenedCase =
    entry.kind === 'case_event' &&
    entry.subkind === 'case_created' &&
    (openedBy === 'detector' ||
      (openedBy === undefined && isDetectorActor(entry.actor_user_id)));

  const resolvedHumanName = (() => {
    if (!entry.actor_user_id) return undefined;
    const u = userMap[entry.actor_user_id];
    if (u) return u.display_name || u.email || undefined;
    return undefined;
  })();
  const display = actorDisplayName(
    entry.actor_user_id,
    entry.actor_metadata,
    resolvedHumanName,
  );
  const clientName = entry.actor_metadata?.client_name;
  const tooltip = display.secondary;

  const severity = resolveRowSeverity(entry);
  const sourceLabel = sourceChipLabel(entry);

  // Fresh-row glow + slide-down. The CSS classes are
  // defined in globals.css (`.activity-fresh-row` adds the orange-tinted
  // background ring; `.activity-slide-down` adds the 240ms slide-in). Both
  // are scoped to the data attribute so the styles only apply while the
  // streaming hook keeps `isFresh` true (TTL ~6s).
  const freshClass = isFresh ? 'activity-fresh-row activity-slide-down' : '';

  return (
    <li
      data-fresh={isFresh ? 'true' : undefined}
      className={`group relative flex items-start gap-3 py-3 px-2 hover:bg-surface-base dark:hover:bg-border-subtle/40 rounded-lg transition-colors ${freshClass}`}
    >
      <SeverityDot severity={severity} />

      <ActorAvatar
        display={display}
        clientName={clientName}
        actorUserId={entry.actor_user_id}
        meta={meta}
      />

      <div className="min-w-0 flex-1">
        {/*
          Headline — actor is the FIRST token, INSIDE the headline component. Verb / object follow the existing summary-driven
          rendering; `entry.summary` arrives already normalized from the
          backend (see `activity-service.ts` summarize functions). A future
          i18n pass would route the summary through a translation table.
        */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <ActorLabel
            display={display}
            clientName={clientName}
            tooltip={tooltip}
            onActorClick={onActorClick}
          />
          {isWorkspaceEvent ? (
            onWorkspaceEventClick ? (
              <button
                type="button"
                onClick={() => onWorkspaceEventClick(entry)}
                className="text-left text-gray-900 dark:text-gray-100 rounded hover:bg-surface-base/70 dark:hover:bg-border-subtle/60 -mx-1 px-1 transition-colors cursor-pointer"
                title={summary}
              >
                {summary}
              </button>
            ) : (
              <span className="text-gray-900 dark:text-gray-100">{summary}</span>
            )
          ) : isDetectorOpenedCase ? (
            <>
              <span className="text-gray-900 dark:text-gray-100">flagged</span>
              <Link
                href={href}
                className="font-medium italic text-accent hover:underline truncate max-w-[320px] md:max-w-[440px]"
                title={caseTitle}
              >
                {caseTitle}
              </Link>
            </>
          ) : (
            <CaseHeadline
              summary={summary}
              caseTitle={caseTitle}
              href={href}
              summaryAsLink={summaryAsLink}
            />
          )}
        </div>

        {/* Meta row — ProjectChip · SourceChip? · RelTime · FirstOfDayBadge? */}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          {!isWorkspaceEvent && entry.project_id && (entry.project_name || entry.project_id) && (
            onProjectClick ? (
              <ProjectBadge
                as="button"
                label={entry.project_name ?? entry.project_id}
                onClick={() => onProjectClick(entry.project_id!)}
                title={`Filter by project: ${entry.project_name ?? entry.project_id}`}
              />
            ) : (
              <ProjectBadge
                as="link"
                label={entry.project_name ?? entry.project_id}
                href={`/projects/${entry.project_id}`}
              />
            )
          )}
          {sourceLabel && (
            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-surface-base text-gray-600 dark:bg-border-subtle/40 dark:text-gray-300">
              {sourceLabel}
            </span>
          )}
          <RelativeTime timestamp={entry.timestamp} liveSeconds={isFresh} />
          {isFirstOfDay && (
            <span
              data-testid="first-of-day-badge"
              className="inline-flex items-center rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent dark:bg-accent/20 dark:text-accent-300"
              title="First event of this kind in the visible window"
            >
              new
            </span>
          )}
        </div>

        {entry.preview && (
          <div
            data-testid="preview-snippet"
            className="mt-1 text-xs text-gray-600 dark:text-gray-300 line-clamp-2"
          >
            {entry.preview}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Memoized so per-push re-renders only re-render the new row, not the entire
 * visible list (one DOM node per event). Equality is shallow on
 * props — `entry` is a stable object (the feed never mutates entries; new
 * pushes prepend), `isFresh`/`isFirstOfDay` are primitives, and the callback
 * props are kept stable by `useCallback` in the parent feed.
 */
export const ActivityEntryRow = memo(ActivityEntryRowImpl);

// ---------------------------------------------------------------------------
// Severity dot — row-start visual
//
// `info` / `low` render as a small neutral `·`; `medium` is an orange filled
// dot; `high`/`critical` is a red filled dot. The medium+ variants must be
// distinguishable from a 2-foot screen distance — we lean on size + saturated
// fill rather than a stroked outline, and add a subtle aria-label for AT.
// ---------------------------------------------------------------------------

function SeverityDot({ severity }: { severity: ActivitySeverity }) {
  if (severity === 'info' || severity === 'low') {
    return (
      <span
        data-testid="severity-dot"
        data-severity={severity}
        aria-hidden
        className="mt-2 inline-flex h-3 w-3 items-center justify-center text-gray-300 dark:text-gray-600 select-none"
      >
        ·
      </span>
    );
  }
  const colorClass =
    severity === 'medium'
      ? 'bg-orange-500'
      : 'bg-red-500';
  const ariaLabel =
    severity === 'medium'
      ? 'medium severity'
      : severity === 'high'
        ? 'high severity'
        : 'critical severity';
  return (
    <span
      data-testid="severity-dot"
      data-severity={severity}
      role="img"
      aria-label={ariaLabel}
      // 12px, fully filled, slight ring on the high/critical variants so the
      // dot reads even on a busy feed at viewing distance ("2-foot screen
      // distance" distinguishability). Box size (h-3 w-3)
      // matches the neutral `·` glyph above so all rows align identically.
      className={`mt-2 inline-block h-3 w-3 shrink-0 rounded-full ${colorClass} ${
        severity === 'critical' ? 'ring-2 ring-red-200 dark:ring-red-900/40' : ''
      }`}
    />
  );
}

// ---------------------------------------------------------------------------
// Actor avatar — agent icon for IDE / system actors, initials for humans.
//
// Reuses the kind-derived chip palette from `getActivityMeta` for visual
// consistency with the v1 row's category icon. We deliberately don't pull
// in the per-user real avatar URL here: the activity feed is a high-density
// surface and user-photo lookups would N+1 the request budget.
// ---------------------------------------------------------------------------

function ActorAvatar({
  display,
  clientName,
  actorUserId,
  meta,
}: {
  display: ActorDisplay;
  clientName: string | undefined;
  actorUserId: string | undefined;
  meta: ReturnType<typeof getActivityMeta>;
}) {
  const isAgentOrSystem = !!clientName || isSystemActorId(actorUserId);
  if (isAgentOrSystem) {
    return (
      <span
        data-testid="actor-avatar"
        data-actor-kind="agent"
        aria-hidden
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${meta.chipClass}`}
      >
        <span className="h-3.5 w-3.5 inline-flex [&_svg]:h-3.5 [&_svg]:w-3.5">
          {meta.icon}
        </span>
      </span>
    );
  }
  // Human — initials fallback.
  const initials = (() => {
    const label = display.label || '?';
    if (label === '—' || label === '?') return '?';
    return label
      .split(/\s+/)
      .filter((s) => s.length > 0)
      .slice(0, 2)
      .map((s) => s[0]!.toUpperCase())
      .join('');
  })();
  return (
    <span
      data-testid="actor-avatar"
      data-actor-kind="human"
      aria-hidden
      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-200 dark:bg-border-subtle text-[11px] font-semibold text-gray-700 dark:text-gray-200"
    >
      {initials || '?'}
    </span>
  );
}

/**
 * Source chip — `entry.opened_by` for case_created rows, otherwise the
 * normalized client name when distinct from the actor (e.g. an external
 * webhook attributed to the system actor). Returns undefined when there's
 * nothing meaningful to show — the activity-row no longer renders the
 * always-on "Lifecycle" chip.
 */
function sourceChipLabel(entry: ActivityEntry): string | undefined {
  if (entry.kind === 'case_event' && entry.subkind === 'case_created') {
    if (entry.opened_by === 'webhook') return 'webhook';
    if (entry.opened_by === 'detector') return 'detector';
  }
  if (entry.kind === 'workspace_event') {
    return entry.subkind ?? 'system';
  }
  return undefined;
}

function ActorLabel({
  display,
  clientName,
  tooltip,
  onActorClick,
}: {
  display: ActorDisplay;
  clientName: string | undefined;
  tooltip: string | undefined;
  onActorClick?: (clientName: string) => void;
}) {
  const className =
    'font-semibold text-gray-900 dark:text-gray-100';
  if (onActorClick && clientName) {
    return (
      <button
        type="button"
        onClick={() => onActorClick(clientName)}
        className={`${className} cursor-pointer rounded hover:bg-surface-base/70 dark:hover:bg-border-subtle/60 -mx-1 px-1 transition-colors`}
        title={tooltip ? `${tooltip} — filter by ${clientName}` : `Filter by ${clientName}`}
      >
        {display.label}
      </button>
    );
  }
  return (
    <span className={className} title={tooltip}>
      {display.label}
    </span>
  );
}

function CaseHeadline({
  summary,
  caseTitle,
  href,
  summaryAsLink,
}: {
  summary: string;
  caseTitle: string;
  href: string;
  summaryAsLink: boolean;
}) {
  const PLACEHOLDER = '{title}';
  const titleLink = (
    <Link
      href={href}
      className="font-medium italic text-accent hover:underline truncate max-w-[320px] md:max-w-[440px]"
      title={caseTitle}
    >
      {caseTitle}
    </Link>
  );
  if (summary.includes(PLACEHOLDER)) {
    const [head, tail] = summary.split(PLACEHOLDER);
    return (
      <>
        {head && (
          <span className="text-gray-900 dark:text-gray-100">{head.trim()}</span>
        )}
        {titleLink}
        {tail && (
          <span className="text-gray-900 dark:text-gray-100">{tail.trim()}</span>
        )}
      </>
    );
  }
  return (
    <>
      {summaryAsLink ? (
        <Link
          href={href}
          className="text-gray-900 dark:text-gray-100 hover:underline"
          title={summary}
        >
          {summary}
        </Link>
      ) : (
        <span className="text-gray-900 dark:text-gray-100">{summary}</span>
      )}
      {titleLink}
    </>
  );
}
