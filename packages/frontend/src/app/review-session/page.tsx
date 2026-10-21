'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { CaseFilters, UserRole } from '@arbitra/shared';
import { useAuth } from '../../providers/auth-provider';
import { useToast } from '../../providers/toast-provider';
import { useCases } from '../../hooks/use-cases';
import { useProjectMap } from '../../hooks/use-projects';
import { useActiveRuns } from '../../hooks/use-runs';
import { useUserRoles } from '../../hooks/use-user-roles';
import {
  TRIAGE_VIEW_LABELS,
  TRIAGE_VIEWS,
  type TriageView,
} from '../../lib/triage-views';
import {
  buildReviewSessionQueue,
  getReviewSessionGuidance,
} from '../../lib/review-session';
import { api } from '../../lib/api-client';
import { LifecycleTracker } from '../../components/case/lifecycle-tracker';
import { StatusBadge } from '../../components/shared/status-badge';
import { RiskBadge } from '../../components/shared/risk-badge';
import PriorityBadge from '../../components/shared/priority-badge';
import { TrackBadge } from '../../components/shared/track-badge';
import { UserDisplay } from '../../components/shared/user-display';
import LoadingSpinner from '../../components/shared/loading-spinner';
import { useUserMap } from '../../hooks/use-users';

const FILTER_KEYS = ['status', 'risk_level', 'validation_track', 'priority', 'owner_user_id', 'project_id'] as const;
const REVIEWER_ROLES: readonly UserRole[] = ['reviewer', 'tech_lead', 'admin'];
const DEMO_USER_ID = 'usr_dev';

function isTriageView(value: string | null): value is TriageView {
  return value !== null && (TRIAGE_VIEWS as readonly string[]).includes(value);
}

function defaultViewForRoles(roles: readonly UserRole[]): TriageView {
  return roles.some((role) => REVIEWER_ROLES.includes(role)) ? 'needs-me' : 'my-active';
}

function filtersFromParams(params: URLSearchParams): CaseFilters {
  const filters: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  return filters as CaseFilters;
}

export default function ReviewSessionPage() {
  return (
    <Suspense fallback={<SessionLoading />}>
      <ReviewSessionContent />
    </Suspense>
  );
}

function ReviewSessionContent() {
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const roles = useUserRoles();
  const { addToast } = useToast();
  const projectMap = useProjectMap();
  const { activeRunsByCase } = useActiveRuns();
  const userId = user?.uid ?? DEMO_USER_ID;
  const view = isTriageView(searchParams.get('view'))
    ? searchParams.get('view') as TriageView
    : defaultViewForRoles(roles);
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const { cases, findingCounts, isLoading, error, mutate } = useCases(
    filters,
    { fetchAll: true },
  );
  const [skippedIds, setSkippedIds] = useState<Set<string>>(() => new Set());
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [acting, setActing] = useState<'gate' | 'assign' | null>(null);

  const queue = useMemo(
    () => buildReviewSessionQueue(cases, view, {
      userId,
      roles,
      findingCounts,
      skippedCaseIds: skippedIds,
    }),
    [cases, view, userId, roles, findingCounts, skippedIds],
  );

  useEffect(() => {
    if (queue.length === 0) {
      if (selectedCaseId !== null) setSelectedCaseId(null);
      return;
    }
    if (!selectedCaseId || !queue.some((case_) => case_.case_id === selectedCaseId)) {
      setSelectedCaseId(queue[0]!.case_id);
    }
  }, [queue, selectedCaseId]);

  const selectedIndex = selectedCaseId
    ? queue.findIndex((case_) => case_.case_id === selectedCaseId)
    : -1;
  const index = selectedIndex >= 0 ? selectedIndex : 0;
  const currentCase = queue[index] ?? null;
  const userIds = useMemo(() => {
    if (!currentCase) return [];
    return [
      currentCase.owner_user_id,
      ...(currentCase.assigned_reviewer_id ? [currentCase.assigned_reviewer_id] : []),
    ];
  }, [currentCase]);
  const userMap = useUserMap(userIds);
  const guidance = currentCase
    ? getReviewSessionGuidance(currentCase, view, { userId, roles, findingCounts })
    : null;
  const activeRuns = currentCase ? activeRunsByCase[currentCase.case_id] ?? [] : [];
  const boardHref = `/board${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;

  async function handleApproveGate() {
    if (!currentCase?.pending_gate) return;
    setActing('gate');
    try {
      await api.cases.submitDecision(currentCase.case_id, {
        case_id: currentCase.case_id,
        type: 'gate_confirmed',
        rationale: `Confirmed gate ${currentCase.pending_gate.gate_id} to proceed to ${currentCase.pending_gate.target_status}`,
      });
      addToast('success', 'Gate confirmed');
      await mutate();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to confirm gate');
    } finally {
      setActing(null);
    }
  }

  async function handleAssignToMe() {
    if (!currentCase || !user) return;
    setActing('assign');
    try {
      await api.cases.update(currentCase.case_id, { assigned_reviewer_id: user.uid });
      addToast('success', 'Assigned to you');
      await mutate();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to assign case');
    } finally {
      setActing(null);
    }
  }

  function handleSkip() {
    if (!currentCase) return;
    setSkippedIds((prev) => {
      const next = new Set(prev);
      next.add(currentCase.case_id);
      return next;
    });
    addToast('info', 'Skipped for this session');
  }

  function resetSkipped() {
    setSkippedIds(new Set());
    setSelectedCaseId(null);
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-surface-base">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-5 md:px-6 md:py-6">
        <header className="flex flex-col gap-3 border-b border-gray-200 pb-4 dark:border-border-subtle md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Link href={boardHref} className="hover:text-accent-700 dark:hover:text-accent-300">
                Board
              </Link>
              <span>/</span>
              <span>{TRIAGE_VIEW_LABELS[view]}</span>
            </div>
            <h1 className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
              Review Session
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-400">
              Work through actionable cases one at a time. Each step explains why Arbitra is asking for attention and when the next move belongs in your local IDE agent.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-gray-200 bg-surface-raised px-3 py-1.5 text-xs font-medium text-gray-600 dark:border-border-subtle dark:text-gray-300">
              {queue.length > 0 ? `${index + 1} of ${queue.length}` : 'No active cases'}
            </span>
            {skippedIds.size > 0 && (
              <button
                type="button"
                onClick={resetSkipped}
                className="rounded-md border border-gray-300 bg-surface-raised px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-surface-base dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                Restore skipped ({skippedIds.size})
              </button>
            )}
          </div>
        </header>

        {isLoading ? (
          <SessionLoading />
        ) : error ? (
          <SessionError message={error.message} boardHref={boardHref} />
        ) : !currentCase || !guidance ? (
          <EmptySession view={view} skippedCount={skippedIds.size} onReset={resetSkipped} boardHref={boardHref} />
        ) : (
          <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <section className="space-y-5">
              <article className="rounded-lg border border-gray-200 bg-surface-raised p-5 shadow-sm dark:border-border-subtle">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Current case
                    </p>
                    <h2 className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">
                      {currentCase.title}
                    </h2>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {currentCase.case_id} · {projectMap[currentCase.project_id] ?? currentCase.project_id}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <StatusBadge status={currentCase.status} />
                    <RiskBadge level={currentCase.risk_level} />
                    <PriorityBadge priority={currentCase.priority} />
                    <TrackBadge track={currentCase.validation_track} />
                  </div>
                </div>

                <div className="mt-5">
                  <LifecycleTracker
                    status={currentCase.status}
                    caseType={currentCase.case_type}
                    variant="compact"
                  />
                </div>

                <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">Owner</dt>
                    <dd className="mt-1 text-gray-900 dark:text-gray-100">
                      <UserDisplay userId={currentCase.owner_user_id} users={userMap} showAvatar />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">Reviewer</dt>
                    <dd className="mt-1 text-gray-900 dark:text-gray-100">
                      {currentCase.assigned_reviewer_id ? (
                        <UserDisplay userId={currentCase.assigned_reviewer_id} users={userMap} showAvatar />
                      ) : (
                        <span className="text-gray-500 dark:text-gray-400">Unassigned</span>
                      )}
                    </dd>
                  </div>
                  {currentCase.current_branch && (
                    <div>
                      <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">Branch</dt>
                      <dd className="mt-1 truncate font-mono text-xs text-gray-700 dark:text-gray-300" title={currentCase.current_branch}>
                        {currentCase.current_branch}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">Signals</dt>
                    <dd className="mt-1 flex flex-wrap gap-1.5">
                      {(findingCounts[currentCase.case_id] ?? 0) > 0 && (
                        <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800">
                          {findingCounts[currentCase.case_id]} finding{findingCounts[currentCase.case_id] === 1 ? '' : 's'}
                        </span>
                      )}
                      {currentCase.pending_gate && (
                        <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800">
                          Gate pending
                        </span>
                      )}
                      {activeRuns.length > 0 && (
                        <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:ring-blue-800">
                          {activeRuns[0]?.run_type.replace(/_/g, ' ')} running
                        </span>
                      )}
                      {(findingCounts[currentCase.case_id] ?? 0) === 0 && !currentCase.pending_gate && activeRuns.length === 0 && (
                        <span className="text-xs text-gray-500 dark:text-gray-400">No extra warnings</span>
                      )}
                    </dd>
                  </div>
                </dl>
              </article>

              <section className="grid gap-4 md:grid-cols-3">
                <GuidanceBlock title="Why this case is here" body={guidance.reason} />
                <GuidanceBlock title="What Arbitra needs next" body={guidance.nextStep} />
                <GuidanceBlock title="What your local agent can do" body={guidance.localAgentHint} accent />
              </section>
            </section>

            <aside className="space-y-4">
              <section className="rounded-lg border border-gray-200 bg-surface-raised p-4 shadow-sm dark:border-border-subtle">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Session Actions</h3>
                <div className="mt-3 flex flex-col gap-2">
                  {currentCase.pending_gate && currentCase.owner_user_id !== userId && (
                    <button
                      type="button"
                      onClick={handleApproveGate}
                      disabled={acting !== null}
                      className="inline-flex justify-center rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {acting === 'gate' ? 'Confirming...' : 'Confirm gate'}
                    </button>
                  )}
                  {!currentCase.assigned_reviewer_id && user && currentCase.status !== 'done' && currentCase.status !== 'rejected' && (
                    <button
                      type="button"
                      onClick={handleAssignToMe}
                      disabled={acting !== null}
                      className="inline-flex justify-center rounded-md border border-gray-300 bg-surface-raised px-3 py-2 text-sm font-medium text-gray-700 hover:bg-surface-base disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      {acting === 'assign' ? 'Assigning...' : 'Assign to me'}
                    </button>
                  )}
                  <Link
                    href={`/cases/${currentCase.case_id}/courtroom`}
                    className="inline-flex justify-center rounded-md bg-accent-700 px-3 py-2 text-sm font-medium text-white hover:bg-accent-800"
                  >
                    Open Courtroom
                  </Link>
                  <Link
                    href={`/cases/${currentCase.case_id}`}
                    className="inline-flex justify-center rounded-md border border-gray-300 bg-surface-raised px-3 py-2 text-sm font-medium text-gray-700 hover:bg-surface-base dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    Open full case
                  </Link>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedCaseId(queue[Math.max(0, index - 1)]?.case_id ?? null)}
                    disabled={index === 0}
                    className="rounded-md border border-gray-300 bg-surface-raised px-3 py-2 text-sm font-medium text-gray-700 hover:bg-surface-base disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedCaseId(queue[Math.min(queue.length - 1, index + 1)]?.case_id ?? null)}
                    disabled={index >= queue.length - 1}
                    className="rounded-md border border-gray-300 bg-surface-raised px-3 py-2 text-sm font-medium text-gray-700 hover:bg-surface-base disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    Next
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleSkip}
                  className="mt-2 w-full rounded-md px-3 py-2 text-sm font-medium text-gray-500 hover:bg-surface-base hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                >
                  Skip for this session
                </button>
              </section>

              <section className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
                <h3 className="font-semibold">Use the web UI and local agent together</h3>
                <p className="mt-2 text-xs leading-relaxed">
                  Arbitra records lifecycle, evidence, and decisions. Your local agent is better for branch-aware work: reading the diff, editing code, running tests, collecting logs, and registering evidence through MCP.
                </p>
              </section>
            </aside>
          </section>
        )}
      </div>
    </div>
  );
}

function GuidanceBlock({ title, body, accent = false }: { title: string; body: string; accent?: boolean }) {
  return (
    <section
      className={`rounded-lg border p-4 ${
        accent
          ? 'border-blue-200 bg-blue-50 dark:border-blue-900/60 dark:bg-blue-950/30'
          : 'border-gray-200 bg-surface-raised dark:border-border-subtle'
      }`}
    >
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-400">{body}</p>
    </section>
  );
}

function SessionLoading() {
  return (
    <div className="flex min-h-[22rem] items-center justify-center rounded-lg border border-gray-200 bg-surface-raised dark:border-border-subtle">
      <div className="flex flex-col items-center gap-3">
        <LoadingSpinner size="md" />
        <p className="text-sm text-gray-500 dark:text-gray-400">Building review queue...</p>
      </div>
    </div>
  );
}

function SessionError({ message, boardHref }: { message: string; boardHref: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center dark:border-red-900/60 dark:bg-red-950/30">
      <h2 className="text-sm font-semibold text-red-900 dark:text-red-200">Failed to load review session</h2>
      <p className="mt-1 text-sm text-red-700 dark:text-red-300">{message}</p>
      <Link href={boardHref} className="mt-4 inline-flex text-sm font-medium text-red-800 underline dark:text-red-200">
        Back to board
      </Link>
    </div>
  );
}

function EmptySession({
  view,
  skippedCount,
  onReset,
  boardHref,
}: {
  view: TriageView;
  skippedCount: number;
  onReset: () => void;
  boardHref: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-surface-raised p-8 text-center dark:border-border-subtle">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        No cases left in {TRIAGE_VIEW_LABELS[view]}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
        This view has no active, unskipped cases for the current filters. Try another triage view or return to the board.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {skippedCount > 0 && (
          <button
            type="button"
            onClick={onReset}
            className="rounded-md border border-gray-300 bg-surface-raised px-3 py-2 text-sm font-medium text-gray-700 hover:bg-surface-base dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Restore skipped
          </button>
        )}
        <Link href={boardHref} className="rounded-md bg-accent-700 px-3 py-2 text-sm font-medium text-white hover:bg-accent-800">
          Back to board
        </Link>
      </div>
    </div>
  );
}
