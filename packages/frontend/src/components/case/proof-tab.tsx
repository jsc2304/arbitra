'use client';

/**
 * Proof tab — consolidates the former Findings, Evidence, and Decisions
 * tabs into a single tab containing three collapsible accordion sections.
 *
 * Each section reuses its existing panel component verbatim (FindingsPanel,
 * EvidencePanel, DecisionHistory). This component only provides:
 *   - The accordion chrome (expand/collapse, header layout).
 *   - At-a-glance header summaries: counts + a status pill mirroring the
 *     pills the panels already show at the top of their bodies (highest
 *     open severity, requirements-satisfied, last decision type).
 *
 * Default state: Findings expanded, Evidence + Decisions collapsed. The
 * `initialExpand` prop lets deep-links (?tab=findings|evidence|decisions)
 * auto-expand exactly one section on mount.
 *
 * Evidence + Decisions data is fetched here (cheap, same endpoints the
 * child panels use — SWR dedupes) so the headers can render counts/pills
 * without drilling props into the children.
 */

import { useState } from 'react';
import useSWR from 'swr';
import type { Finding, FindingSeverity } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { FindingsPanel } from './findings-panel';
import { EvidencePanel } from './evidence-panel';
import { EvidenceSatisfiedPill } from './evidence-satisfied-pill';
import { DecisionHistory } from './decision-history';
import { SeverityBadge } from '../shared/severity-badge';
import { DECISION_TYPE_LABELS } from '../../lib/decision-type-labels';
import { isBlocking } from '../../lib/finding-selectors';
import { isEvidenceSatisfied } from '../../lib/evidence-satisfied';

export type ProofSection = 'findings' | 'evidence' | 'decisions';

interface ProofTabProps {
  caseId: string;
  caseStatus?: string;
  findings: Finding[];
  /** Which section should start expanded. Defaults to 'findings'. */
  initialExpand?: ProofSection;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function highestOpenSeverity(findings: Finding[]): FindingSeverity | null {
  let best: FindingSeverity | null = null;
  for (const f of findings) {
    if (f.status !== 'open') continue;
    if (!best || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best]) {
      best = f.severity;
    }
  }
  return best;
}

interface AccordionItemProps {
  id: ProofSection;
  title: string;
  summary: React.ReactNode;
  isOpen: boolean;
  onToggle: (id: ProofSection) => void;
  children: React.ReactNode;
}

function AccordionItem({ id, title, summary, isOpen, onToggle, children }: AccordionItemProps) {
  const panelId = `proof-panel-${id}`;
  const headerId = `proof-header-${id}`;
  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg overflow-hidden">
      <h3 id={headerId} className="m-0">
        <button
          type="button"
          onClick={() => onToggle(id)}
          aria-expanded={isOpen}
          aria-controls={panelId}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface-base/50 dark:hover:bg-border-subtle/30 transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0">
            <svg
              className={`h-4 w-4 flex-shrink-0 text-gray-400 dark:text-gray-500 transition-transform ${isOpen ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">{summary}</div>
        </button>
      </h3>
      {isOpen && (
        <div id={panelId} role="region" aria-labelledby={headerId} className="border-t border-gray-200 dark:border-border-subtle">
          {children}
        </div>
      )}
    </div>
  );
}

export function ProofTab({ caseId, caseStatus, findings, initialExpand = 'findings' }: ProofTabProps) {
  const [openSections, setOpenSections] = useState<Record<ProofSection, boolean>>({
    findings: initialExpand === 'findings',
    evidence: initialExpand === 'evidence',
    decisions: initialExpand === 'decisions',
  });

  const toggle = (id: ProofSection) => {
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Evidence header stats — reuses the same satisfied logic as EvidencePanel.
  const { data: evidenceData } = useSWR(
    ['evidence', caseId],
    () => api.cases.evidence(caseId),
  );
  const evidence = evidenceData?.evidence ?? [];
  const evidenceSatisfied = isEvidenceSatisfied(caseStatus, evidenceData);

  // Decisions header stats.
  const { data: decisionsData } = useSWR(
    ['decisions', caseId],
    () => api.cases.decisions(caseId),
  );
  const decisions = decisionsData?.decisions ?? [];
  // "Latest" = newest by created_at, which mirrors DecisionContextPanel semantics.
  const latestDecision = decisions.length > 0
    ? [...decisions].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
    : null;

  // Findings summary: open count + highest open severity pill.
  const openFindingsCount = findings.filter((f) => f.status === 'open').length;
  const blockingOpenCount = findings.filter((f) => f.status === 'open' && isBlocking(f)).length;
  const topSeverity = highestOpenSeverity(findings);

  const findingsSummary = (
    <>
      {openFindingsCount === 0 ? (
        <span className="text-xs text-gray-500 dark:text-gray-400">No open findings</span>
      ) : (
        <>
          <span className={`text-xs font-medium ${blockingOpenCount > 0 ? 'text-corp-orange' : 'text-gray-600 dark:text-gray-400'}`}>
            {openFindingsCount} open
          </span>
          {topSeverity && <SeverityBadge severity={topSeverity} />}
        </>
      )}
    </>
  );

  const evidenceSummary = (
    <>
      <span className="text-xs text-gray-600 dark:text-gray-400">
        {evidence.length === 0 ? 'No evidence yet' : `${evidence.length} item${evidence.length === 1 ? '' : 's'}`}
      </span>
      {evidence.length > 0 && <EvidenceSatisfiedPill satisfied={evidenceSatisfied} size="sm" />}
    </>
  );

  const decisionsSummary = (() => {
    if (decisions.length === 0) {
      return <span className="text-xs text-gray-500 dark:text-gray-400">No decisions</span>;
    }
    const cfg = latestDecision
      ? DECISION_TYPE_LABELS[latestDecision.type] ?? {
          label: latestDecision.type,
          className: 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800',
        }
      : null;
    return (
      <>
        <span className="text-xs text-gray-600 dark:text-gray-400">
          {decisions.length} decision{decisions.length === 1 ? '' : 's'}
        </span>
        {cfg && (
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cfg.className}`}>
            {cfg.label}
          </span>
        )}
      </>
    );
  })();

  return (
    <div className="space-y-3">
      <AccordionItem
        id="findings"
        title="Findings"
        summary={findingsSummary}
        isOpen={openSections.findings}
        onToggle={toggle}
      >
        <FindingsPanel findings={findings} />
      </AccordionItem>
      <AccordionItem
        id="evidence"
        title="Evidence"
        summary={evidenceSummary}
        isOpen={openSections.evidence}
        onToggle={toggle}
      >
        <EvidencePanel caseId={caseId} />
      </AccordionItem>
      <AccordionItem
        id="decisions"
        title="Decisions"
        summary={decisionsSummary}
        isOpen={openSections.decisions}
        onToggle={toggle}
      >
        <DecisionHistory caseId={caseId} />
      </AccordionItem>
    </div>
  );
}
