'use client';

import { useEffect, useRef } from 'react';
import useSWR from 'swr';
import { api, type CasesListResponse } from '../lib/api-client';
import type { Case, CaseFilters } from '@arbitra/shared';

// Terminal statuses — no further transitions will happen, polling is waste.
// Everything else (open, exploration, ready_for_build, in_build, in_validation,
// in_review, approved, pending_merge, needs_human_decision, verification_pending)
// is considered "still moving" and warrants live polling.
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'rejected']);

function listRefreshInterval(
  cases: readonly Case[] | undefined,
  forceFast: boolean,
): number {
  if (forceFast) return 1500;
  if (!cases || cases.length === 0) return 30000;
  const anyNonTerminal = cases.some((c) => !TERMINAL_STATUSES.has(c.status));
  return anyNonTerminal ? 1500 : 30000;
}

interface UseCasesOptions {
  fastPolling?: boolean;
  fetchAll?: boolean;
}

export function useCases(filters?: CaseFilters, options?: UseCasesOptions) {
  const mode = options?.fetchAll ? 'all' : 'page';
  const key = filters ? ['cases', mode, JSON.stringify(filters)] : ['cases', mode];

  const { data, error, isLoading, mutate } = useSWR(
    key,
    (): Promise<CasesListResponse> =>
      options?.fetchAll ? api.cases.listAll(filters) : api.cases.list(filters),
    {
      // Function form re-evaluates after each refresh: as soon as the last
      // active case lands on `done`, the interval drops back to 30 s.
      refreshInterval: (latest) =>
        listRefreshInterval(latest?.cases, Boolean(options?.fastPolling)),
    },
  );

  // Auto-sync merge status for pending_merge cases so board/list views self-heal
  const syncedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const cases = data?.cases;
    if (!cases) return;

    const pendingIds = new Set<string>();
    const toSync = cases.filter((c) => {
      if (c.status === 'pending_merge' && c.current_pr_ref) {
        pendingIds.add(c.case_id);
        return !syncedRef.current.has(c.case_id);
      }
      return false;
    });

    // Remove stale entries (cases no longer in pending_merge)
    for (const id of syncedRef.current) {
      if (!pendingIds.has(id)) syncedRef.current.delete(id);
    }

    if (toSync.length === 0) return;

    // Mark as synced immediately to prevent duplicate calls
    for (const c of toSync) syncedRef.current.add(c.case_id);

    Promise.allSettled(
      toSync.map((c) => api.cases.syncMerge(c.case_id)),
    ).then((results) => {
      const anyMerged = results.some(
        (r) => r.status === 'fulfilled' && r.value.merged,
      );
      if (anyMerged) mutate();
    });
  }, [data, mutate]);

  return {
    cases: data?.cases ?? [],
    cursor: data?.cursor,
    findingCounts: data?.finding_counts ?? {},
    error,
    isLoading,
    mutate,
  };
}
