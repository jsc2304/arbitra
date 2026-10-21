/**
 * @file case-header — the Courtroom action for Observed vs. enforced cases
 * (issue #1018 / ADR-0001).
 *
 * The Courtroom is meaningless pre-escalation: an Observed Case has no
 * findings to judge and no gate to confirm. Both the active ("Enter
 * Courtroom") and read-only variants must be absent for `case_type:
 * 'observed'`, and reappear the moment `case_type` is anything else — the
 * header keys off `case_type`, not off how the case was created.
 *
 * Node-only render (renderToStaticMarkup, no jsdom), mirroring
 * case-header-assistant.test.tsx's mock set.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Case } from '@arbitra/shared';
import { CaseHeader } from '../case-header';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('../../../lib/api-client', () => ({
  api: { cases: { syncMerge: vi.fn(() => Promise.resolve({ merged: false })), delete: vi.fn() } },
}));

vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('../../../hooks/use-users', () => ({ useUserMap: () => ({}) }));
vi.mock('../../../hooks/use-projects', () => ({ useProjectMap: () => ({ proj_1: 'Acme Archive' }) }));
vi.mock('../../../hooks/use-repositories', () => ({
  useRepositoryMap: () => ({
    repo_1: { repository_id: 'repo_1', name: 'acme-archive-poc', url: 'https://github.com/acme/acme-archive-poc' },
  }),
}));
vi.mock('../../../hooks/use-is-admin', () => ({ useIsAdmin: () => ({ isAdmin: false }) }));
vi.mock('../case-delete-dialog', () => ({ CaseDeleteDialog: () => null }));
vi.mock('../case-header-overflow-menu', () => ({ CaseHeaderOverflowMenu: () => null }));
vi.mock('../case-header-export-dropdown', () => ({ ExportDropdown: () => null }));
vi.mock('../case-header-gate-banner', () => ({ GateBanner: () => null }));
vi.mock('../case-header-edit-modal', () => ({ EditCaseModal: () => null }));

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

describe('CaseHeader Courtroom action (issue #1018)', () => {
  it('hides the Courtroom action entirely for an observed case', () => {
    const html = renderToStaticMarkup(
      <CaseHeader caseData={caseData({})} onTransition={vi.fn()} />,
    );

    expect(html).not.toContain('Courtroom');
    expect(html).not.toContain('/courtroom');
  });

  it('shows the (read-only) Courtroom action once escalated, even at the same in_build status', () => {
    // Regression guard: the header keys off case_type, not status and not
    // how the case was created — an escalated case at the same status an
    // Observed Case sits at must get the enforced chrome back.
    const html = renderToStaticMarkup(
      <CaseHeader caseData={caseData({ case_type: 'bugfix', risk_level: 'medium' })} onTransition={vi.fn()} />,
    );

    expect(html).toContain('/cases/case-thin-beam-Ay-l/courtroom');
    expect(html).toContain('Courtroom');
  });

  it('shows the Courtroom action for a non-observed case regardless of case_type value', () => {
    const html = renderToStaticMarkup(
      <CaseHeader caseData={caseData({ case_type: 'other' })} onTransition={vi.fn()} />,
    );

    expect(html).toContain('/cases/case-thin-beam-Ay-l/courtroom');
  });
});
