import type {
  ActivityLeaderboardCounts,
  ActivityLeaderboardRow,
  ActivityProjectLeaderboardRow,
} from '@arbitra/shared';
import { actorDisplayName } from './actor-display';

type CountedLeaderboardEntity = {
  counts: ActivityLeaderboardCounts;
};

type LeaderboardMetricKey = Exclude<keyof ActivityLeaderboardCounts, 'total'>;

interface LeaderboardMetricConfig {
  key: LeaderboardMetricKey;
  label: string;
  barClassName: string;
  chipClassName: string;
  /**
   * Mapping to the canonical {@link import('./activity-url-state').ActivityKind}
   * used by the feed's URL filter. Drives right-rail chip clicks → feed
   * `kinds` filter. `null` for metrics with no clean kind
   * equivalent.
   */
  activityKind: 'lifecycle' | 'finding' | 'decision' | 'evidence' | 'comment' | 'system' | null;
}

export interface LeaderboardContributionSegment extends LeaderboardMetricConfig {
  value: number;
  share: number;
}

const LEADERBOARD_METRICS: LeaderboardMetricConfig[] = [
  {
    key: 'cases_created',
    label: 'Cases',
    barClassName: 'bg-accent',
    chipClassName: 'bg-accent/10 text-accent',
    activityKind: 'lifecycle',
  },
  {
    key: 'comments',
    label: 'Comments',
    barClassName: 'bg-slate-400',
    chipClassName: 'bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-200',
    activityKind: 'comment',
  },
  {
    key: 'evidence',
    label: 'Evidence',
    barClassName: 'bg-emerald-500',
    chipClassName:
      'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
    activityKind: 'evidence',
  },
  {
    key: 'findings',
    label: 'Findings',
    barClassName: 'bg-rose-500',
    chipClassName: 'bg-rose-500/10 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
    activityKind: 'finding',
  },
  {
    key: 'decisions',
    label: 'Decisions',
    barClassName: 'bg-sky-500',
    chipClassName: 'bg-sky-500/10 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
    activityKind: 'decision',
  },
  {
    key: 'workspace_events',
    label: 'System',
    barClassName: 'bg-amber-400',
    chipClassName: 'bg-amber-400/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300',
    activityKind: 'system',
  },
];

const SOURCE_LABELS: Record<Exclude<ActivityLeaderboardRow['source_kind'], 'client'>, string> = {
  human: 'Direct / Unattributed',
  automated: 'CI / Automated',
  webhook: 'Webhook',
  system: 'Arbitra',
};

const SOURCE_DESCRIPTIONS: Record<Exclude<ActivityLeaderboardRow['source_kind'], 'client'>, string> = {
  human: 'Actions without a detected client signature. This can include direct browser usage and any agent writes that did not preserve client metadata.',
  automated: 'CI pipelines, scripts, and machine-authored writes without a user-facing client.',
  webhook: 'Inbound activity attributed to webhook traffic.',
  system: 'Arbitra-originated activity such as schedulers and internal services.',
};

export function isFallbackLeaderboardRow(row: ActivityLeaderboardRow): boolean {
  return row.source_kind !== 'client';
}

export function getLeaderboardSourceLabel(row: ActivityLeaderboardRow): string {
  if (row.source_kind === 'client') {
    return actorDisplayName(undefined, { client_name: row.client_name }).label;
  }
  return SOURCE_LABELS[row.source_kind];
}

export function getLeaderboardSourceDescriptor(row: ActivityLeaderboardRow): string {
  if (row.source_kind !== 'client') {
    return SOURCE_DESCRIPTIONS[row.source_kind];
  }

  const details: string[] = [];
  if (row.client_version) details.push(`v${row.client_version}`);
  if (row.model) details.push(row.model);
  return details.join(' · ') || 'Detected client';
}

export function getLeaderboardContributionSegments(
  entity: CountedLeaderboardEntity,
): LeaderboardContributionSegment[] {
  return LEADERBOARD_METRICS
    .map((metric) => {
      const value = entity.counts[metric.key];
      return {
        ...metric,
        value,
        share: entity.counts.total > 0 ? (value / entity.counts.total) * 100 : 0,
      };
    })
    .filter((segment) => segment.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

export function getLeaderboardShare(entity: CountedLeaderboardEntity, totalEvents: number): number {
  if (totalEvents <= 0) return 0;
  return Math.round((entity.counts.total / totalEvents) * 100);
}

export function describeLeaderboardMix(entity: CountedLeaderboardEntity): string {
  const segments = getLeaderboardContributionSegments(entity);
  if (segments.length === 0) return 'No recorded activity.';
  const primary = segments[0];
  if (!primary) return 'No recorded activity.';
  if (segments.length === 1) return `All ${primary.label.toLowerCase()}.`;
  if (primary.share >= 70) return `Mostly ${primary.label.toLowerCase()}.`;
  return `Mixed activity led by ${primary.label.toLowerCase()}.`;
}

export function splitActivitySourceRows(rows: ActivityLeaderboardRow[]): {
  clientRows: ActivityLeaderboardRow[];
  fallbackRows: ActivityLeaderboardRow[];
} {
  return {
    clientRows: rows.filter((row) => row.source_kind === 'client'),
    fallbackRows: rows.filter((row) => row.source_kind !== 'client'),
  };
}

export function getProjectDisplayName(row: ActivityProjectLeaderboardRow): string {
  return row.project_name ?? row.project_id;
}
