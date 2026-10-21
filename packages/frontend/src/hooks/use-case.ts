'use client';

import useSWR from 'swr';
import { api } from '../lib/api-client';
import { getCasePollingInterval } from '../lib/case-polling';

export function useCase(caseId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    caseId ? ['case', caseId] : null,
    () => api.cases.get(caseId!),
    {
      // Poll at a rate that depends on the case's current status. The
      // function form re-evaluates on every refresh, so the interval
      // shortens when the case enters the active pipeline and drops to
      // 0 when it reaches a terminal state.
      refreshInterval: (latest) => getCasePollingInterval(latest?.status),
    },
  );

  return {
    caseData: data ?? null,
    error,
    isLoading,
    mutate,
  };
}
