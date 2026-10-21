'use client';

import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import type { Run, User } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useUserMap } from '../../hooks/use-users';
import { SkeletonCard } from '../shared/skeleton';
import ErrorCard from '../shared/error-card';
import { formatRunDuration, formatRunElapsed, isActiveRun, runStatusLabel } from '../../lib/run-display';
import { RelativeTime } from '../shared/relative-time';

interface RunsPanelProps {
  caseId: string;
}

const RUN_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  exploration_run: { label: 'Exploration', color: 'bg-corp-blue-light/15 text-corp-dark dark:bg-corp-blue-light/20 dark:text-corp-blue-light' },
  build_run: { label: 'Build', color: 'bg-corp-yellow/20 text-corp-dark dark:bg-corp-yellow/20 dark:text-corp-yellow-bright' },
  review_run: { label: 'AI Review', color: 'bg-secondary-100 text-secondary-700 dark:bg-secondary-950/50 dark:text-secondary-300' },
  rule_run: { label: 'Rule Check', color: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300' },
  test_run: { label: 'Test', color: 'bg-corp-green/10 text-corp-dark dark:bg-corp-green/20 dark:text-corp-green' },
  evidence_collection_run: { label: 'Evidence', color: 'bg-corp-teal/10 text-corp-dark dark:bg-corp-teal/20 dark:text-corp-teal-bright' },
  manual_validation_run: { label: 'Manual Validation', color: 'bg-corp-orange/10 text-corp-dark dark:bg-corp-orange/20 dark:text-corp-orange' },
};

const STATUS_STYLES: Record<string, string> = {
  completed: 'text-corp-dark dark:text-corp-green',
  failed: 'text-corp-dark dark:text-corp-red',
  running: 'text-corp-dark dark:text-corp-yellow-bright',
  pending: 'text-gray-500 dark:text-gray-400',
  cancelled: 'text-gray-400 dark:text-gray-500',
};

function extractModelName(model: unknown): string {
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object') {
    const obj = model as Record<string, unknown>;
    if (typeof obj.model === 'string') return obj.model;
    if (typeof obj.modelId === 'string') return obj.modelId;
    if (typeof obj.name === 'string') return obj.name;
  }
  return String(model);
}

function formatModel(model: unknown): string {
  // "gemini-2.5-flash" → "Gemini 2.5 Flash"
  return extractModelName(model)
    .replace(/^gemini-/, 'Gemini ')
    .replace(/^gpt-/, 'GPT-')
    .replace(/^claude-/, 'Claude ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isSystemActor(source: string): boolean {
  return source === 'system:pipeline' || source.startsWith('system:');
}

function isLikelyFirebaseUid(source: string): boolean {
  // Firebase UIDs are typically 20-36 alphanumeric chars
  return /^[A-Za-z0-9]{20,}$/.test(source);
}

function RunCard({ run, userMap }: { run: Run; userMap: Record<string, User> }) {
  const typeInfo = RUN_TYPE_LABELS[run.run_type] ?? { label: run.run_type, color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' };
  const active = isActiveRun(run);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const handle = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(handle);
  }, [active]);

  const duration = active
    ? formatRunElapsed(run)
    : formatRunDuration(run.started_at, run.finished_at);

  return (
    <div
      className={`rounded-lg border p-4 ${
        active
          ? 'border-corp-green/30 bg-corp-green/10 shadow-sm dark:border-corp-green/40 dark:bg-corp-green/15'
          : 'border-gray-200 bg-surface-raised dark:border-border-subtle'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold ${typeInfo.color}`}>
            {typeInfo.label}
          </span>
          <span className={`text-xs font-medium ${STATUS_STYLES[run.status] ?? 'text-gray-500'}`}>
            {active && (
              <span className="inline-block h-2 w-2 rounded-full bg-corp-green animate-pulse mr-1" />
            )}
            {runStatusLabel(run.status)}
          </span>
          {duration && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {active ? `active ${duration}` : duration}
            </span>
          )}
        </div>
        <RelativeTime
          timestamp={run.started_at ?? run.created_at}
          className="text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap"
        />
      </div>

      {run.summary && (
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{run.summary}</p>
      )}

      {/* LLM model badge for review runs without full token_usage */}
      {!run.token_usage && run.run_type === 'review_run' && run.summary?.startsWith('Reviewed by ') && (
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold bg-secondary-50 text-secondary-700 dark:bg-secondary-950/50 dark:text-secondary-300 border border-secondary-200 dark:border-secondary-800">
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
            </svg>
            {run.summary.match(/^Reviewed by (.+?) —/)?.[1] ?? 'AI Review'}
          </span>
        </div>
      )}

      {/* LLM details for review runs */}
      {run.token_usage && (
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold bg-secondary-50 text-secondary-700 dark:bg-secondary-950/50 dark:text-secondary-300 border border-secondary-200 dark:border-secondary-800">
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
            </svg>
            {formatModel(run.token_usage.model)}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {run.token_usage.total_tokens.toLocaleString()} tokens
            <span className="text-gray-300 dark:text-gray-600 mx-1">|</span>
            {run.token_usage.prompt_tokens.toLocaleString()} in / {run.token_usage.completion_tokens.toLocaleString()} out
          </span>
        </div>
      )}

      {run.error_message && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded px-2 py-1">
          {run.error_message}
        </p>
      )}

      <div className="mt-2 text-xs text-gray-400 dark:text-gray-500">
        Triggered by: {(() => {
          const src = run.trigger_source;
          if (isSystemActor(src)) return 'Arbitra';
          const user = userMap[src];
          if (user) return user.display_name || user.email || 'via API';
          if (isLikelyFirebaseUid(src)) return 'via API';
          return src;
        })()}
      </div>
    </div>
  );
}

export function RunsPanel({ caseId }: RunsPanelProps) {
  const { data, error, isLoading, mutate } = useSWR(
    caseId ? ['runs', caseId] : null,
    () => api.runs.listForCase(caseId),
  );

  const runs = data?.runs ?? [];

  // Collect trigger_source values that look like Firebase UIDs for batch resolution
  const userIds = useMemo(() => {
    return (data?.runs ?? [])
      .map((r) => r.trigger_source)
      .filter((src) => !isSystemActor(src) && isLikelyFirebaseUid(src));
  }, [data?.runs]);

  const userMap = useUserMap(userIds);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorCard
        title="Failed to load runs"
        message={error instanceof Error ? error.message : String(error)}
        onRetry={() => mutate()}
      />
    );
  }

  if (runs.length === 0) {
    return (
      <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg px-6 py-8 text-center">
        <svg className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
        </svg>
        <p className="mt-2 text-sm font-medium text-gray-700 dark:text-gray-300">No runs yet</p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Runs are created as the case progresses through the lifecycle: exploration, validation, and review.
        </p>
      </div>
    );
  }

  // Sort by created_at descending (most recent first)
  const sorted = [...runs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return (
    <div className="space-y-3">
      {sorted.map((run) => (
        <RunCard key={run.run_id} run={run} userMap={userMap} />
      ))}
    </div>
  );
}
