'use client';

import Link from 'next/link';
import type { MissionControlSessionRow } from '@arbitra/shared';
import { StatusBadge } from '../shared/status-badge';
import { RelativeTime } from '../shared/relative-time';

interface MissionControlSessionListProps {
  sessions: MissionControlSessionRow[];
  /**
   * Sessions dropped by the server-side row cap (issue #1003), beyond what
   * `sessions` already holds. 0 (or omitted) renders no indicator — this is
   * an explicit "and N more" notice, never a silent truncation.
   */
  truncatedCount?: number;
}

/**
 * Live session list (issue #989): active sessions grouped by project, each
 * row showing agent, branch, and case (linked, with its status badge) or
 * "No case yet" when the branch has no case bound.
 *
 * Pure presentational component — no data fetching — so it can be tested
 * with a plain `sessions` prop, independent of the page's polling.
 */
export function MissionControlSessionList({ sessions, truncatedCount = 0 }: MissionControlSessionListProps) {
  if (sessions.length === 0) {
    return (
      <div className="bg-surface-raised rounded-lg border border-gray-200 dark:border-border-subtle shadow-sm p-8 text-center">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          No agents active right now
        </h3>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">
          Mission Control shows agent sessions as they happen — which agent, on which branch, in
          which case. Sessions appear here once an agent with the Arbitra session-signal hook
          starts working in a repository.
        </p>
      </div>
    );
  }

  const byProject = new Map<string, { project_name: string; rows: MissionControlSessionRow[] }>();
  for (const row of sessions) {
    const bucket = byProject.get(row.project_id) ?? { project_name: row.project_name, rows: [] };
    bucket.rows.push(row);
    byProject.set(row.project_id, bucket);
  }
  const groups = [...byProject.entries()].sort((a, b) => a[1].project_name.localeCompare(b[1].project_name));

  return (
    <div className="space-y-6">
      {groups.map(([projectId, group]) => (
        <div
          key={projectId}
          className="bg-surface-raised rounded-lg border border-gray-200 dark:border-border-subtle shadow-sm overflow-hidden"
        >
          <div className="px-5 py-3 border-b border-gray-200 dark:border-border-subtle bg-surface-base/40">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
              {group.project_name}
            </h3>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-border-subtle">
            {group.rows.map((row) => (
              <div
                key={row.session_id}
                className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-5 py-3"
              >
                <span className="flex items-center gap-2 min-w-0 sm:w-48 shrink-0">
                  <span
                    className="h-2 w-2 rounded-full bg-corp-green animate-pulse shrink-0"
                    aria-hidden="true"
                  />
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {row.agent_name}
                  </span>
                </span>
                <span className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate sm:w-56 shrink-0">
                  {row.repository_name}@{row.branch}
                </span>
                <span className="flex items-center gap-2 min-w-0 flex-1">
                  {row.case ? (
                    <>
                      <Link
                        href={`/cases/${row.case.case_id}`}
                        className="text-sm text-gray-700 dark:text-gray-200 hover:text-accent dark:hover:text-accent truncate"
                      >
                        {row.case.title}
                      </Link>
                      <StatusBadge status={row.case.status} caseType={row.case.case_type} />
                    </>
                  ) : (
                    <span className="text-xs text-gray-400 dark:text-gray-500 italic">
                      No case yet
                    </span>
                  )}
                </span>
                <RelativeTime
                  timestamp={row.last_seen_at}
                  prefix="seen"
                  className="text-xs text-gray-400 dark:text-gray-500 shrink-0 sm:ml-auto"
                />
              </div>
            ))}
          </div>
        </div>
      ))}
      {truncatedCount > 0 && (
        <p className="text-center text-xs text-gray-500 dark:text-gray-400">
          and {truncatedCount} more session{truncatedCount === 1 ? '' : 's'}
        </p>
      )}
    </div>
  );
}
