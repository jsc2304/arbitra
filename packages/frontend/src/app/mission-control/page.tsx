'use client';

import useSWR from 'swr';
import { api } from '@/lib/api-client';
import { MissionControlSessionList } from '@/components/mission-control/mission-control-session-list';
import { ActiveSessionsPanel } from '@/components/mission-control/active-sessions-panel';
import LoadingSpinner from '@/components/shared/loading-spinner';
import { SchedulerPausedBanner } from '@/components/shared/scheduler-paused-banner';

// Sessions past the liveness window drop off the server-side aggregate on
// every read, so a 10s poll (matching `useActiveRuns`'s cadence) is enough
// to make that visible without websockets.
const POLL_INTERVAL_MS = 10_000;

export default function MissionControlPage() {
  const { data, error, isLoading } = useSWR('mission-control', () => api.missionControl.get(), {
    refreshInterval: POLL_INTERVAL_MS,
  });

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-50">Mission Control</h1>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-200">
          What is running right now — agents, branches, and their cases.
        </p>
      </div>

      <SchedulerPausedBanner feature="run_sweeper" className="mb-6" />

      {isLoading ? (
        <div className="flex items-center justify-center min-h-[40vh]">
          <LoadingSpinner size="md" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-4 py-3">
          <p className="text-sm text-red-700 dark:text-red-400">
            Failed to load Mission Control. {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {data?.active_sessions_panel && <ActiveSessionsPanel panel={data.active_sessions_panel} />}
          <MissionControlSessionList
            sessions={data?.sessions ?? []}
            truncatedCount={data?.truncated_session_count ?? 0}
          />
        </div>
      )}
    </div>
  );
}
