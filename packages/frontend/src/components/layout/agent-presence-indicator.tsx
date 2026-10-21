'use client';

import Link from 'next/link';
import type { AgentPresence, Run } from '@arbitra/shared';
import { useActiveRuns } from '../../hooks/use-runs';
import {
  activeRunsFromMap,
  presenceCaseCount,
  presenceFromMap,
  runTypeLabel,
} from '../../lib/run-display';

interface AgentPresenceIndicatorProps {
  collapsed?: boolean;
}

interface AgentPresencePillProps {
  activeRunsByCase: Record<string, Run[]>;
  presenceByCase?: Record<string, AgentPresence[]>;
  collapsed?: boolean;
}

export function AgentPresenceIndicator({ collapsed = false }: AgentPresenceIndicatorProps) {
  const { activeRunsByCase, presenceByCase } = useActiveRuns();
  return (
    <AgentPresencePill
      activeRunsByCase={activeRunsByCase}
      presenceByCase={presenceByCase}
      collapsed={collapsed}
    />
  );
}

export function AgentPresencePill({
  activeRunsByCase,
  presenceByCase = {},
  collapsed = false,
}: AgentPresencePillProps) {
  const activeRuns = activeRunsFromMap(activeRunsByCase);
  const activeCaseCount = Object.values(activeRunsByCase).filter((runs) =>
    runs.some((run) => run.status === 'pending' || run.status === 'running'),
  ).length;
  const activeRunCount = activeRuns.length;
  const firstRun = activeRuns[0];

  const presenceRows = presenceFromMap(presenceByCase);
  const presenceCases = presenceCaseCount(presenceByCase);
  const presenceCount = presenceRows.length;

  const isActive = activeRunCount > 0 || presenceCount > 0;

  // Title prefers the more concrete signal (live runs) when both are present.
  const title = activeRunCount > 0
    ? `${activeRunCount} active run${activeRunCount === 1 ? '' : 's'} across ${activeCaseCount} case${activeCaseCount === 1 ? '' : 's'}`
    : presenceCount > 0
      ? `${presenceCount} agent${presenceCount === 1 ? '' : 's'} active across ${presenceCases} case${presenceCases === 1 ? '' : 's'}`
      : 'No active agent runs';

  const headline = activeRunCount > 0
    ? `${activeRunCount} active run${activeRunCount === 1 ? '' : 's'}`
    : presenceCount > 0
      ? `${presenceCount} agent${presenceCount === 1 ? '' : 's'} active`
      : 'Agents idle';

  const sub = activeRunCount > 0 && firstRun
    ? `${activeCaseCount} case${activeCaseCount === 1 ? '' : 's'} · ${runTypeLabel(firstRun.run_type)}`
    : presenceCount > 0
      ? `${presenceCases} case${presenceCases === 1 ? '' : 's'} · IDE agent`
      : 'No processing right now';

  if (collapsed) {
    return (
      <Link
        href="/activity"
        title={title}
        aria-label={title}
        className="mx-auto mt-3 flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-surface-base text-gray-400 transition-colors hover:text-gray-700 dark:border-border-subtle dark:bg-surface-base/60 dark:text-gray-500 dark:hover:text-gray-300"
      >
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            isActive ? 'animate-pulse bg-corp-green shadow-[0_0_0_4px_rgba(34,197,94,0.14)]' : 'bg-gray-300 dark:bg-gray-600'
          }`}
          aria-hidden="true"
        />
      </Link>
    );
  }

  return (
    <Link
      href="/activity"
      title={title}
      className={`mx-2 mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
        isActive
          ? 'border-corp-green/30 bg-corp-green/10 text-corp-dark hover:bg-corp-green/15 dark:border-corp-green/40 dark:bg-corp-green/15 dark:text-corp-green'
          : 'border-gray-200 bg-surface-base text-gray-500 hover:text-gray-700 dark:border-border-subtle dark:bg-surface-base/60 dark:text-gray-400 dark:hover:text-gray-300'
      }`}
    >
      <span
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
          isActive ? 'animate-pulse bg-corp-green shadow-[0_0_0_4px_rgba(34,197,94,0.14)]' : 'bg-gray-300 dark:bg-gray-600'
        }`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{headline}</span>
        <span className="block truncate text-[11px] opacity-75">{sub}</span>
      </span>
    </Link>
  );
}
