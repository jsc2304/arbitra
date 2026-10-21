'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import type { IntelligenceRun } from '@arbitra/shared';
import { api } from '../../../lib/api-client';
import { useIsAdmin } from '../../../hooks/use-is-admin';
import { RunHistoryTable } from '../../../components/intelligence/run-history-table';
import { DetectorStatusCard } from '../../../components/intelligence/detector-status-card';
import { RunNowButton } from '../../../components/intelligence/run-now-button';
import SectionHeader from '../../../components/shared/section-header';
import EmptyState from '../../../components/shared/empty-state';
import { SchedulerPausedBanner } from '../../../components/shared/scheduler-paused-banner';

/**
 * `/observatory/intelligence` — admin-only landing for the Arbitra
 * Intelligence run history and detector roster.
 *
 * Gating: client-side via `useIsAdmin()` (shows a clear "admin required"
 * notice for non-admins). Defense-in-depth is handled server-side — every
 * API route this page calls is guarded by `requireRole(..., ['admin'])`, so
 * a non-admin who bypasses the client gate still can't fetch any data.
 *
 * Layout: Run History (paginated via the cursor returned from
 * `/api/intelligence/runs`) → Detector Status (grid of enable cards). The
 * drill-down per detector lives at
 * `/observatory/intelligence/detectors/:detectorId`.
 */
export default function IntelligenceObservatoryPage() {
  const { isAdmin, isLoading: isAdminLoading } = useIsAdmin();

  // Defer the data hooks until `isAdmin === true` — non-admins never
  // trigger the admin-only list endpoints. The hook's `isLoading` flag
  // lets us render a skeleton during the first `/users/me` fetch instead
  // of flashing the "Admin access required" card on every load.
  const runsSwr = useSWR(
    isAdmin ? ['intelligence-runs', 50] : null,
    () => api.intelligence.listRuns({ limit: 50 }),
  );
  const detectorsSwr = useSWR(
    isAdmin ? 'intelligence-detectors' : null,
    () => api.intelligence.listDetectors(),
  );

  const [extraRuns, setExtraRuns] = useState<IntelligenceRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  const onRunCompleted = useCallback((run: IntelligenceRun) => {
    // Prepend the fresh run locally so the admin sees it immediately, then
    // revalidate both keys.
    setExtraRuns((prev) => [run, ...prev.filter((r) => r.run_id !== run.run_id)]);
    void runsSwr.mutate();
    void detectorsSwr.mutate();
  }, [runsSwr, detectorsSwr]);

  const onEnabledChanged = useCallback(() => {
    void detectorsSwr.mutate();
  }, [detectorsSwr]);

  const onLoadMore = useCallback(async () => {
    const cursor = nextCursor ?? runsSwr.data?.next_cursor;
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api.intelligence.listRuns({ limit: 50, cursor });
      setExtraRuns((prev) => [...prev, ...page.runs]);
      setNextCursor(page.next_cursor);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, runsSwr.data?.next_cursor]);

  // While SWR hasn't decided, render a skeleton. Once it has resolved
  // a non-admin user, gate them out.
  if (isAdminLoading) {
    return (
      <div className="mx-auto max-w-6xl p-6 space-y-10" aria-busy="true">
        <SkeletonBlock lines={6} />
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <EmptyState
          icon={
            <svg
              className="h-10 w-10 text-gray-300 dark:text-gray-600"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1}
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
              />
            </svg>
          }
          title="Admin access required"
          description="The Arbitra Intelligence admin page is only available to administrators."
        />
        <div className="mt-4 text-center">
          <Link
            href="/observatory"
            className="inline-block text-xs font-medium text-accent hover:text-accent-700 dark:hover:text-accent-300"
          >
            ← Back to Observatory
          </Link>
        </div>
      </div>
    );
  }

  const persistedRuns = runsSwr.data?.runs ?? [];
  const combinedRuns = dedupeRuns([...extraRuns, ...persistedRuns]);
  const runsCursor = nextCursor ?? runsSwr.data?.next_cursor;

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-10">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            <Link
              href="/observatory"
              className="hover:text-gray-700 dark:hover:text-gray-300"
            >
              Observatory
            </Link>
            <span className="mx-1">/</span>
            <span>Intelligence</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-50">
            Arbitra Intelligence
          </h1>
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
            Scheduler runs, detector health, and findings attributed to each
            detector.
          </p>
        </div>
        <RunNowButton onRunCompleted={onRunCompleted} />
      </header>

      <SchedulerPausedBanner feature="intelligence" />

      <section aria-labelledby="runs-heading" className="space-y-3">
        <SectionHeader
          id="runs-heading"
          title="Run History"
          description="Most recent intelligence runs, newest first. Click a row to see per-detector results."
        />
        {runsSwr.error ? (
          <ErrorBox>Failed to load runs: {formatErr(runsSwr.error)}</ErrorBox>
        ) : runsSwr.isLoading ? (
          <SkeletonBlock lines={4} />
        ) : (
          <RunHistoryTable
            runs={combinedRuns}
            onLoadMore={runsCursor ? onLoadMore : undefined}
            loadingMore={loadingMore}
          />
        )}
      </section>

      <section aria-labelledby="detectors-heading" className="space-y-3">
        <SectionHeader
          id="detectors-heading"
          title="Detector Status"
          description="Toggle a detector to disable it on the next run. Disabled detectors are skipped but still recorded in run history."
        />
        {detectorsSwr.error ? (
          <ErrorBox>Failed to load detectors: {formatErr(detectorsSwr.error)}</ErrorBox>
        ) : detectorsSwr.isLoading ? (
          <SkeletonBlock lines={2} />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(detectorsSwr.data?.detectors ?? []).map((d) => (
              <DetectorStatusCard
                key={d.detector_id}
                detector={d}
                onEnabledChanged={onEnabledChanged}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dedupeRuns(runs: IntelligenceRun[]): IntelligenceRun[] {
  const seen = new Set<string>();
  const out: IntelligenceRun[] = [];
  for (const r of runs) {
    if (seen.has(r.run_id)) continue;
    seen.add(r.run_id);
    out.push(r);
  }
  return out;
}

function formatErr(e: unknown): string {
  return e instanceof Error ? e.message : 'Unknown error';
}

function SkeletonBlock({ lines }: { lines: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-12 animate-pulse rounded-md bg-surface-base dark:bg-border-subtle/40"
        />
      ))}
    </div>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300">
      {children}
    </div>
  );
}
