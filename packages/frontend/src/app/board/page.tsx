'use client';

import { Suspense, useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import type { CaseStatus, Case, UserRole } from '@arbitra/shared';
import { useCases } from '../../hooks/use-cases';
import { useProjectMap } from '../../hooks/use-projects';
import { useActiveRuns } from '../../hooks/use-runs';
import { useUserRoles } from '../../hooks/use-user-roles';
import { useAuth } from '../../providers/auth-provider';
import { FilterBar, type BoardFilters } from '../../components/board/filter-bar';
import { StatusColumn } from '../../components/board/status-column';
import { CreateCaseModal } from '../../components/board/create-case-modal';
import { CaseListView } from '../../components/board/case-list-view';
import LifecycleRiverView from '../../components/board/lifecycle-river-view';
import { TriageHeader } from '../../components/board/triage-header';
import { Tooltip } from '../../components/shared/tooltip';
import { TriageEmptyState } from '../../components/board/triage-empty-state';
import { SkeletonCard } from '../../components/shared/skeleton';
import LoadingSpinner from '../../components/shared/loading-spinner';
import EmptyState from '../../components/shared/empty-state';
import {
  TRIAGE_VIEWS,
  getTriageViewPredicate,
  type TriageView,
} from '../../lib/triage-views';
import {
  type BoardViewMode,
  BOARD_VIEW_STORAGE_KEY,
  BOARD_HIDE_EMPTY_COLUMNS_STORAGE_KEY,
  BOARD_HIDE_EMPTY_COLUMNS_DEFAULT,
  resolveHideEmptyColumns,
  visibleBoardStatuses,
} from '../../lib/board-preferences';
import { isCaseArchived } from '../../lib/case-staleness';
type SortField = 'updated_at' | 'created_at' | 'priority' | 'risk_level' | 'status';
type SortDir = 'asc' | 'desc';

const FILTER_KEYS = ['status', 'risk_level', 'validation_track', 'priority', 'owner_user_id', 'project_id'] as const;

const BOARD_STATUSES: CaseStatus[] = [
  'open',
  'exploration',
  'ready_for_build',
  'in_build',
  'in_validation',
  'in_review',
  'needs_human_decision',
  'verification_pending',
  'approved',
  'pending_merge',
  'done',
  'rejected',
];

const REVIEWER_ROLES: readonly UserRole[] = ['reviewer', 'tech_lead', 'admin'];

const DEMO_USER_ID = 'usr_dev';

function isTriageView(value: string | null): value is TriageView {
  return value !== null && (TRIAGE_VIEWS as readonly string[]).includes(value);
}

function defaultViewForRoles(roles: readonly UserRole[]): TriageView {
  const isReviewerLike = roles.some((r) => REVIEWER_ROLES.includes(r));
  return isReviewerLike ? 'needs-me' : 'my-active';
}

function filtersFromParams(params: URLSearchParams): BoardFilters {
  const f: BoardFilters = {};
  for (const key of FILTER_KEYS) {
    const val = params.get(key);
    if (val) (f as Record<string, string>)[key] = val;
  }
  return f;
}

export default function BoardPage() {
  return (
    <Suspense>
      <BoardPageContent />
    </Suspense>
  );
}

function BoardPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const roles = useUserRoles();
  // Roles hook returns [] until SWR resolves. Treat the very first render
  // (auth still loading) as "roles unresolved" so we can render a skeleton.
  const rolesResolved = !authLoading;

  // Initialize filters from URL params
  const [filters, setFilters] = useState<BoardFilters>(() => filtersFromParams(searchParams));
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [boardViewMode, setBoardViewMode] = useState<BoardViewMode>(() => {
    const fromUrl = searchParams.get('layout') as BoardViewMode;
    if (fromUrl === 'board' || fromUrl === 'list' || fromUrl === 'lifecycle') return fromUrl;
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(BOARD_VIEW_STORAGE_KEY);
      if (stored === 'board' || stored === 'list' || stored === 'lifecycle') return stored;
    }
    return 'list';
  });
  // Default the kanban to hide
  // empty columns. Twelve empty status columns by default defeats triage —
  // the default view should surface only the buckets that have work in them.
  // SSR initial value stays the default; the mount effect below restores
  // any explicit user override from localStorage.
  const [hideEmptyColumns, setHideEmptyColumns] = useState<boolean>(BOARD_HIDE_EMPTY_COLUMNS_DEFAULT);
  // Load persisted toggle on mount (client-only, avoids SSR hydration mismatch).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = localStorage.getItem(BOARD_HIDE_EMPTY_COLUMNS_STORAGE_KEY);
    setHideEmptyColumns(resolveHideEmptyColumns(stored));
  }, []);
  const toggleHideEmptyColumns = useCallback(() => {
    setHideEmptyColumns((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        localStorage.setItem(BOARD_HIDE_EMPTY_COLUMNS_STORAGE_KEY, String(next));
      }
      return next;
    });
  }, []);

  const [sortField, setSortField] = useState<SortField>(() =>
    (searchParams.get('sort') as SortField) || 'updated_at',
  );
  const [sortDir, setSortDir] = useState<SortDir>(() =>
    (searchParams.get('dir') as SortDir) || 'desc',
  );

  // Active triage view — URL is authoritative; role default only applies when absent.
  const urlViewParam = searchParams.get('view');
  const urlView: TriageView | null = isTriageView(urlViewParam) ? urlViewParam : null;
  const activeView: TriageView = urlView ?? defaultViewForRoles(roles);

  // Debounced URL update for filters + layout + sort (triage view writes directly).
  const updateTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const updateURL = useCallback(
    (newFilters: BoardFilters, newView?: BoardViewMode, newSort?: SortField, newDir?: SortDir) => {
      clearTimeout(updateTimer.current);
      updateTimer.current = setTimeout(() => {
        const params = new URLSearchParams();
        for (const key of FILTER_KEYS) {
          const val = (newFilters as Record<string, string | undefined>)[key];
          if (val) params.set(key, val);
        }
        const v = newView ?? boardViewMode;
        const s = newSort ?? sortField;
        const d = newDir ?? sortDir;
        // `view` param is reserved for triage view — carry it through.
        const currentTriageView = searchParams.get('view');
        if (currentTriageView) params.set('view', currentTriageView);
        if (v !== 'list') params.set('layout', v);
        if (s !== 'updated_at') params.set('sort', s);
        if (d !== 'desc') params.set('dir', d);
        const qs = params.toString();
        router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
      }, 300);
    },
    [router, pathname, boardViewMode, sortField, sortDir, searchParams],
  );

  function handleFilterChange(newFilters: BoardFilters) {
    setFilters(newFilters);
    updateURL(newFilters);
  }

  // Role-aware default: if no `?view=` present, write the role-appropriate
  // default into the URL so it becomes shareable / authoritative.
  useEffect(() => {
    if (!rolesResolved) return;
    if (urlView !== null) return;
    const desired = defaultViewForRoles(roles);
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', desired);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [rolesResolved, urlView, roles, pathname, router, searchParams]);

  // Legacy: `?view=list|board|lifecycle` used to mean layout, not triage view.
  // Migrate so old bookmarks still land on the intended layout.
  useEffect(() => {
    if (urlViewParam === 'list' || urlViewParam === 'board' || urlViewParam === 'lifecycle') {
      const p = new URLSearchParams(searchParams.toString());
      p.delete('view');
      p.set('layout', urlViewParam);
      router.replace(`${pathname}?${p.toString()}`, { scroll: false });
    }
  }, [urlViewParam, searchParams, pathname, router]);

  const projectMap = useProjectMap();
  const { activeRunsByCase } = useActiveRuns();

  const { cases, findingCounts, isLoading, error, mutate } = useCases({
    status: filters.status,
    risk_level: filters.risk_level,
    validation_track: filters.validation_track,
    priority: filters.priority,
    owner_user_id: filters.owner_user_id,
    project_id: filters.project_id,
  }, { fetchAll: true });

  const archivedCount = useMemo(
    () => cases.filter((c) => isCaseArchived(c)).length,
    [cases],
  );

  // Cases that pass the "raw filter" bar (archived/pendingGate toggles).
  const rawFilteredCases = useMemo(() => {
    let result = cases;
    if (!filters.showArchived) {
      result = result.filter((c) => !isCaseArchived(c));
    }
    if (filters.pendingGate) {
      result = result.filter((c) => !!c.pending_gate);
    }
    return result;
  }, [cases, filters.showArchived, filters.pendingGate]);

  // User ID for triage selectors.
  const userId = user?.uid ?? DEMO_USER_ID;

  // Counts per triage view, computed over raw-filtered cases.
  const triageCounts = useMemo(() => {
    const ctx = { userId, roles, findingCounts };
    const out = {} as Record<TriageView, number>;
    for (const view of TRIAGE_VIEWS) {
      const predicate = getTriageViewPredicate(view, ctx);
      out[view] = rawFilteredCases.filter(predicate).length;
    }
    return out;
  }, [rawFilteredCases, userId, roles, findingCounts]);

  // Cases visible in the active triage view.
  //
  // Special case: when the user toggles `Show archived`, bypass the triage
  // predicate and show archived cases only. Archived cases live in terminal
  // states (done/rejected) and never match any triage predicate, so without
  // this bypass the toggle had no observable effect on triage views.
  const visibleCases = useMemo(() => {
    if (filters.showArchived) {
      return cases.filter((c) => isCaseArchived(c));
    }
    const predicate = getTriageViewPredicate(activeView, { userId, roles, findingCounts });
    return rawFilteredCases.filter(predicate);
  }, [cases, rawFilteredCases, activeView, userId, roles, findingCounts, filters.showArchived]);

  const casesByStatus = useMemo(() => {
    const grouped: Record<string, Case[]> = {};
    for (const status of BOARD_STATUSES) {
      grouped[status] = [];
    }
    for (const c of visibleCases) {
      grouped[c.status]?.push(c);
    }
    return grouped;
  }, [visibleCases]);

  const visibleStatuses = useMemo(() => {
    const base = filters.status
      ? BOARD_STATUSES.filter((s) => s === filters.status)
      : BOARD_STATUSES;
    return visibleBoardStatuses(base, casesByStatus, hideEmptyColumns);
  }, [filters.status, hideEmptyColumns, casesByStatus]);

  function handleBoardViewMode(mode: BoardViewMode) {
    setBoardViewMode(mode);
    updateURL(filters, mode);
  }

  function handleSort(field: SortField) {
    if (field === sortField) {
      const newDir = sortDir === 'asc' ? 'desc' : 'asc';
      setSortDir(newDir);
      updateURL(filters, undefined, field, newDir);
    } else {
      const newDir = field === 'updated_at' || field === 'created_at' ? 'desc' : 'asc';
      setSortField(field);
      setSortDir(newDir);
      updateURL(filters, undefined, field, newDir);
    }
  }

  const activeFilterCount =
    FILTER_KEYS.filter((k) => (filters as Record<string, string | undefined>)[k]).length +
    (filters.pendingGate ? 1 : 0) +
    (filters.showArchived ? 1 : 0);

  const reviewSessionHref = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', activeView);
    params.delete('layout');
    params.delete('sort');
    params.delete('dir');
    const qs = params.toString();
    return `/review-session${qs ? `?${qs}` : ''}`;
  }, [searchParams, activeView]);

  // Role default still resolving — render a skeleton strip where the tablist
  // will appear, so the header area doesn't jump.
  if (!rolesResolved && urlView === null) {
    return (
      <div className="flex flex-col h-[calc(100vh-57px)]">
        <div className="px-6 pt-5 pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100">Cases</h1>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {TRIAGE_VIEWS.map((v) => (
              <SkeletonCard key={v} className="h-10" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-57px)]">
      <div className="px-6 pt-5 pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100">Cases</h1>
          <div className="flex items-center gap-2 sm:gap-3">
            {boardViewMode === 'board' && (
              <button
                type="button"
                onClick={toggleHideEmptyColumns}
                aria-pressed={hideEmptyColumns}
                aria-label={hideEmptyColumns ? 'Show all columns' : 'Hide empty columns'}
                title={hideEmptyColumns ? 'Show all columns' : 'Hide empty columns'}
                className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium shadow-sm transition-colors ${
                  hideEmptyColumns
                    ? 'border-accent/40 bg-accent/10 text-accent-700 dark:border-accent/60 dark:bg-accent/20 dark:text-accent-400'
                    : 'border-gray-300 bg-surface-raised text-gray-600 hover:text-gray-800 hover:bg-surface-base dark:border-gray-600 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700'
                }`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {hideEmptyColumns ? (
                    <>
                      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.77 19.77 0 0 1 4.22-5.11" />
                      <path d="M1 1l22 22" />
                      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                      <path d="M10.73 5.08A11 11 0 0 1 12 5c7 0 11 8 11 8a19.7 19.7 0 0 1-2.16 3.19" />
                    </>
                  ) : (
                    <>
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </>
                  )}
                </svg>
                <span className="hidden sm:inline">
                  {hideEmptyColumns ? 'Show all columns' : 'Hide empty columns'}
                </span>
              </button>
            )}
            {/* Layout toggle (list / board / lifecycle) — orthogonal to triage views */}
            <div className="inline-flex rounded-md border border-gray-300 dark:border-gray-600 bg-surface-raised shadow-sm">
              <Tooltip label="Lifecycle view">
                <button
                  type="button"
                  onClick={() => handleBoardViewMode('lifecycle')}
                  aria-label="Lifecycle view"
                  aria-pressed={boardViewMode === 'lifecycle'}
                  className={`inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-l-md transition-colors ${
                    boardViewMode === 'lifecycle'
                      ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-surface-base dark:hover:bg-gray-700'
                  }`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/>
                    <path d="M2 6c2-2.7 4-2.7 6 0s4 2.7 6 0 4-2.7 6 0" opacity="0.5"/>
                    <path d="M2 18c2-2.7 4-2.7 6 0s4 2.7 6 0 4-2.7 6 0" opacity="0.5"/>
                  </svg>
                </button>
              </Tooltip>
              <Tooltip label="Board view">
                <button
                  type="button"
                  onClick={() => handleBoardViewMode('board')}
                  aria-label="Board view"
                  aria-pressed={boardViewMode === 'board'}
                  className={`inline-flex items-center px-3 py-1.5 text-sm font-medium border-l border-gray-300 dark:border-gray-600 transition-colors ${
                    boardViewMode === 'board'
                      ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-surface-base dark:hover:bg-gray-700'
                  }`}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 4.5v15m6-15v15m-10.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v12.75c0 .621.504 1.125 1.125 1.125Z" />
                  </svg>
                </button>
              </Tooltip>
              <Tooltip label="List view">
                <button
                  type="button"
                  onClick={() => handleBoardViewMode('list')}
                  aria-label="List view"
                  aria-pressed={boardViewMode === 'list'}
                  className={`inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-r-md border-l border-gray-300 dark:border-gray-600 transition-colors ${
                    boardViewMode === 'list'
                      ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-surface-base dark:hover:bg-gray-700'
                  }`}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
                  </svg>
                </button>
              </Tooltip>
            </div>

            <Link
              href={reviewSessionHref}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-medium text-accent-700 hover:bg-accent/15 dark:border-accent-300/40 dark:text-accent-300"
              title="Start guided review session"
              aria-label="Start review session"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.008v.008H3.75V6.75Zm0 5.25h.008v.008H3.75V12Zm0 5.25h.008v.008H3.75v-.008Z" />
              </svg>
              <span className="hidden lg:inline">Start session</span>
            </Link>

            <button
              type="button"
              className="rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-800 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
              onClick={() => setShowCreateModal(true)}
            >
              <span className="sm:hidden">+</span>
              <span className="hidden sm:inline">+ New Case</span>
            </button>
          </div>
        </div>

        {/* Triage header — six role-aware views */}
        <TriageHeader activeView={activeView} counts={triageCounts} />

        {/* Advanced: raw filters demoted behind a disclosure */}
        <details
          className="mt-3 group"
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-surface-base dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent list-none select-none">
            <svg
              className={`h-3.5 w-3.5 transition-transform ${advancedOpen ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
            Advanced filters
            {activeFilterCount > 0 && (
              <span className="inline-flex items-center justify-center rounded-full bg-accent-700 text-white px-1.5 py-0.5 text-[10px] font-bold min-w-[1.25rem]">
                {activeFilterCount}
              </span>
            )}
          </summary>
          <div className="mt-2">
            <FilterBar filters={filters} onChange={handleFilterChange} archivedCount={archivedCount} />
          </div>
        </details>
      </div>

      {error && (
        <div className="mx-6 mb-3 rounded-md bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-300">
          Failed to load cases: {error.message}
        </div>
      )}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <LoadingSpinner size="md" />
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading cases...</p>
          </div>
        </div>
      ) : visibleCases.length === 0 ? (
        <div
          id="triage-tabpanel"
          role="tabpanel"
          aria-labelledby={`triage-tab-${activeView}`}
          className="flex-1 px-6 pb-4 pt-2"
        >
          {filters.showArchived ? (
            <div className="mx-auto max-w-md">
              <EmptyState
                title="No archived cases"
                description="Nothing is currently in a done or rejected state."
              />
            </div>
          ) : (
            <TriageEmptyState view={activeView} />
          )}
        </div>
      ) : boardViewMode === 'lifecycle' ? (
        <div
          id="triage-tabpanel"
          role="tabpanel"
          aria-labelledby={`triage-tab-${activeView}`}
          className="flex-1 overflow-auto px-6 pb-4"
        >
          <LifecycleRiverView
            cases={visibleCases}
            casesByStatus={casesByStatus}
            projectMap={projectMap}
            findingCounts={findingCounts}
            activeRunsByCase={activeRunsByCase}
          />
        </div>
      ) : boardViewMode === 'list' ? (
        <div
          id="triage-tabpanel"
          role="tabpanel"
          aria-labelledby={`triage-tab-${activeView}`}
          className="flex-1 flex gap-4 px-6 pb-4 overflow-hidden"
        >
          <div className="flex-1 overflow-y-auto">
            <CaseListView
              cases={visibleCases}
              sortField={sortField}
              sortDir={sortDir}
              onSort={handleSort}
              projectMap={projectMap}
              findingCounts={findingCounts}
              activeRunsByCase={activeRunsByCase}
            />
          </div>
        </div>
      ) : (
        <div
          id="triage-tabpanel"
          role="tabpanel"
          aria-labelledby={`triage-tab-${activeView}`}
          className="flex-1 flex gap-4 px-6 pb-4 overflow-hidden"
        >
          <div className="flex-1 flex flex-col gap-3 overflow-y-auto sm:flex-row sm:gap-3 sm:overflow-x-auto sm:overflow-y-hidden pb-2">
            {visibleStatuses.map((status) => (
              <StatusColumn
                key={status}
                status={status}
                cases={casesByStatus[status] ?? []}
                projectMap={projectMap}
                findingCounts={findingCounts}
                activeRunsByCase={activeRunsByCase}
              />
            ))}
          </div>
        </div>
      )}

      <CreateCaseModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={() => mutate()}
      />
    </div>
  );
}
