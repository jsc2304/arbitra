'use client';

import useSWR from 'swr';
import type { Run, AgentPresence } from '@arbitra/shared';
import { api } from '../lib/api-client';

export function useRunsForCase(caseId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    caseId ? ['runs', caseId] : null,
    () => api.runs.listForCase(caseId!),
    { refreshInterval: 5000 },
  );

  const runs = data?.runs ?? [];
  const activeRuns = runs.filter((r) => r.status === 'running' || r.status === 'pending');

  return {
    runs,
    activeRuns,
    hasActiveRuns: activeRuns.length > 0,
    error,
    isLoading,
    mutate,
  };
}

/**
 * Fetches all active runs across all cases, returning a map of case_id -> Run[].
 * Polls every 10 seconds so the board stays up-to-date.
 */
export function useActiveRuns() {
  const { data, error, isLoading } = useSWR(
    'runs-active',
    () => api.runs.listActive(),
    { refreshInterval: 10_000 },
  );

  const activeRunsByCase: Record<string, Run[]> = data?.activeRunsByCase ?? {};
  const presenceByCase: Record<string, AgentPresence[]> = data?.presenceByCase ?? {};

  return { activeRunsByCase, presenceByCase, error, isLoading };
}
