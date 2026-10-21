'use client';

import useSWR from 'swr';
import { api } from '../lib/api-client';

/**
 * Returns the number of cases that need the current user's attention
 * (statuses: `needs_human_decision`, `verification_pending`).
 *
 * Hits the dedicated `/cases/actionable-count` endpoint which uses
 * Firestore's server-side `.count()` aggregation — constant response size
 * regardless of how many cases exist. Previously we fetched the full cases
 * list and counted client-side, which was wasteful for a single badge.
 */
export function useActionableCount(): number {
  const { data } = useSWR(
    ['cases', 'actionable-count'],
    () => api.cases.actionableCount(),
    {
      refreshInterval: 30000,
      revalidateOnFocus: true,
    },
  );
  return data?.count ?? 0;
}
