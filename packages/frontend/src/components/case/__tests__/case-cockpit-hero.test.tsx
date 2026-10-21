/**
 * @file case-cockpit-hero — Observed Case rendering (issue #1018 / ADR-0001).
 *
 * Covers:
 *  - The evidence-pending badge never fetches or renders for `case_type:
 *    'observed'` — evidence requirements only exist in the enforced
 *    lifecycle.
 *  - The status pill and lifecycle rail both render the honest "Observing"
 *    label for `in_build` instead of "Building".
 *  - The short escalation note appears only for observed cases.
 *  - The risk badge always reads directly off `caseData.risk_level` — the
 *    same case-document field the board list renders — for both observed
 *    and enforced cases, so the two surfaces can never disagree.
 *  - A non-observed case at the same status renders the unchanged
 *    enforced chrome (regression guard).
 *
 * Node-only render (renderToStaticMarkup, no jsdom). SWR is mocked so the
 * evidence-requirements fetch is observable without a real network layer.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Case } from '@arbitra/shared';

type SWRState = { data?: { missing: string[] } };
const swrState: SWRState = { data: { missing: ['diff_url'] } };
let lastSWRKey: unknown;

vi.mock('swr', () => ({
  default: (key: unknown) => {
    lastSWRKey = key;
    return key ? swrState : { data: undefined };
  },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));

vi.mock('../../../lib/api-client', () => ({
  api: { cases: { evidenceRequirements: vi.fn() } },
}));

import { CaseCockpitHero } from '../case-cockpit-hero';

function caseData(over: Partial<Case>): Case {
  return {
    case_id: 'case-thin-beam-Ay-l',
    title: 'Observed: main',
    description: 'Auto-created by Arbitra from agent activity on acme-archive-poc @ main.',
    status: 'in_build',
    case_type: 'observed',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'system:observed-case',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    source_type: 'git',
    source_ref: 'main',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    jira_refs: [],
    decision_ready: false,
    created_at: '2026-08-27T11:24:55.007Z',
    updated_at: '2026-08-27T12:27:21.717Z',
    ...over,
  } as Case;
}

describe('CaseCockpitHero — Observed Case (issue #1018)', () => {
  it('never fetches evidence requirements for an observed case', () => {
    lastSWRKey = 'not-yet-rendered';
    renderToStaticMarkup(<CaseCockpitHero caseData={caseData({})} />);
    expect(lastSWRKey).toBeNull();
  });

  it('hides the evidence-pending badge for an observed case', () => {
    const html = renderToStaticMarkup(<CaseCockpitHero caseData={caseData({})} />);
    expect(html).not.toContain('evidence pending');
    expect(html).not.toContain('evidence gap');
  });

  it('shows the honest "Observing" label instead of "Building"', () => {
    const html = renderToStaticMarkup(<CaseCockpitHero caseData={caseData({})} />);
    expect(html).toContain('Observing');
    expect(html).not.toContain('>Building<');
  });

  it('shows a short escalation note for an observed case', () => {
    const html = renderToStaticMarkup(<CaseCockpitHero caseData={caseData({})} />);
    expect(html.toLowerCase()).toContain('escalat');
    expect(html).toContain('Observed Case');
  });

  it('renders the risk badge straight from caseData.risk_level (the case document)', () => {
    const html = renderToStaticMarkup(
      <CaseCockpitHero caseData={caseData({ risk_level: 'low' })} />,
    );
    expect(html).toContain('Risk: Low');
    expect(html).not.toContain('Risk: Medium');
  });

  it('fetches evidence requirements and shows the badge for a non-observed case (regression guard)', () => {
    lastSWRKey = 'not-yet-rendered';
    const html = renderToStaticMarkup(
      <CaseCockpitHero caseData={caseData({ case_type: 'bugfix', risk_level: 'medium' })} />,
    );
    expect(lastSWRKey).not.toBeNull();
    expect(html).toContain('evidence pending');
    expect(html).not.toContain('Observed Case');
    expect(html).toContain('>Building<');
    expect(html).toContain('Risk: Medium');
  });
});
