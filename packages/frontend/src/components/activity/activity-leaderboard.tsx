'use client';

import useSWR from 'swr';
import type {
  ActivityLeaderboardRow,
  ActivityLeaderboardWindow,
  ActivityProjectLeaderboardRow,
} from '@arbitra/shared';
import {
  describeLeaderboardMix,
  getLeaderboardContributionSegments,
  getLeaderboardShare,
  getLeaderboardSourceDescriptor,
  getLeaderboardSourceLabel,
  getProjectDisplayName,
  splitActivitySourceRows,
  type LeaderboardContributionSegment,
} from '../../lib/activity-leaderboard-presentation';
import { api } from '../../lib/api-client';
import type { FilterDelta } from '../../lib/activity-url-state';

const WINDOW_LABELS: Record<ActivityLeaderboardWindow, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
};

interface ActivityLeaderboardProps {
  window: ActivityLeaderboardWindow;
  onWindowChange: (window: ActivityLeaderboardWindow) => void;
  /**
   * Right-rail → feed wiring. When provided, every clickable
   * surface in this card emits a {@link FilterDelta} the parent merges into
   * the URL filter. When omitted, click targets render as plain text — the
   * card stays usable in surfaces that don't host a URL-bound feed.
   */
  onFilterClick?: (delta: FilterDelta) => void;
}

export function ActivityLeaderboard({
  window,
  onWindowChange,
  onFilterClick,
}: ActivityLeaderboardProps) {
  const { data } = useSWR(
    ['activity:leaderboard', window],
    () => api.activity.leaderboard(window),
    { refreshInterval: 30_000, revalidateOnFocus: true, keepPreviousData: true },
  );

  const rows = data?.rows ?? [];
  const projectRows = data?.project_rows ?? [];
  const { clientRows, fallbackRows } = splitActivitySourceRows(rows);
  const totalEvents = rows.reduce((sum, row) => sum + row.counts.total, 0);
  const detectedTotal = clientRows.reduce((sum, row) => sum + row.counts.total, 0);
  const caseScopedTotal = projectRows.reduce((sum, row) => sum + row.counts.total, 0);

  return (
    <section className="bg-surface-raised rounded-xl border border-gray-200 dark:border-border-subtle">
      <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent/80">
            Activity overview
          </p>
          <h2 className="mt-1 text-base font-semibold text-gray-900 dark:text-gray-100">
            Hot Projects + Clients
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {totalEvents > 0
              ? `${totalEvents} actions in the last ${WINDOW_LABELS[window]}`
              : `Context around the live feed for the last ${WINDOW_LABELS[window]}.`}
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-md border border-gray-200 p-0.5 dark:border-border-subtle">
          {(['24h', '7d', '30d'] as ActivityLeaderboardWindow[]).map((value) => {
            const active = value === window;
            return (
              <button
                key={value}
                type="button"
                onClick={() => onWindowChange(value)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  active
                    ? 'bg-accent-700 text-white'
                    : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
                }`}
                aria-pressed={active}
              >
                {WINDOW_LABELS[value]}
              </button>
            );
          })}
        </div>
      </header>

      <div className="border-t border-gray-100 px-4 py-4 dark:border-border-subtle">
        {data === undefined ? (
          <div aria-busy="true" aria-label="Loading activity overview" className="space-y-4">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="h-28 rounded-xl border border-gray-200 bg-surface-base/70 animate-pulse dark:border-border-subtle dark:bg-surface-base/30"
              />
            ))}
          </div>
        ) : totalEvents === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            No activity in this window yet.
          </p>
        ) : (
          <div className="space-y-4">
            <section className="rounded-xl border border-gray-200 bg-surface-base/70 p-4 dark:border-border-subtle dark:bg-surface-base/20">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    Hot Projects
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Peer comparison by where the work is happening.
                  </p>
                </div>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {projectRows.length} active
                </span>
              </div>

              {projectRows.length === 0 ? (
                <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                  No case-scoped activity in this window.
                </p>
              ) : (
                <ol className="mt-3 space-y-3">
                  {projectRows.slice(0, 3).map((row, index) => (
                    <ProjectRow
                      key={row.project_id}
                      row={row}
                      rank={index + 1}
                      totalEvents={caseScopedTotal}
                      onFilterClick={onFilterClick}
                    />
                  ))}
                </ol>
              )}
            </section>

            <AttributionCoverageCard
              totalEvents={totalEvents}
              detectedTotal={detectedTotal}
              fallbackRows={fallbackRows}
              onFilterClick={onFilterClick}
            />

            <section className="rounded-xl border border-gray-200 bg-surface-base/70 dark:border-border-subtle dark:bg-surface-base/20">
              <div className="border-b border-gray-100 px-4 py-3 dark:border-border-subtle">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Detected Clients
                </h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Ranked only within actions that carried client metadata.
                </p>
              </div>

              {clientRows.length === 0 ? (
                <p className="px-4 py-4 text-sm text-gray-500 dark:text-gray-400">
                  No client-tagged activity in this window.
                </p>
              ) : (
                <ol className="divide-y divide-gray-100 dark:divide-border-subtle">
                  {clientRows.map((row, index) => (
                    <ClientRow
                      key={leaderboardCardKey(row, index)}
                      row={row}
                      rank={index + 1}
                      detectedTotal={detectedTotal}
                      onFilterClick={onFilterClick}
                    />
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </div>
    </section>
  );
}

function leaderboardCardKey(row: ActivityLeaderboardRow, index: number): string {
  return `${row.client_name}|${row.client_version ?? ''}|${row.model ?? ''}|${index}`;
}

function ProjectRow({
  row,
  rank,
  totalEvents,
  onFilterClick,
}: {
  row: ActivityProjectLeaderboardRow;
  rank: number;
  totalEvents: number;
  onFilterClick?: (delta: FilterDelta) => void;
}) {
  const segments = getLeaderboardContributionSegments(row);
  const share = getLeaderboardShare(row, totalEvents);
  const projectId = row.project_id;
  const projectLabel = getProjectDisplayName(row);

  // The project label / total count both pin the project; bar segments and
  // metric chips additionally pin the matching kind so the user lands on a
  // narrowed slice.
  const handleProjectClick =
    projectId && onFilterClick ? () => onFilterClick({ toggleProject: projectId }) : undefined;

  return (
    <li
      className="rounded-lg border border-gray-200/80 bg-white/70 p-3 dark:border-border-subtle dark:bg-surface-base/30"
      data-testid="leaderboard-project-row"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-700 dark:bg-surface-raised dark:text-gray-200">
              {rank}
            </span>
            {handleProjectClick ? (
              <button
                type="button"
                onClick={handleProjectClick}
                className="truncate text-left text-sm font-semibold text-gray-900 hover:text-accent dark:text-gray-100 dark:hover:text-accent-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded"
                title={`Filter feed by project: ${projectLabel}`}
              >
                {projectLabel}
              </button>
            ) : (
              <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                {projectLabel}
              </p>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {row.active_cases} active case{row.active_cases === 1 ? '' : 's'}
          </p>
        </div>
        <div className="text-right">
          {handleProjectClick ? (
            <button
              type="button"
              onClick={handleProjectClick}
              className="text-lg font-semibold text-gray-900 hover:text-accent dark:text-gray-100 dark:hover:text-accent-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded"
              title={`Filter feed by project: ${projectLabel}`}
              aria-label={`${row.counts.total} actions on ${projectLabel} — click to filter feed`}
            >
              {row.counts.total}
            </button>
          ) : (
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {row.counts.total}
            </p>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400">{share}% share</p>
        </div>
      </div>

      <p className="mt-3 text-xs text-gray-600 dark:text-gray-300">{describeLeaderboardMix(row)}</p>
      <ContributionBar
        segments={segments}
        compact
        onSegmentClick={
          projectId && onFilterClick
            ? (segment) =>
                onFilterClick({
                  toggleProject: projectId,
                  ...(segment.activityKind ? { toggleKind: segment.activityKind } : {}),
                })
            : undefined
        }
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {segments.slice(0, 3).map((segment) => (
          <MetricChip
            key={segment.label}
            segment={segment}
            onClick={
              projectId && onFilterClick && segment.activityKind
                ? () =>
                    onFilterClick({
                      toggleProject: projectId,
                      toggleKind: segment.activityKind!,
                    })
                : undefined
            }
          />
        ))}
      </div>
    </li>
  );
}

function AttributionCoverageCard({
  totalEvents,
  detectedTotal,
  fallbackRows,
  onFilterClick,
}: {
  totalEvents: number;
  detectedTotal: number;
  fallbackRows: ActivityLeaderboardRow[];
  onFilterClick?: (delta: FilterDelta) => void;
}) {
  const fallbackTotal = Math.max(totalEvents - detectedTotal, 0);
  const detectedShare = getSafePercent(detectedTotal, totalEvents);
  const fallbackShare = getSafePercent(fallbackTotal, totalEvents);

  return (
    <section
      className="rounded-xl border border-gray-200 bg-surface-base/70 p-4 dark:border-border-subtle dark:bg-surface-base/20"
      data-testid="leaderboard-attribution"
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent/80">
        Attribution coverage
      </p>
      <div className="mt-3 flex items-end justify-between gap-4">
        <div>
          <p className="text-3xl font-semibold leading-none text-gray-900 dark:text-gray-100">
            {detectedShare}%
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {detectedTotal} of {totalEvents} actions carried a client signature
          </p>
        </div>
        {onFilterClick ? (
          <button
            type="button"
            onClick={() => onFilterClick({ attributionMissing: true })}
            className="text-right text-xs text-gray-500 hover:text-accent dark:text-gray-400 dark:hover:text-accent-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded"
            title="Filter feed to un-attributed actions (Raw mode)"
            aria-label={`${fallbackShare}% fallback — click to filter feed to un-attributed actions`}
            data-testid="leaderboard-attribution-fallback"
          >
            <span className="block">{fallbackShare}% fallback</span>
            <span className="block">not ranked against clients</span>
          </button>
        ) : (
          <div className="text-right text-xs text-gray-500 dark:text-gray-400">
            <p>{fallbackShare}% fallback</p>
            <p>not ranked against clients</p>
          </div>
        )}
      </div>

      <div className="mt-4 overflow-hidden rounded-full bg-gray-100 dark:bg-surface-raised h-2.5">
        <div className="flex h-full w-full">
          <div className="bg-accent" style={{ width: `${detectedShare}%` }} />
          <div className="bg-slate-300 dark:bg-slate-600/70" style={{ width: `${fallbackShare}%` }} />
        </div>
      </div>

      {fallbackRows.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {fallbackRows.map((row) => (
            <li
              key={`${row.source_kind}-${row.client_name}`}
              className="flex items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {getLeaderboardSourceLabel(row)}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {getLeaderboardSourceDescriptor(row)}
                </p>
              </div>
              <span className="shrink-0 text-sm font-semibold text-gray-900 dark:text-gray-100">
                {row.counts.total}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          All visible actions carried client metadata.
        </p>
      )}
    </section>
  );
}

function ClientRow({
  row,
  rank,
  detectedTotal,
  onFilterClick,
}: {
  row: ActivityLeaderboardRow;
  rank: number;
  detectedTotal: number;
  onFilterClick?: (delta: FilterDelta) => void;
}) {
  const segments = getLeaderboardContributionSegments(row);
  const share = getLeaderboardShare(row, detectedTotal);
  const sourceLabel = getLeaderboardSourceLabel(row);
  // Client rows always carry source_kind='client' + a client_name (see
  // splitActivitySourceRows). The actor token is the raw client_name —
  // matches the URL schema's `actors` semantics (`agents` or client_name).
  const actorToken = row.source_kind === 'client' ? row.client_name : undefined;
  const handleClientClick =
    actorToken && onFilterClick ? () => onFilterClick({ toggleActor: actorToken }) : undefined;

  return (
    <li className="px-4 py-3" data-testid="leaderboard-client-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-700 dark:bg-surface-raised dark:text-gray-200">
              {rank}
            </span>
            {handleClientClick ? (
              <button
                type="button"
                onClick={handleClientClick}
                className="truncate text-left text-sm font-semibold text-gray-900 hover:text-accent dark:text-gray-100 dark:hover:text-accent-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded"
                title={`Filter feed by client: ${sourceLabel}`}
              >
                {sourceLabel}
              </button>
            ) : (
              <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                {sourceLabel}
              </p>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
            {getLeaderboardSourceDescriptor(row)}
          </p>
        </div>
        <div className="text-right">
          {handleClientClick ? (
            <button
              type="button"
              onClick={handleClientClick}
              className="text-lg font-semibold text-gray-900 hover:text-accent dark:text-gray-100 dark:hover:text-accent-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded"
              title={`Filter feed by client: ${sourceLabel}`}
              aria-label={`${row.counts.total} actions from ${sourceLabel} — click to filter feed`}
            >
              {row.counts.total}
            </button>
          ) : (
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {row.counts.total}
            </p>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400">{share}% of detected</p>
        </div>
      </div>

      <p className="mt-3 text-xs text-gray-600 dark:text-gray-300">{describeLeaderboardMix(row)}</p>
      <ContributionBar
        segments={segments}
        compact
        onSegmentClick={
          actorToken && onFilterClick
            ? (segment) =>
                onFilterClick({
                  toggleActor: actorToken,
                  ...(segment.activityKind ? { toggleKind: segment.activityKind } : {}),
                })
            : undefined
        }
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {segments.slice(0, 3).map((segment) => (
          <MetricChip
            key={segment.label}
            segment={segment}
            onClick={
              actorToken && onFilterClick && segment.activityKind
                ? () =>
                    onFilterClick({
                      toggleActor: actorToken,
                      toggleKind: segment.activityKind!,
                    })
                : undefined
            }
          />
        ))}
      </div>
    </li>
  );
}

function ContributionBar({
  segments,
  compact = false,
  onSegmentClick,
}: {
  segments: LeaderboardContributionSegment[];
  compact?: boolean;
  /**
   * When provided, each non-zero bar segment becomes a click target. Clicking
   * the orange portion of the Hot Projects bar filters to that project's
   * mixed activity; this is the wiring that makes that work for every
   * segment, not just the orange one.
   */
  onSegmentClick?: (segment: LeaderboardContributionSegment) => void;
}) {
  const interactive = !!onSegmentClick;
  return (
    <div
      className={`mt-3 overflow-hidden rounded-full bg-gray-100 dark:bg-surface-raised ${
        compact ? 'h-2' : 'h-2.5'
      }`}
      // Decorative when non-interactive; otherwise the segment buttons own
      // their own labels and the bar itself stays unannounced.
      aria-hidden={interactive ? undefined : true}
    >
      <div className="flex h-full w-full">
        {segments.map((segment) =>
          interactive && segment.share > 0 ? (
            <button
              key={segment.label}
              type="button"
              onClick={() => onSegmentClick!(segment)}
              className={`${segment.barClassName} hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60`}
              style={{ width: `${segment.share}%` }}
              title={`Filter feed: ${segment.label} (${segment.value})`}
              aria-label={`Filter feed by ${segment.label.toLowerCase()}`}
              data-testid="leaderboard-bar-segment"
            />
          ) : (
            <div
              key={segment.label}
              className={segment.barClassName}
              style={{ width: `${segment.share}%` }}
            />
          ),
        )}
      </div>
    </div>
  );
}

function MetricChip({
  segment,
  onClick,
}: {
  segment: LeaderboardContributionSegment;
  onClick?: () => void;
}) {
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${segment.chipClassName}`}
        title={`Filter feed by ${segment.label.toLowerCase()}`}
        data-testid="leaderboard-metric-chip"
      >
        <span>{segment.label}</span>
        <span className="font-semibold">{segment.value}</span>
      </button>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${segment.chipClassName}`}
    >
      <span>{segment.label}</span>
      <span className="font-semibold">{segment.value}</span>
    </span>
  );
}

function getSafePercent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}
