'use client';

/**
 * Conversation-first body for an `assistant_task` case page.
 *
 * The product complaint this answers: a Clerk thread reads as "a chat inside
 * a ticket" — the answer a requester actually wants is the last thing on the
 * page, buried under case-management furniture (cockpit chips, the lifecycle
 * tracker, the full case-metadata header) that a Q&A task rarely needs at a
 * glance. The data model is unchanged; only what renders first changes.
 *
 * Order:
 *   1. `AssistantAnswerPanel` — the answer, its own already-collapsed
 *      "How this answer was produced" tool-trace disclosure, the follow-up
 *      composer (primary — every real thread continues this way), and
 *      feedback (secondary, below it).
 *   2. `AssistantThreadPanel` — the conversation (request text included: for
 *      the requester, the current turn's `request` renders right here, so
 *      the primary column carries request + answer + thread together).
 *   3. `CaseHeader` — kept unfolded (not inside Record) on purpose. It is
 *      the only place a non-requester viewer (e.g. an admin) sees the
 *      request text at all, since `AssistantThreadPanel` renders nothing
 *      for them; it also carries the pending-gate approve/reject banner and
 *      the edit/delete/export actions, which must stay one scroll away, not
 *      behind an extra click.
 *   4. `CaseRecordDisclosure` (collapsed by default) — the governance
 *      artifacts: the lifecycle tracker and risk/priority/blocker chips
 *      (via `CaseCockpitHero`), the blocker deep-list, the evidence list,
 *      the event timeline, the active-run banner, and the last-decision
 *      summary. Nothing here is removed from the page — the Proof and
 *      Timeline tabs below (rendered by the case page exactly as for any
 *      other case type) still carry the canonical, deep-linkable copies of
 *      evidence/findings/decisions/events. Evidence and the timeline are
 *      additionally mounted here because the task named them explicitly;
 *      they share this page's already-fetched data and SWR cache keys, so
 *      opening Record costs no extra request.
 */

import type { Case, CaseEvent, Finding, Run } from '@arbitra/shared';
import { AssistantAnswerPanel } from './assistant-answer-panel';
import { AssistantThreadPanel } from './assistant-thread-panel';
import { CaseHeader } from './case-header';
import { CaseCockpitHero } from './case-cockpit-hero';
import { BlockerStrip } from './blocker-strip';
import { EvidencePanel } from './evidence-panel';
import { EventTimeline } from './event-timeline';
import { ActiveRunBanner } from './active-run-banner';
import { DecisionContextPanel } from './decision-context-panel';
import { CaseRecordDisclosure } from './case-record-disclosure';

interface AssistantCaseDetailProps {
  caseData: Case;
  events?: CaseEvent[];
  findings: Finding[];
  runs: Run[];
  relatedCounts: {
    evidence: number;
    decisions: number;
    comments: number;
    related: number;
  };
  onTransition: () => void;
}

export function AssistantCaseDetail({
  caseData,
  events,
  findings,
  runs,
  relatedCounts,
  onTransition,
}: AssistantCaseDetailProps) {
  const caseId = caseData.case_id;

  return (
    <>
      <AssistantAnswerPanel caseData={caseData} events={events} runs={runs} />
      <AssistantThreadPanel caseData={caseData} />
      <CaseHeader
        caseData={caseData}
        events={events}
        findings={findings}
        relatedCounts={relatedCounts}
        onTransition={onTransition}
      />
      <CaseRecordDisclosure>
        <CaseCockpitHero caseData={caseData} findings={findings} events={events} />
        <BlockerStrip findings={findings} caseId={caseId} />
        <EvidencePanel caseId={caseId} />
        <EventTimeline events={events ?? []} caseId={caseId} runs={runs} />
        <ActiveRunBanner runs={runs} caseId={caseId} />
        <DecisionContextPanel caseId={caseId} />
      </CaseRecordDisclosure>
    </>
  );
}

export default AssistantCaseDetail;
