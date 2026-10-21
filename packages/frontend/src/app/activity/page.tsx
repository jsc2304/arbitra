'use client';

import { Suspense, useCallback, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ActivityLeaderboardWindow } from '@arbitra/shared';
import { ActivityFeed } from '../../components/activity/activity-feed';
import { ActivityLeaderboard } from '../../components/activity/activity-leaderboard';
import { AnomaliesCard } from '../../components/activity/anomalies-card';
import { PageShell, PageHeader } from '../../components/layout/page-shell';
import {
  applyFilterDelta,
  multiFilterFromParams,
  multiFilterToParams,
  type FilterDelta,
} from '../../lib/activity-url-state';
import type { MultiActivityFilter } from '../../lib/activity-feed-presentation';

/**
 * `/activity` — workspace-wide live event stream + leaderboard.
 *
 * The page is the source of truth for `?mode=…&kinds=…&actors=…`.
 * The feed becomes a controlled component over the multi-filter so URL state,
 * Slack-shareable links, and hard-reload state stay in lockstep.
 *
 * The right rail content swaps with mode: Signal shows the
 * existing decision-support content (Hot Projects / Attribution Coverage /
 * AnomaliesCard); Raw shows the operational rail stub. The full operational
 * rail (Event Throughput / Source breakdown / Latency p50/p95) lands in a
 * later step once backend endpoints exist.
 *
 * Right-rail clicks emit a FilterDelta merged into the URL via
 * `applyFilterDelta` + `router.replace`. Rail components stay stateless.
 */
export default function ActivityPage() {
  return (
    // useSearchParams() suspends during prerender per Next.js 14 docs.
    <Suspense
      fallback={
        <PageShell>
          <PageHeader title="Activity" description="" />
        </PageShell>
      }
    >
      <ActivityPageContent />
    </Suspense>
  );
}

function ActivityPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Decode URL → MultiActivityFilter on every render. searchParams is a
  // stable reference per Next.js routing; the derived filter is memoized so
  // child equality checks stay cheap.
  const multi = useMemo(
    () => multiFilterFromParams(searchParams),
    [searchParams],
  );

  const [window, setWindow] = useState<ActivityLeaderboardWindow>('24h');

  const writeFilter = useCallback(
    (next: MultiActivityFilter) => {
      const qs = multiFilterToParams(next).toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  const handleFilterDelta = useCallback(
    (delta: FilterDelta) => {
      writeFilter(applyFilterDelta(multi, delta));
    },
    [multi, writeFilter],
  );

  const isRaw = multi.mode === 'raw';

  return (
    <PageShell>
      <PageHeader
        title="Activity"
        description={
          isRaw
            ? 'Full audit log — every emitted event, including heartbeats and deduped runs.'
            : 'Live workspace feed first, with compact project and client context alongside it.'
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_24rem] xl:items-start">
        <div className="min-w-0">
          <ActivityFeed filter={multi} onFilterChange={writeFilter} />
        </div>

        <aside className="min-w-0 xl:sticky xl:top-6">
          {isRaw ? (
            <RawOperationalRailStub />
          ) : (
            <div className="space-y-4">
              <ActivityLeaderboard
                window={window}
                onWindowChange={setWindow}
                onFilterClick={handleFilterDelta}
              />
              <AnomaliesCard onFilterClick={handleFilterDelta} />
            </div>
          )}
        </aside>
      </div>
    </PageShell>
  );
}

/**
 * Raw-mode right rail placeholder. The per-mode swap
 * surface is in place; the next step wires the operational metrics — Event
 * Throughput, Source breakdown, Latency p50/p95 — that don't have backend
 * endpoints yet.
 */
function RawOperationalRailStub() {
  return (
    <section
      data-testid="activity-rail-raw-stub"
      className="rounded-xl border border-dashed border-gray-300 bg-surface-raised p-4 text-sm text-gray-600 dark:border-border-subtle dark:text-gray-300"
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent/80">
        Operational metrics
      </p>
      <h2 className="mt-1 text-base font-semibold text-gray-900 dark:text-gray-100">
        Throughput · Sources · Latency
      </h2>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Raw-mode operational rail (Event Throughput, Source breakdown, Latency
        p50/p95) lands in a later release. Switch back to Signal for decision
        support — Hot Projects, Attribution Coverage, Detected Clients.
      </p>
    </section>
  );
}
