import type { AgentPresence, Run, RunStatus, RunType } from '@arbitra/shared';

const RUN_TYPE_LABELS: Partial<Record<RunType, string>> = {
  exploration_run: 'Exploration',
  implementation_run: 'Implementation',
  build_run: 'Build',
  review_run: 'AI Review',
  rule_run: 'Rule Check',
  test_run: 'Test',
  evidence_collection_run: 'Evidence',
  manual_validation_run: 'Manual Validation',
};

export function runTypeLabel(runType: RunType | string): string {
  return RUN_TYPE_LABELS[runType as RunType] ?? runType.replace(/_/g, ' ');
}

export function isActiveRun(run: Pick<Run, 'status'>): boolean {
  return run.status === 'running' || run.status === 'pending';
}

export function activeRunsFromMap(activeRunsByCase: Record<string, Run[]>): Run[] {
  return Object.values(activeRunsByCase).flat().filter(isActiveRun);
}

/** Flatten the presence-by-case map into a single list. */
export function presenceFromMap(presenceByCase: Record<string, AgentPresence[]>): AgentPresence[] {
  return Object.values(presenceByCase).flat();
}

/** Distinct cases that currently have at least one live presence row. */
export function presenceCaseCount(presenceByCase: Record<string, AgentPresence[]>): number {
  return Object.values(presenceByCase).filter((rows) => rows.length > 0).length;
}

export function formatRunDuration(startedAt?: string, finishedAt?: string): string | null {
  if (!startedAt || !finishedAt) return null;
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return formatElapsedMs(ms);
}

export function formatRunElapsed(run: Pick<Run, 'started_at' | 'created_at'>, now: Date = new Date()): string {
  const start = new Date(run.started_at ?? run.created_at).getTime();
  const ms = Math.max(0, now.getTime() - start);
  return formatElapsedMs(ms);
}

export function runStatusLabel(status: RunStatus): string {
  if (status === 'running') return 'running';
  if (status === 'pending') return 'queued';
  return status;
}

function formatElapsedMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, ms)}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}
