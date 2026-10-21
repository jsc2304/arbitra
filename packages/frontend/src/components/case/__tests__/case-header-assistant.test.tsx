/**
 * @file case-header — the source-repository row and the Clerk placeholder.
 *
 * A Clerk task's `repository_id` points at the no-source placeholder document its
 * Clerk core provisions, so the row can only ever read
 * `clerk-no-source-repository…`. Suppression keys on that repository, not on the
 * case type, which is what the third test is for: an `assistant_task` created
 * through the API in an engineering project has a real repository and must still
 * link it.
 *
 * Node-only render (renderToStaticMarkup, no jsdom). The header's heavy children
 * are replaced with markers: they each pull their own SWR/provider tree, none of
 * them renders the metadata row under test.
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
vi.mock('../../../hooks/use-projects', () => ({ useProjectMap: () => ({ proj_clerk_x: 'Clerk' }) }));
// Both documents exactly as they are stored: the placeholder carries
// `CLERK_REPOSITORY_URL`, which is what marks it as having no source.
vi.mock('../../../hooks/use-repositories', () => ({
  useRepositoryMap: () => ({
    repo_clerk_x: {
      repository_id: 'repo_clerk_x',
      name: 'clerk-no-source-repository-placeholder',
      url: 'https://clerk-placeholder.invalid/no-source-repository',
    },
    repo_app: { repository_id: 'repo_app', name: 'arbitra-app', url: 'https://github.com/f/arbitra-app' },
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
    case_id: 'case_1',
    title: 'A case',
    description: 'A request',
    status: 'done',
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
    ...over,
  } as Case;
}

describe('CaseHeader source-repository row', () => {
  it('omits it when the repository is the Clerk placeholder', () => {
    const html = renderToStaticMarkup(
      <CaseHeader caseData={caseData({ case_type: 'assistant_task' })} onTransition={vi.fn()} />,
    );

    expect(html).not.toContain('Repo:');
    expect(html).not.toContain('clerk-no-source-repository');
    // The rest of the metadata row is untouched.
    expect(html).toContain('Clerk Task');
    expect(html).toContain('Project:');
  });

  it('keeps it for every other case type', () => {
    const html = renderToStaticMarkup(
      <CaseHeader
        caseData={caseData({ case_type: 'bugfix', repository_id: 'repo_app' })}
        onTransition={vi.fn()}
      />,
    );

    expect(html).toContain('Repo:');
    expect(html).toContain('arbitra-app');
  });

  it('keeps it for an assistant task that has a real repository', () => {
    const html = renderToStaticMarkup(
      <CaseHeader
        caseData={caseData({ case_type: 'assistant_task', repository_id: 'repo_app' })}
        onTransition={vi.fn()}
      />,
    );

    expect(html).toContain('Repo:');
    expect(html).toContain('arbitra-app');
  });
});
