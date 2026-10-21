'use client';

/**
 * Decision-Cockpit Hero for `/cases/[caseId]` (UI/UX 3-bets plan 1.3).
 *
 * Priority-first summary rendered *above* the existing case header + tabs.
 * Shows the user — in a single glance — status, risk, priority, how many
 * blockers exist, and whether required evidence is still missing.
 *
 * Evidence is registered by agents via the `register_evidence` MCP tool;
 * manual human upload is a rare fallback. The evidence-gaps chip doubles
 * as the entry point into the evidence tab — no separate CTA panel is
 * rendered for `provide-evidence`, `submit-decision`, or `merge-pr`, since
 * agent-driven transitions cover the common path and `CaseHeader` renders
 * its own merge-PR button when the case is ready.
 *
 * Reuses the eager `findings` fetch already performed by the page
 * container — no new API calls are introduced by the hero except a single
 * SWR call for `/cases/:id/evidence/requirements` (same request the gate
 * banner makes when owner + pending gate; SWR dedupes it).
 */

import { useMemo, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import {
  isBlockingFindingStatus,
  type Case,
  type CaseEvent,
  type CaseStatus,
  type Finding,
} from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { StatusBadge } from '../shared/status-badge';
import { RiskBadge } from '../shared/risk-badge';
import PriorityBadge from '../shared/priority-badge';
import { LifecycleTracker } from './lifecycle-tracker';
import { getEvidenceLabel } from '../../lib/evidence-labels';

interface CaseCockpitHeroProps {
  caseData: Case;
  findings?: Finding[];
  /**
   * Case event stream — used by the lifecycle strip for entry-timestamp
   * tooltips and click-to-jump into the Timeline tab. Optional: when
   * absent, the strip renders without the rich-tooltip data and dots are
   * non-interactive.
   */
  events?: CaseEvent[];
}

const TERMINAL_STATUSES = new Set(['done', 'rejected']);

function countBySeverity(findings: readonly Finding[]) {
  let high = 0;
  let critical = 0;
  for (const f of findings) {
    if (!isBlockingFindingStatus(f.status)) continue;
    if (f.severity === 'high') high += 1;
    else if (f.severity === 'critical') critical += 1;
  }
  return { high, critical, total: high + critical };
}

function BlockerTile({ high, critical, caseId }: { high: number; critical: number; caseId: string }) {
  const total = high + critical;
  if (total === 0) return null;
  const label = total === 1 ? 'blocker' : 'blockers';
  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical`);
  if (high > 0) parts.push(`${high} high`);
  return (
    <Link
      href={`/cases/${caseId}?tab=findings`}
      className="group inline-flex items-center gap-2 rounded-md border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/20 px-3 py-1.5 text-sm font-medium text-orange-800 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-900/30 transition-colors"
      title={parts.join(', ')}
      aria-label={`${total} blocking ${label} — ${parts.join(', ')}`}
    >
      <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
      </svg>
      <span>
        <span className="font-semibold">{total}</span> {label}
        <span className="hidden sm:inline text-xs font-normal text-orange-700 dark:text-orange-400">
          {' '}({parts.join(', ')})
        </span>
      </span>
    </Link>
  );
}

function EvidenceGapChip({ missing, caseId, status }: { missing: readonly string[]; caseId: string; status: CaseStatus }) {
  if (missing.length === 0) return null;
  const friendly = missing.map((t) => getEvidenceLabel(t)).join(', ');
  const count = missing.length;
  const plural = count > 1 ? 's' : '';
  const isInBuild = status === 'in_build';
  return (
    <Link
      href={`/cases/${caseId}?tab=evidence`}
      className={
        isInBuild
          ? 'inline-flex items-center gap-1.5 rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-2.5 py-1 text-xs font-medium text-blue-800 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/30 hover:border-blue-300 dark:hover:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 transition-colors'
          : 'inline-flex items-center gap-1.5 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30 hover:border-amber-300 dark:hover:border-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1 transition-colors'
      }
      title={isInBuild ? 'Evidence will be attached by the agent when the build completes' : `Missing evidence: ${friendly}`}
      aria-label={isInBuild ? `View ${count} evidence pending` : `View ${count} evidence gap${plural}`}
    >
      <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.745 3.745 0 0 1 3.296-1.043A3.745 3.745 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z" />
      </svg>
      <span>
        <span className="font-semibold">{count}</span> {isInBuild ? `evidence pending` : `evidence gap${plural}`}
      </span>
    </Link>
  );
}

export function CaseCockpitHero({ caseData, findings, events }: CaseCockpitHeroProps) {
  const router = useRouter();
  // Lifecycle-strip click → switch to the Timeline tab (if not already)
  // and deep-link to the matching event via `?event=<id>`. The case page
  // owns the actual scroll-into-view side-effect (data-entity-id lookup)
  // so this surface only changes the URL.
  const handleStageClick = useCallback(
    (eventId: string) => {
      router.replace(`/cases/${caseData.case_id}?tab=timeline&event=${eventId}`, { scroll: false });
    },
    [router, caseData.case_id],
  );
  // Evidence requirements — fetch once per case (SWR dedupes across the hero
  // and the gate banner). Gate the request to non-terminal cases so completed
  // cases don't incur an unnecessary request.
  const isTerminal = TERMINAL_STATUSES.has(caseData.status);
  // Observed Cases (issue #1018 / ADR-0001) never have evidence
  // requirements — evidence gates only exist in the enforced lifecycle, and
  // an Observed Case only reaches it by escalating (case_type flips away
  // from 'observed'). Skip the fetch entirely rather than fetch-then-hide.
  const isObserved = caseData.case_type === 'observed';
  // Panel always fetches; hero suppresses the badge on terminal status.
  const { data: requirements } = useSWR(
    !isTerminal && !isObserved ? ['case-evidence-requirements', caseData.case_id] : null,
    () => api.cases.evidenceRequirements(caseData.case_id),
  );
  const missingEvidence = isObserved ? [] : requirements?.missing ?? [];

  const severity = useMemo(
    () => (findings ? countBySeverity(findings) : { high: 0, critical: 0, total: 0 }),
    [findings],
  );

  return (
    <section
      aria-labelledby="case-cockpit-heading"
      className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-4 md:p-5"
    >
      <h2 id="case-cockpit-heading" className="sr-only">
        Case Cockpit
      </h2>

      {/* Row 1 — chips (risk, priority, blockers, evidence). The evidence
          chip is itself the entry point into the evidence tab; agents
          register evidence via `register_evidence` so no separate CTA is
          needed. */}
      <div className="flex flex-wrap items-center gap-2">
        <span title="Risk level determines the rigor of review: low/medium may auto-approve, high/critical require human decision and four-eyes approval.">
          <RiskBadge level={caseData.risk_level} size="sm" />
        </span>
        <span title="Priority affects ordering in queues and review urgency but does not change the approval rules.">
          <PriorityBadge priority={caseData.priority} size="sm" />
        </span>
        <BlockerTile high={severity.high} critical={severity.critical} caseId={caseData.case_id} />
        <EvidenceGapChip missing={missingEvidence} caseId={caseData.case_id} status={caseData.status} />
      </div>

      {/* Row 2 — primary glance target: the status label is the caption of
          the lifecycle tracker so the "where am I in the lifecycle" question
          is answered in one visual unit. */}
      <div className="mt-4">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Currently in
          </span>
          <StatusBadge status={caseData.status} size="md" caseType={caseData.case_type} />
        </div>
        <LifecycleTracker
          status={caseData.status}
          caseType={caseData.case_type}
          variant="compact"
          showLabels
          events={events}
          onStageClick={handleStageClick}
        />
        {isObserved && (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Observed Case — Arbitra is recording this work without blocking it. Policy escalation
            would move it into the full enforced lifecycle.
          </p>
        )}
      </div>
    </section>
  );
}

export default CaseCockpitHero;
