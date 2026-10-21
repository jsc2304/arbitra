/**
 * @file assistant-case-detail — conversation-first ordering for an
 * `assistant_task` case page.
 *
 * Node-only render (renderToStaticMarkup, no jsdom). Every child is replaced
 * with a marker so this test only pins ORDER and what is (not) mounted by
 * default — each child's own behaviour is covered by its own test file.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Case } from '@arbitra/shared';
import { AssistantCaseDetail } from '../assistant-case-detail';

vi.mock('../assistant-answer-panel', () => ({
  AssistantAnswerPanel: () => <div data-testid="marker">MARKER-ANSWER</div>,
}));
vi.mock('../assistant-thread-panel', () => ({
  AssistantThreadPanel: () => <div data-testid="marker">MARKER-THREAD</div>,
}));
vi.mock('../case-header', () => ({
  CaseHeader: () => <div data-testid="marker">MARKER-CASE-HEADER</div>,
}));
vi.mock('../case-cockpit-hero', () => ({
  CaseCockpitHero: () => <div data-testid="marker">MARKER-COCKPIT-HERO</div>,
}));
vi.mock('../blocker-strip', () => ({
  BlockerStrip: () => <div data-testid="marker">MARKER-BLOCKER-STRIP</div>,
}));
vi.mock('../evidence-panel', () => ({
  EvidencePanel: () => <div data-testid="marker">MARKER-EVIDENCE-PANEL</div>,
}));
vi.mock('../event-timeline', () => ({
  EventTimeline: () => <div data-testid="marker">MARKER-EVENT-TIMELINE</div>,
}));
vi.mock('../active-run-banner', () => ({
  ActiveRunBanner: () => <div data-testid="marker">MARKER-ACTIVE-RUN-BANNER</div>,
}));
vi.mock('../decision-context-panel', () => ({
  DecisionContextPanel: () => <div data-testid="marker">MARKER-DECISION-CONTEXT</div>,
}));

function caseData(): Case {
  return {
    case_id: 'case_1',
    title: 'Which cases exist?',
    description: 'Which cases exist in the Payments API project?',
    status: 'done',
    case_type: 'assistant_task',
    project_id: 'proj_clerk_x',
    repository_id: 'repo_clerk_x',
    owner_user_id: 'usr_1',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    source_type: 'manual',
    source_ref: '',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    jira_refs: [],
    decision_ready: false,
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:14.000Z',
  } as Case;
}

const relatedCounts = { evidence: 0, decisions: 0, comments: 0, related: 0 };

describe('AssistantCaseDetail', () => {
  it('renders the answer before the thread before the case header', () => {
    const html = renderToStaticMarkup(
      <AssistantCaseDetail
        caseData={caseData()}
        events={[]}
        findings={[]}
        runs={[]}
        relatedCounts={relatedCounts}
        onTransition={vi.fn()}
      />,
    );

    const answerIdx = html.indexOf('MARKER-ANSWER');
    const threadIdx = html.indexOf('MARKER-THREAD');
    const headerIdx = html.indexOf('MARKER-CASE-HEADER');

    expect(answerIdx).toBeGreaterThan(-1);
    expect(threadIdx).toBeGreaterThan(answerIdx);
    expect(headerIdx).toBeGreaterThan(threadIdx);
  });

  it('does not mount the Record section content until expanded', () => {
    const html = renderToStaticMarkup(
      <AssistantCaseDetail
        caseData={caseData()}
        events={[]}
        findings={[]}
        runs={[]}
        relatedCounts={relatedCounts}
        onTransition={vi.fn()}
      />,
    );

    expect(html).toContain('Record');
    expect(html).not.toContain('MARKER-COCKPIT-HERO');
    expect(html).not.toContain('MARKER-BLOCKER-STRIP');
    expect(html).not.toContain('MARKER-EVIDENCE-PANEL');
    expect(html).not.toContain('MARKER-EVENT-TIMELINE');
    expect(html).not.toContain('MARKER-ACTIVE-RUN-BANNER');
    expect(html).not.toContain('MARKER-DECISION-CONTEXT');
  });
});
