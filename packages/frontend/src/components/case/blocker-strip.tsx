'use client';

/**
 * Blocker Strip for `/cases/[caseId]` (UI/UX 3-bets plan 1.4).
 *
 * Compact, informational strip listing open high/critical findings directly
 * beneath the decision-cockpit hero (PR #237). The hero already shows a
 * count-only "blocker" tile; this strip is the deep-list counterpart — the
 * first N blockers with severity chip, title, and a deep link into the
 * courtroom with that finding preselected.
 *
 * Display-only: no mutation affordances. Status changes happen inside the
 * courtroom.
 *
 * Degradation:
 *   - Empty / no blockers → returns `null` (invisible on happy-path cases).
 *   - > N blockers → shows a trailing "+X more" pill linking into the
 *     courtroom (no preselection — "see all").
 *
 * Deep-link format: rows link to `/cases/<id>/courtroom?finding=<id>`; the
 * courtroom reads the `finding` param and preselects it in the left list,
 * rendering the detail in the center pane.
 */

import Link from 'next/link';
import type { Finding } from '@arbitra/shared';
import { SeverityBadge } from '../shared/severity-badge';
import { isBlocking } from '../../lib/finding-selectors';
import { buildCourtroomFindingHref } from '../../app/cases/[caseId]/courtroom/resolve-finding-selection';

export interface BlockerStripProps {
  findings: Finding[];
  caseId: string;
  /** Max number of blocker rows to render inline. Default 3. */
  maxVisible?: number;
}

export function BlockerStrip({ findings, caseId, maxVisible = 3 }: BlockerStripProps) {
  const blockers = findings.filter(isBlocking);
  if (blockers.length === 0) return null;

  // Critical first, then high — match user mental model of urgency.
  const sorted = [...blockers].sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === 'critical' ? -1 : 1;
  });

  const visible = sorted.slice(0, maxVisible);
  const overflow = sorted.length - visible.length;

  const headingId = `blocker-strip-heading-${caseId}`;
  const courtroomHref = `/cases/${caseId}/courtroom`;

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-orange-200 dark:border-orange-800 bg-orange-50/60 dark:bg-orange-900/15 px-3 py-2.5 md:px-4 md:py-3"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3
          id={headingId}
          className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-orange-800 dark:text-orange-300"
        >
          <svg
            className="h-3.5 w-3.5 flex-shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.8}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
          Blockers
          <span className="ml-1 inline-flex items-center justify-center rounded-full bg-orange-200 dark:bg-orange-800/60 px-1.5 py-0.5 text-xs font-semibold text-orange-900 dark:text-orange-200">
            {sorted.length}
          </span>
        </h3>
      </div>

      <ul role="list" className="flex flex-col gap-1.5">
        {visible.map((finding) => (
          <li key={finding.finding_id} role="listitem">
            <Link
              href={buildCourtroomFindingHref(caseId, finding.finding_id)}
              className="group flex items-center gap-2 rounded-md bg-surface-raised dark:bg-surface-raised px-2.5 py-1.5 text-sm hover:bg-orange-100/70 dark:hover:bg-orange-900/30 transition-colors border border-transparent hover:border-orange-200 dark:hover:border-orange-800"
              title={finding.title}
            >
              <SeverityBadge severity={finding.severity} />
              <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100 group-hover:text-orange-900 dark:group-hover:text-orange-200">
                {finding.title}
              </span>
              <svg
                className="h-3.5 w-3.5 flex-shrink-0 text-gray-400 dark:text-gray-500 group-hover:text-orange-700 dark:group-hover:text-orange-300"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
            </Link>
          </li>
        ))}
        {overflow > 0 && (
          <li role="listitem">
            <Link
              href={courtroomHref}
              className="inline-flex items-center gap-1 rounded-full bg-orange-100 dark:bg-orange-900/40 px-2.5 py-1 text-xs font-medium text-orange-800 dark:text-orange-200 hover:bg-orange-200 dark:hover:bg-orange-900/60 transition-colors"
            >
              +{overflow} more
              <svg
                className="h-3 w-3"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
            </Link>
          </li>
        )}
      </ul>
    </section>
  );
}

export default BlockerStrip;
