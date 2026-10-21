'use client';

/**
 * useLastDecision (UI/UX 3-bets plan 1.6).
 *
 * Returns the most recent `Decision` on a case. Used by the compact
 * Decision Context panel on the case detail page to surface the last
 * approval/rejection/request-changes at a glance, without requiring the
 * user to open the Decisions tab.
 *
 * SWR cache key reuse: `['decisions', caseId]` — intentionally identical
 * to the key used by `components/case/decision-history.tsx`, so both
 * consumers dedupe to a single fetch and stay in sync after mutations.
 */

import useSWR from 'swr';
import type { Decision } from '@arbitra/shared';
import { api } from '../lib/api-client';

/**
 * Pure helper: returns the decision with the highest `created_at`, or
 * `undefined` if the list is empty. Exported separately for unit testing.
 *
 * `created_at` is an ISO-8601 string — lexicographic comparison on that
 * format matches chronological order, so no Date parsing required.
 */
export function selectLastDecision(decisions: readonly Decision[] | undefined): Decision | undefined {
  if (!decisions || decisions.length === 0) return undefined;
  let latest: Decision = decisions[0]!;
  for (let i = 1; i < decisions.length; i++) {
    const candidate = decisions[i]!;
    if (candidate.created_at > latest.created_at) {
      latest = candidate;
    }
  }
  return latest;
}

export interface UseLastDecisionResult {
  decision: Decision | undefined;
  isLoading: boolean;
  error?: Error;
}

export function useLastDecision(caseId: string): UseLastDecisionResult {
  const { data, error, isLoading } = useSWR(
    caseId ? ['decisions', caseId] : null,
    () => api.cases.decisions(caseId),
  );

  return {
    decision: selectLastDecision(data?.decisions),
    isLoading,
    error: error instanceof Error ? error : error ? new Error(String(error)) : undefined,
  };
}
