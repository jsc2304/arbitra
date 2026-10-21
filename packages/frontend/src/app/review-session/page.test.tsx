/**
 * @file Review Session lifecycle consumer regression.
 *
 * The tracker owns the case-type-specific lifecycle projection. This page test
 * pins the consumer contract so assistant cases cannot silently fall back to
 * the engineering lifecycle when the tracker call site changes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Case } from '@arbitra/shared';

const state = vi.hoisted(() => ({
  cases: [] as Case[],
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ user: { uid: 'usr_dev' } }),
}));

vi.mock('../../providers/toast-provider', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock('../../hooks/use-cases', () => ({
  useCases: () => ({
    cases: state.cases,
    findingCounts: {},
    isLoading: false,
    error: null,
    mutate: vi.fn(),
  }),
}));

vi.mock('../../hooks/use-projects', () => ({
  useProjectMap: () => ({}),
}));

vi.mock('../../hooks/use-runs', () => ({
  useActiveRuns: () => ({ activeRunsByCase: {} }),
}));

vi.mock('../../hooks/use-user-roles', () => ({
  useUserRoles: () => [],
}));

vi.mock('../../hooks/use-users', () => ({
  useUserMap: () => ({}),
}));

vi.mock('../../lib/api-client', () => ({
  api: { cases: {} },
}));

vi.mock('../../components/case/lifecycle-tracker', () => ({
  LifecycleTracker: ({
    status,
    caseType,
  }: {
    status: string;
    caseType?: string;
  }) => (
    <div data-status={status} data-case-type={caseType ?? 'missing'} />
  ),
}));

import ReviewSessionPage from './page';

function assistantCase(): Case {
  return {
    case_id: 'case_assistant',
    title: 'Answer a governed question',
    description: 'desc',
    source_type: 'manual',
    source_ref: 'ref',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'usr_dev',
    status: 'in_build',
    case_type: 'assistant_task',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-08-04T07:00:00.000Z',
    updated_at: '2026-08-04T07:01:00.000Z',
  };
}

beforeEach(() => {
  state.cases = [assistantCase()];
});

describe('ReviewSessionPage', () => {
  it('passes an assistant case type to its lifecycle tracker', () => {
    const html = renderToStaticMarkup(<ReviewSessionPage />);

    expect(html).toContain('data-status="in_build"');
    expect(html).toContain('data-case-type="assistant_task"');
  });

  // #674: the root layout already renders `<main id="main">` (#662); this
  // page must not render a second one inside it.
  it('does not render its own <main> landmark', () => {
    const html = renderToStaticMarkup(<ReviewSessionPage />);

    expect(html).not.toContain('<main');
  });
});
