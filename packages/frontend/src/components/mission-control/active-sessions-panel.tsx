'use client';

import type { ActiveSessionsPanel as ActiveSessionsPanelData, ActiveSessionsWindowStats } from '@arbitra/shared';
import Card from '../shared/card';

interface ActiveSessionsPanelProps {
  panel: ActiveSessionsPanelData;
}

const TILES: { key: keyof ActiveSessionsPanelData; label: string }[] = [
  { key: 'window_24h', label: 'Last 24 hours' },
  { key: 'window_7d', label: 'Last 7 days' },
  { key: 'window_30d', label: 'Last 30 days' },
];

/**
 * Active-sessions panel (issue #990 / #981 story 10): three compact stat
 * tiles — 24h / 7d / 30d — each showing session and distinct-user counts,
 * derived from the same session registry as the live Mission Control list
 * above it. No separate analytics pipeline; this is `active_sessions_panel`
 * from `GET /api/mission-control` rendered as-is.
 */
export function ActiveSessionsPanel({ panel }: ActiveSessionsPanelProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="active-sessions-panel">
      {TILES.map(({ key, label }) => (
        <StatTile key={key} label={label} stats={panel[key]} />
      ))}
    </div>
  );
}

function StatTile({ label, stats }: { label: string; stats: ActiveSessionsWindowStats }) {
  return (
    <Card padding="compact" elevation="raised">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-50">
        {stats.sessions}
        <span className="ml-1 text-sm font-normal text-gray-500 dark:text-gray-400">
          {stats.sessions === 1 ? 'session' : 'sessions'}
        </span>
      </p>
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
        {stats.distinct_users} distinct {stats.distinct_users === 1 ? 'user' : 'users'}
      </p>
    </Card>
  );
}
