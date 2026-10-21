'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { AnimatePresence, motion } from 'framer-motion';
import type { ActivityEntry } from '@arbitra/shared';
import EmptyState from '../shared/empty-state';
import { ActivityEntryRow } from './activity-entry-row';
import { HeartbeatTile } from './heartbeat-tile';
import { SkeletonRow } from '../shared/skeleton';
import { useActivityFeed, type ActivityFilters } from '../../hooks/use-activity-feed';
import {
  buildActivityFeedItems,
  deriveServerFetchFilters,
  isSignalEntry,
  DEFAULT_MULTI_FILTER,
  type ActivityFeedClusterItem,
  type ActivityFeedStreakItem,
  type MultiActivityFilter,
} from '../../lib/activity-feed-presentation';
import { ActivityFilterBar } from './activity-filter-bar';
import { api } from '../../lib/api-client';
import { WorkspaceEventDrawer } from './workspace-event-drawer';
import { ProjectBadge } from '../shared/project-badge';
import { RelativeTime } from '../shared/relative-time';
import { NewEventsPill } from './new-events-pill';
import { ActiveActorsLozenge } from './active-actors-lozenge';
import { StreamingSummaryLine } from './streaming-summary-line';
import { WhatNeedsMeStrip, type WhatNeedsMeFilter } from './what-needs-me-strip';

// Activity entry `id` for workspace events is prefixed with
// `workspace_event:` (see `activity-service.ts`). Strip the prefix to recover
// the raw `event_id` the drawer needs. Returns null for non-workspace rows
// so the extractor is safe to call anywhere.
function workspaceEventIdFromEntryId(id: string): string | null {
  const prefix = 'workspace_event:';
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

interface ActivityFeedProps {
  /**
   * Optional override: when provided, clicking the summary of a workspace-
   * event row fires this callback instead of opening the built-in detail
   * drawer. Case-scoped rows ignore this prop. Most callers should leave it
   * undefined and let the feed own its own drawer state — it keeps the
   * feature self-contained at call sites.
   */
  onWorkspaceEventClick?: (entry: ActivityEntry) => void;
  /**
   * Lifted multi-filter — when supplied (e.g. by the URL-syncing /activity
   * page), the feed becomes a controlled component over it. When omitted, the
   * feed manages its own internal filter state (preserves the previous
   * behaviour for callers that haven't migrated).
   */
  filter?: MultiActivityFilter;
  onFilterChange?: (next: MultiActivityFilter) => void;
}

export function ActivityFeed({
  onWorkspaceEventClick,
  filter: filterProp,
  onFilterChange,
}: ActivityFeedProps = {}) {
  // Internal multi-filter state for callers that don't lift it. Source of
  // truth flips to props when `filter` is supplied (controlled mode).
  const [internalFilter, setInternalFilter] = useState<MultiActivityFilter>(DEFAULT_MULTI_FILTER);
  const isControlled = filterProp !== undefined;
  const filter = filterProp ?? internalFilter;
  const setFilter = useCallback(
    (next: MultiActivityFilter) => {
      if (isControlled) onFilterChange?.(next);
      else setInternalFilter(next);
    },
    [isControlled, onFilterChange],
  );

  // Server-side narrowing via deriveServerFetchFilters — see that function for
  // the single-actor / multi-actor (wide-fetch) logic.
  const fetchFilters: ActivityFilters = useMemo(
    () => deriveServerFetchFilters(filter),
    [filter],
  );

  const [expandedClusters, setExpandedClusters] = useState<Record<string, boolean>>({});
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  // Track scroll position so the streaming hook knows whether to insert
  // pushed entries at the top of the visible list (we're parked at the top
  // and the user expects to see new rows arrive) or queue them behind the
  // "N new" pill (we've scrolled past the top and the user expects scroll
  // stability). 32px slack absorbs accidental scrolls.
  const SCROLL_QUEUE_THRESHOLD_PX = 32;
  const [isScrolledFromTop, setIsScrolledFromTop] = useState(false);
  const feedTopRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onScroll = () => {
      setIsScrolledFromTop(window.scrollY > SCROLL_QUEUE_THRESHOLD_PX);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const {
    entries,
    isLoading,
    error,
    loadMore,
    freshIds,
    pendingCount,
    flushPending,
    feedStatus,
    pollIntervalMs,
  } = useActivityFeed({
    filters: fetchFilters,
    streaming: true,
    queuePending: isScrolledFromTop,
  });

  const handleFlushPending = useCallback(() => {
    flushPending();
    if (typeof window !== 'undefined') {
      // Honor reduced-motion: behavior 'auto' there, 'smooth' otherwise.
      const reduce =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (feedTopRef.current) {
        feedTopRef.current.scrollIntoView({
          behavior: reduce ? 'auto' : 'smooth',
          block: 'start',
        });
      } else {
        window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      }
    }
  }, [flushPending]);

  const handleWorkspaceEventClick = useCallback(
    (entry: ActivityEntry) => {
      if (onWorkspaceEventClick) {
        onWorkspaceEventClick(entry);
        return;
      }
      const id = workspaceEventIdFromEntryId(entry.id);
      if (id) setSelectedEventId(id);
    },
    [onWorkspaceEventClick],
  );

  // Unique client_name values from visible entries — populates Who dropdown.
  // `entries` gets a new array ref on every streamed push, so memoizing the
  // option array directly on `entries` reallocates it every push even when the
  // *distinct* client set is unchanged. Derive a stable content key (sorted
  // distinct names, JSON-encoded so values with spaces stay lossless) and
  // memoize the array on that key — its identity then changes only when the
  // underlying set actually changes (item 17).
  const clientOptionsKey = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      if (e.actor_metadata?.client_name) set.add(e.actor_metadata.client_name);
    }
    return JSON.stringify([...set].sort());
  }, [entries]);
  const clientOptions = useMemo(
    () => JSON.parse(clientOptionsKey) as string[],
    [clientOptionsKey],
  );

  // Project list for Where dropdown — full accessible-project list so users can
  // pre-filter for projects with no recent activity. Falls back to entry-derived.
  const { data: projectsData } = useSWR('activity-feed:projects', () => api.projects.list());
  // Same per-push-churn fix as clientOptions: build a stable content key for
  // the entry-derived fallback (sorted id+name pairs, JSON-encoded). When
  // projectsData is present the entry key is ignored, so streamed pushes don't
  // reallocate the option array at all.
  const entryProjectOptionsKey = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of entries) {
      if (e.project_id && !seen.has(e.project_id)) {
        seen.set(e.project_id, e.project_name ?? e.project_id);
      }
    }
    const pairs = [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return JSON.stringify(pairs);
  }, [entries]);
  const projectOptions = useMemo(() => {
    if (projectsData?.projects?.length) {
      return projectsData.projects
        .map((p) => ({ id: p.project_id, name: p.name ?? p.project_id }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    const pairs = JSON.parse(entryProjectOptionsKey) as { id: string; name: string }[];
    return pairs.sort((a, b) => a.name.localeCompare(b.name));
  }, [entryProjectOptionsKey, projectsData]);

  // Row-level callbacks: clicking actor / project surfaces in-feed adds them
  // as filters via the multi-select. Click toggles ON; remove via the chip.
  const handleActorClick = useCallback(
    (clientName: string) => {
      if (filter.actors.includes(clientName)) return;
      setFilter({ ...filter, actors: [...filter.actors, clientName] });
    },
    [filter, setFilter],
  );

  const handleProjectFilter = useCallback(
    (projectId: string) => {
      if (filter.projects.includes(projectId)) return;
      setFilter({ ...filter, projects: [...filter.projects, projectId] });
    },
    [filter, setFilter],
  );

  // "What needs me" chip handler. Translates each chip's filter shape onto the
  // MultiActivityFilter. The mapping is intentionally lossy for chips that
  // relied on clientFilters.caseDetectorOpened (that axis doesn't exist in
  // MultiActivityFilter); those fall back to the nearest kind filter.
  const handleApplyNeedsMeFilter = useCallback(
    (needsMeFilter: WhatNeedsMeFilter) => {
      if ('needsMe' in needsMeFilter) {
        // No dedicated server-side "needsMe" filter on the feed yet — pin
        // the user to Decisions, where their assigned items surface.
        setFilter({ ...DEFAULT_MULTI_FILTER, kinds: ['decision'] });
        return;
      }
      if ('openedBy' in needsMeFilter) {
        // Detector-opened rows — closest approximation in MultiActivityFilter
        // is lifecycle kind + signal mode (detector opens are always lifecycle).
        setFilter({ ...DEFAULT_MULTI_FILTER, kinds: ['lifecycle'] });
        return;
      }
      if (needsMeFilter.kind === 'case_event') {
        setFilter({ ...DEFAULT_MULTI_FILTER, kinds: ['lifecycle'] });
        return;
      }
      if (needsMeFilter.kind === 'workspace_event') {
        setFilter({ ...DEFAULT_MULTI_FILTER, kinds: ['system'] });
        return;
      }
    },
    [setFilter],
  );

  const visibleItems = useMemo(
    () => buildActivityFeedItems(entries, { multi: filter }),
    [entries, filter],
  );

  const hasAnyActivity = entries.length > 0;
  const hasVisibleActivity = visibleItems.length > 0;

  // Page chrome: density / typography / background flip with mode.
  const isRaw = filter.mode === 'raw';
  const listClass = isRaw
    ? 'flex flex-col gap-0 text-[13px] font-mono'
    : 'flex flex-col gap-2 text-sm';
  const containerClass = isRaw
    ? 'p-0 [&>ul>div:nth-child(odd)]:bg-surface-base/40 dark:[&>ul>div:nth-child(odd)]:bg-border-subtle/20'
    : 'p-3';
  const emptyTitle = isRaw
    ? 'No events in this window.'
    : 'All quiet — no signals in this window.';
  const emptyDescription = isRaw
    ? 'Loosen the filters or widen the time window to see more.'
    : 'Switch to Raw to see heartbeats and other low-signal events.';

  return (
    <section
      data-testid="activity-feed"
      data-mode={filter.mode}
      className={`bg-surface-raised rounded-xl border border-gray-200 dark:border-border-subtle ${
        isRaw ? 'bg-surface-base/30 dark:bg-surface-base/10' : ''
      }`}
    >
      <header className="px-4 py-3 border-b border-gray-100 dark:border-border-subtle">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Live Feed</h2>
          <LivePulse status={feedStatus} pollIntervalMs={pollIntervalMs} />
          <ActiveActorsLozenge entries={entries} onActorClick={handleActorClick} />
        </div>

        <div className="mt-3">
          <ActivityFilterBar
            filter={filter}
            onChange={setFilter}
            entries={entries}
            projectOptions={projectOptions}
            clientOptions={clientOptions}
          />
        </div>
      </header>

      <div className={containerClass}>
        {/*
          Mode-sensitive above-feed strip:
          - Signal: WhatNeedsMeStrip surfaces actionable items for the user.
          - Raw: StreamingSummaryLine replaces the parallel liveTailRate counter;
            it already ticks live via the streaming hook, so no extra interval
            is needed.
        */}
        {isRaw ? (
          <div className="px-4 py-2">
            <StreamingSummaryLine entries={entries} status={feedStatus} />
          </div>
        ) : (
          <WhatNeedsMeStrip onApplyFilter={handleApplyNeedsMeFilter} />
        )}
        <div ref={feedTopRef} aria-hidden />
        <NewEventsPill count={pendingCount} onClick={handleFlushPending} />
        {error ? (
          <EmptyState
            variant="error"
            title="Couldn't load activity"
            description={error instanceof Error ? error.message : String(error)}
          />
        ) : isLoading && entries.length === 0 ? (
          <ul
            className="flex flex-col gap-1 px-2"
            role="status"
            aria-busy="true"
            aria-label="Loading activity"
          >
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i}>
                <SkeletonRow columns={4} />
              </li>
            ))}
          </ul>
        ) : !hasAnyActivity ? (
          <EmptyState
            title="Nothing yet"
            description="As soon as cases are created, commented on, or decided, activity will stream here."
          />
        ) : !hasVisibleActivity ? (
          <EmptyState
            variant="filter"
            title={emptyTitle}
            description={emptyDescription}
            action={{
              label: 'Reset feed filters',
              onClick: () => setFilter({ ...DEFAULT_MULTI_FILTER }),
            }}
          />
        ) : (
          <ul className={listClass}>
            <AnimatePresence initial={false}>
              {visibleItems.map((item) => {
                // Raw-mode left-edge marker on rows that are also in Signal.
                const showSignalMarker =
                  isRaw && item.kind === 'entry' && isSignalEntry(item.entry);
                return (
                  <motion.div
                    key={item.id}
                    layout
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.25 }}
                    data-signal-marker={showSignalMarker || undefined}
                    className={
                      showSignalMarker
                        ? 'border-l-2 border-l-gray-300 dark:border-l-gray-600 pl-1'
                        : isRaw
                          ? 'border-l-2 border-l-transparent pl-1'
                          : ''
                    }
                  >
                    {item.kind === 'entry' ? (
                      <ActivityEntryRow
                        entry={item.entry}
                        onActorClick={handleActorClick}
                        onProjectClick={handleProjectFilter}
                        onWorkspaceEventClick={handleWorkspaceEventClick}
                        isFirstOfDay={item.isFirstOfDay}
                        isFresh={freshIds.has(item.entry.id)}
                      />
                    ) : item.kind === 'heartbeat' ? (
                      <HeartbeatTile entries={item.entries} />
                    ) : item.kind === 'streak' ? (
                      <ActivityStreakRow
                        item={item}
                        expanded={!!expandedClusters[item.id]}
                        onToggle={() =>
                          setExpandedClusters((current) => ({
                            ...current,
                            [item.id]: !current[item.id],
                          }))
                        }
                        onProjectClick={handleProjectFilter}
                        onActorClick={handleActorClick}
                        onWorkspaceEventClick={handleWorkspaceEventClick}
                      />
                    ) : (
                      <ActivityClusterRow
                        item={item}
                        expanded={!!expandedClusters[item.id]}
                        onToggle={() =>
                          setExpandedClusters((current) => ({
                            ...current,
                            [item.id]: !current[item.id],
                          }))
                        }
                        onProjectClick={handleProjectFilter}
                        onActorClick={handleActorClick}
                        onWorkspaceEventClick={handleWorkspaceEventClick}
                      />
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </ul>
        )}

        {hasAnyActivity && (
          <div className="mt-3 flex justify-center pb-3">
            <button
              type="button"
              onClick={loadMore}
              className="text-sm text-accent hover:underline"
            >
              Show more
            </button>
          </div>
        )}
      </div>

      {/*
        Drawer is only mounted when the parent didn't supply its own click
        override. Otherwise the parent is responsible for rendering the
        drawer (or some other detail surface) — double-mounting would stack
        two dialogs competing for focus.
      */}
      {!onWorkspaceEventClick && (
        <WorkspaceEventDrawer
          eventId={selectedEventId}
          onClose={() => setSelectedEventId(null)}
        />
      )}
    </section>
  );
}

// Exported for unit tests — see __tests__/activity-cluster-row.test.tsx.
// Production callers should import ActivityFeed and let it own clustering.
export function ActivityClusterRow({
  item,
  expanded,
  onToggle,
  onProjectClick,
  onActorClick,
  onWorkspaceEventClick,
}: {
  item: ActivityFeedClusterItem;
  expanded: boolean;
  onToggle: () => void;
  onProjectClick: (projectId: string) => void;
  onActorClick: (clientName: string) => void;
  onWorkspaceEventClick?: (entry: ActivityEntry) => void;
}) {
  const handleToggle = () => onToggle();
  const handleHeaderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onToggle();
    }
  };

  const panelId = `activity-cluster-panel-${item.id}`;

  return (
    <li className="group relative rounded-lg px-2 py-3 hover:bg-surface-base dark:hover:bg-border-subtle/40 transition-colors">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent dark:bg-accent/20 dark:text-accent-300 cursor-pointer"
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={expanded ? 'Collapse activity cluster' : 'Expand activity cluster'}
        >
          <span className="text-xs font-semibold">{item.entries.length}</span>
        </button>

        <div className="min-w-0 flex-1">
          <div
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={handleToggle}
            onKeyDown={handleHeaderKeyDown}
            className="cursor-pointer rounded -mx-1 px-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
              <span className="text-gray-500 dark:text-gray-400" aria-hidden="true">
                <svg
                  className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </span>
              {item.case_id ? (
                <Link
                  href={item.href}
                  onClick={(e) => e.stopPropagation()}
                  className="font-medium text-accent hover:underline truncate max-w-[320px] md:max-w-[440px]"
                  title={item.case_title ?? item.case_id}
                >
                  {item.case_title ?? item.case_id}
                </Link>
              ) : (
                <span className="font-semibold text-gray-900 dark:text-gray-100">Activity</span>
              )}
            </div>

            {item.label && (
              <div className="mt-0.5 text-sm text-gray-700 dark:text-gray-300">{item.label}</div>
            )}

            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              {item.verbChips.map((chip) => (
                <span
                  key={chip}
                  data-testid="cluster-verb-chip"
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-accent/10 text-accent dark:bg-accent/15 dark:text-accent-300"
                >
                  {chip}
                </span>
              ))}
              {item.countLabel && (
                <span
                  data-testid="cluster-count-label"
                  className="ml-auto text-[11px] text-gray-500 dark:text-gray-400"
                >
                  {item.countLabel}
                </span>
              )}
            </div>

            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
              {item.project_id && (
                <ProjectBadge
                  as="button"
                  label={item.project_name ?? item.project_id}
                  onClick={() => onProjectClick(item.project_id!)}
                  title={`Filter by project: ${item.project_name ?? item.project_id}`}
                />
              )}
              <RelativeTime timestamp={item.latest_timestamp} />
            </div>
          </div>

          {expanded && (
            <ul
              id={panelId}
              className="mt-3 ml-3 border-l border-gray-200 dark:border-border-subtle pl-3"
            >
              {item.entries.map((entry) => (
                <ActivityEntryRow
                  key={entry.id}
                  entry={entry}
                  onActorClick={onActorClick}
                  onProjectClick={onProjectClick}
                  onWorkspaceEventClick={onWorkspaceEventClick}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}

function LivePulse({
  status,
  pollIntervalMs,
}: {
  status: 'live' | 'reconnecting' | 'stopped';
  pollIntervalMs: number;
}) {
  const dotColor =
    status === 'live'
      ? 'bg-green-500'
      : status === 'reconnecting'
        ? 'bg-amber-600'
        : 'bg-gray-400';
  const label =
    status === 'live' ? 'live' : status === 'reconnecting' ? 'reconnecting' : 'stopped';
  const title =
    status === 'live'
      ? 'Receiving activity updates.'
      : status === 'reconnecting'
        ? `Waiting for the first activity update; retrying every ${Math.round(pollIntervalMs / 1000)}s.`
        : 'Not receiving events. Refresh the page.';
  return (
    <span
      role="status"
      className="inline-flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400"
      title={title}
      aria-label={title}
    >
      <span className="relative inline-flex h-2 w-2">
        {status === 'live' && (
          <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-70 animate-ping" />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${dotColor}`} />
      </span>
      {label}
    </span>
  );
}

/**
 * <ActivityStreakRow> — the streak collapse expander.
 */
export function ActivityStreakRow({
  item,
  expanded,
  onToggle,
  onProjectClick,
  onActorClick,
  onWorkspaceEventClick,
}: {
  item: ActivityFeedStreakItem;
  expanded: boolean;
  onToggle: () => void;
  onProjectClick: (projectId: string) => void;
  onActorClick: (clientName: string) => void;
  onWorkspaceEventClick?: (entry: ActivityEntry) => void;
}) {
  const panelId = `activity-streak-panel-${item.id}`;
  const handleHeaderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onToggle();
    }
  };
  return (
    <li
      className="group relative rounded-lg px-2 py-3 hover:bg-surface-base dark:hover:bg-border-subtle/40 transition-colors"
      data-testid="activity-streak-row"
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent dark:bg-accent/20 dark:text-accent-300 cursor-pointer"
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={expanded ? 'Collapse streak' : 'Expand streak'}
        >
          <span className="text-xs font-semibold">{item.count}</span>
        </button>
        <div className="min-w-0 flex-1">
          <div
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={onToggle}
            onKeyDown={handleHeaderKeyDown}
            className="cursor-pointer rounded -mx-1 px-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
              <span className="font-semibold text-gray-900 dark:text-gray-100">{item.actor_label}</span>
              <span className="text-gray-400 dark:text-gray-500">·</span>
              <span className="text-gray-900 dark:text-gray-100">
                {item.count} {item.verb_label} in {item.window_minutes} min
              </span>
              {item.case_title && (
                <>
                  <span className="text-gray-400 dark:text-gray-500">on</span>
                  <Link
                    href={item.href}
                    onClick={(e) => e.stopPropagation()}
                    className="font-medium italic text-accent hover:underline truncate max-w-[280px] md:max-w-[400px]"
                    title={item.case_title}
                  >
                    {item.case_title}
                  </Link>
                </>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-gray-500 dark:text-gray-400">
              {item.project_id && (
                <ProjectBadge
                  as="button"
                  label={item.project_name ?? item.project_id}
                  onClick={() => onProjectClick(item.project_id!)}
                  title={`Filter by project: ${item.project_name ?? item.project_id}`}
                />
              )}
              <RelativeTime timestamp={item.latest_timestamp} />
            </div>
          </div>
          {expanded && (
            <ul
              id={panelId}
              className="mt-3 ml-3 border-l border-gray-200 dark:border-border-subtle pl-3"
            >
              {item.entries.map((entry) => (
                <ActivityEntryRow
                  key={entry.id}
                  entry={entry}
                  onActorClick={onActorClick}
                  onProjectClick={onProjectClick}
                  onWorkspaceEventClick={onWorkspaceEventClick}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}

// Re-export ActivityEntry-consuming types for test access.
export type { ActivityEntry };
