/**
 * @file case detail page — which body an `assistant_task` case gets vs.
 * every other case type.
 *
 * Node-only render (renderToStaticMarkup, no jsdom, no clicks). Every child
 * component is replaced with a marker so this test only pins WHICH branch
 * renders and, for the non-assistant branch, that the marker ORDER is
 * unchanged from before this PR — not each child's own internals, which are
 * covered by their own test files (including `assistant-case-detail.test.tsx`
 * for the conversation-first ordering itself).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Case } from '@arbitra/shared';

const { caseState } = vi.hoisted(() => ({
  caseState: { data: null as Case | null },
}));

vi.mock('swr', () => ({ default: () => ({ data: undefined, error: undefined, isLoading: false, mutate: vi.fn() }) }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ caseId: 'case_1' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('../../../hooks/use-case', () => ({
  useCase: () => ({
    caseData: caseState.data,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
}));

vi.mock('../../../hooks/use-projects', () => ({ useProjectMap: () => ({}) }));

vi.mock('../../../lib/api-client', () => ({
  api: {
    cases: { findings: vi.fn(), events: vi.fn(), comments: vi.fn(), related: vi.fn(), evidence: vi.fn(), decisions: vi.fn() },
    runs: { listForCase: vi.fn() },
  },
}));

vi.mock('../../../components/shared/breadcrumb', () => ({
  Breadcrumb: () => <div data-testid="marker">MARKER-BREADCRUMB</div>,
}));
vi.mock('../../../components/case/case-header', () => ({
  CaseHeader: () => <div data-testid="marker">MARKER-CASE-HEADER</div>,
}));
vi.mock('../../../components/case/active-run-banner', () => ({
  ActiveRunBanner: () => <div data-testid="marker">MARKER-ACTIVE-RUN-BANNER</div>,
}));
vi.mock('../../../components/case/case-cockpit-hero', () => ({
  CaseCockpitHero: () => <div data-testid="marker">MARKER-COCKPIT-HERO</div>,
}));
vi.mock('../../../components/case/blocker-strip', () => ({
  BlockerStrip: () => <div data-testid="marker">MARKER-BLOCKER-STRIP</div>,
}));
vi.mock('../../../components/case/proof-tab', () => ({
  ProofTab: () => <div data-testid="marker">MARKER-PROOF-TAB</div>,
}));
vi.mock('../../../components/case/assistant-case-detail', () => ({
  AssistantCaseDetail: () => <div data-testid="marker">MARKER-ASSISTANT-CASE-DETAIL</div>,
}));
vi.mock('../../../components/case/decision-context-panel', () => ({
  DecisionContextPanel: () => <div data-testid="marker">MARKER-DECISION-CONTEXT</div>,
}));

import CasePage from './page';

function baseCase(over: Partial<Case>): Case {
  return {
    case_id: 'case_1',
    title: 'A case',
    description: 'A request',
    status: 'open',
    project_id: 'proj_1',
    repository_id: 'repo_1',
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
    ...over,
  } as Case;
}

beforeEach(() => {
  caseState.data = null;
});

describe('CasePage body selection', () => {
  it('renders AssistantCaseDetail for an assistant_task case, not the standard blocks', () => {
    caseState.data = baseCase({ case_type: 'assistant_task' });

    const html = renderToStaticMarkup(<CasePage />);

    expect(html).toContain('MARKER-ASSISTANT-CASE-DETAIL');
    expect(html).not.toContain('MARKER-COCKPIT-HERO');
    expect(html).not.toContain('MARKER-BLOCKER-STRIP');
    expect(html).not.toContain('MARKER-CASE-HEADER');
    expect(html).not.toContain('MARKER-ACTIVE-RUN-BANNER');
    expect(html).not.toContain('MARKER-DECISION-CONTEXT');
  });

  it('renders every other case type exactly as before — same blocks, same order', () => {
    caseState.data = baseCase({ case_type: 'bugfix' });

    const html = renderToStaticMarkup(<CasePage />);

    expect(html).not.toContain('MARKER-ASSISTANT-CASE-DETAIL');

    const order = [
      'MARKER-COCKPIT-HERO',
      'MARKER-BLOCKER-STRIP',
      'MARKER-CASE-HEADER',
      'MARKER-ACTIVE-RUN-BANNER',
      'MARKER-DECISION-CONTEXT',
    ];
    const indices = order.map((marker) => html.indexOf(marker));
    for (const idx of indices) expect(idx).toBeGreaterThan(-1);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
    }
  });

  it('renders no case_type (legacy case) exactly as before too', () => {
    caseState.data = baseCase({ case_type: undefined });

    const html = renderToStaticMarkup(<CasePage />);

    expect(html).not.toContain('MARKER-ASSISTANT-CASE-DETAIL');
    expect(html).toContain('MARKER-CASE-HEADER');
  });
});
