'use client';

import { useEffect, useRef } from 'react';
import useSWR from 'swr';
import { useAuth } from '../providers/auth-provider';
import { api, type DashboardSectionResult, type ObservatoryResponse } from '../lib/api-client';
import { isCaseStale } from '../lib/case-staleness';
import { isTerminalCaseStatus } from '../lib/lifecycle-stages';
import type { Case } from '@arbitra/shared';

// ---------------------------------------------------------------------------
// Pure composition function — exported for unit testing.
//
// Given the raw aggregate payload returned by `/api/dashboard`, derive the
// same shape the hook has historically returned. Tested directly with
// Vitest; the hook just wraps this with SWR + auth.
// ---------------------------------------------------------------------------

export interface DashboardAggregatePayload {
  myCases: DashboardSectionResult<{ cases: Case[] }>;
  needs_human_decision: DashboardSectionResult<{ cases: Case[] }>;
  verification_pending: DashboardSectionResult<{ cases: Case[] }>;
  observatory: DashboardSectionResult<ObservatoryResponse>;
}

export interface DashboardComposition {
  myCases: Case[];
  attentionCases: Case[];
  staleCases: Case[];
  metrics: ObservatoryResponse['summary'] | null;
  /**
   * Number of cases that have reached a terminal state (approved + rejected +
   * done) — the denominator behind `metrics.approval_rate`. `0` means no
   * decision has happened yet (brand-new / empty workspace), which lets the UI
   * render a 0% rate as neutral rather than alarm-red. See #664.
   */
  decidedCount: number;
  recentActivity: ObservatoryResponse['recent_activity'];
  sectionErrors: {
    myCases: string | null;
    needs_human_decision: string | null;
    verification_pending: string | null;
    observatory: string | null;
  };
  firstError: string | null;
}

export function composeDashboard(
  data: DashboardAggregatePayload | undefined,
): DashboardComposition {
  const myCasesSection = data?.myCases;
  const needsDecisionSection = data?.needs_human_decision;
  const verificationSection = data?.verification_pending;
  const observatorySection = data?.observatory;

  const myCases = myCasesSection?.ok ? myCasesSection.data.cases : [];
  const needsDecisionCases = needsDecisionSection?.ok ? needsDecisionSection.data.cases : [];
  const verificationCases = verificationSection?.ok ? verificationSection.data.cases : [];
  const observatory = observatorySection?.ok ? observatorySection.data : null;

  const attentionCases = [...needsDecisionCases, ...verificationCases];

  const activeMyCases = myCases.filter(
    (c) => c.status !== 'done' && c.status !== 'rejected',
  );

  const staleCases = activeMyCases.filter((c) => isCaseStale(c));

  const sectionErrors = {
    myCases: myCasesSection && !myCasesSection.ok ? myCasesSection.error : null,
    needs_human_decision:
      needsDecisionSection && !needsDecisionSection.ok ? needsDecisionSection.error : null,
    verification_pending:
      verificationSection && !verificationSection.ok ? verificationSection.error : null,
    observatory: observatorySection && !observatorySection.ok ? observatorySection.error : null,
  };

  const firstError =
    sectionErrors.myCases ||
    sectionErrors.needs_human_decision ||
    sectionErrors.verification_pending ||
    sectionErrors.observatory ||
    null;

  // Decided = terminal cases (approved + rejected + done). This is the exact
  // denominator the backend uses for `approval_rate`, so `0` distinguishes a
  // brand-new workspace ("no data yet") from a genuinely stalled pipeline.
  const byStatus = observatory?.cases_by_status ?? {};
  const decidedCount =
    (byStatus['approved'] ?? 0) + (byStatus['rejected'] ?? 0) + (byStatus['done'] ?? 0);

  return {
    myCases: activeMyCases,
    attentionCases,
    staleCases,
    metrics: observatory?.summary ?? null,
    decidedCount,
    recentActivity: observatory?.recent_activity ?? [],
    sectionErrors,
    firstError,
  };
}

// ---------------------------------------------------------------------------
// Polling cadence.
//
// Mirrors the dynamic interval used by `useCases`: while ANY case in the
// three case-bearing sections is still moving (non-terminal), poll at
// 1500ms so users watching active work see progress live. Once everything
// visible has landed on `done`/`rejected`, drop back to 60s. Idle default
// (no data yet) uses the slower cadence to avoid spamming during load.
// ---------------------------------------------------------------------------

const FAST_INTERVAL_MS = 1500;
const SLOW_INTERVAL_MS = 60000;

export function dashboardRefreshInterval(
  data: DashboardAggregatePayload | undefined,
): number {
  if (!data) return SLOW_INTERVAL_MS;
  const sections = [data.myCases, data.needs_human_decision, data.verification_pending];
  for (const section of sections) {
    if (!section?.ok) continue;
    for (const c of section.data.cases) {
      if (!isTerminalCaseStatus(c.status)) return FAST_INTERVAL_MS;
    }
  }
  return SLOW_INTERVAL_MS;
}

// SWR config used by `useDashboard`. Exported so tests can assert
// revalidateOnFocus and the dynamic cadence without needing a React DOM.
export const dashboardSwrConfig = {
  refreshInterval: (latest: DashboardAggregatePayload | undefined) =>
    dashboardRefreshInterval(latest),
  revalidateOnFocus: true,
} as const;

// Collect deduped pending_merge cases across all case-bearing sections.
// Only cases with `current_pr_ref` are eligible (matches useCases semantics).
export function collectPendingMergeCases(
  data: DashboardAggregatePayload | undefined,
): Case[] {
  if (!data) return [];
  const seen = new Set<string>();
  const out: Case[] = [];
  const sections = [data.myCases, data.needs_human_decision, data.verification_pending];
  for (const section of sections) {
    if (!section?.ok) continue;
    for (const c of section.data.cases) {
      if (c.status !== 'pending_merge') continue;
      if (!c.current_pr_ref) continue;
      if (seen.has(c.case_id)) continue;
      seen.add(c.case_id);
      out.push(c);
    }
  }
  return out;
}

/**
 * Dashboard hook — single-request fan-in.
 *
 * Fires one fetch to `/api/dashboard` which composes the same four sections
 * previously fetched in parallel by the client (`myCases`,
 * `needs_human_decision`, `verification_pending`, observatory). Each section
 * is settled independently on the server, so one failing sub-query yields
 * partial data rather than a whole-dashboard failure.
 *
 * Return shape is unchanged for consumers.
 */
export function useDashboard() {
  const { user } = useAuth();
  const uid = user?.uid;

  // Keyed by uid so switching accounts re-fetches, and null until auth is
  // ready (SWR skips null keys).
  const { data, isLoading, error: fetchError, mutate } = useSWR(
    uid ? ['dashboard', uid] : null,
    () => api.dashboard.get(),
    dashboardSwrConfig,
  );

  // Auto-sync merge status for pending_merge cases so dashboard self-heals
  // stale `pending_merge` state (same effect as `useCases`).
  const syncedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!data) return;

    const pending = collectPendingMergeCases(data);
    const pendingIds = new Set(pending.map((c) => c.case_id));

    // Remove stale entries (cases no longer in pending_merge)
    for (const id of syncedRef.current) {
      if (!pendingIds.has(id)) syncedRef.current.delete(id);
    }

    const toSync = pending.filter((c) => !syncedRef.current.has(c.case_id));
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

  const composed = composeDashboard(data);
  const error = fetchError ?? (composed.firstError ? new Error(composed.firstError) : null);

  return {
    myCases: composed.myCases,
    attentionCases: composed.attentionCases,
    staleCases: composed.staleCases,
    metrics: composed.metrics,
    decidedCount: composed.decidedCount,
    recentActivity: composed.recentActivity,
    isLoading,
    error,
    // Per-section error flags for UI that wants to render partial data.
    sectionErrors: composed.sectionErrors,
  };
}
