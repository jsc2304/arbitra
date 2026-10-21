/**
 * @file MissionControlSessionList (issue #989): grouping by project, case
 * link + status badge vs. "No case yet", and the empty state. Node-only per
 * the frontend convention (renderToStaticMarkup, no jsdom).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MissionControlSessionRow } from '@arbitra/shared';
import { MissionControlSessionList } from './mission-control-session-list';

function row(overrides: Partial<MissionControlSessionRow> = {}): MissionControlSessionRow {
  return {
    session_id: 'sess_1',
    agent_name: 'claude-code',
    repository_id: 'repo_1',
    repository_name: 'arbitra-app',
    project_id: 'proj_1',
    project_name: 'Project A',
    branch: 'feat/foo',
    case: null,
    last_seen_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('MissionControlSessionList', () => {
  it('renders the empty state explaining Mission Control when there are no sessions', () => {
    // Reverting the `sessions.length === 0` early return would fall through
    // to the group-rendering branch and this explanatory copy would be
    // absent, failing this assertion.
    const html = renderToStaticMarkup(<MissionControlSessionList sessions={[]} />);
    expect(html).toContain('No agents active right now');
    expect(html).toContain('session-signal hook');
  });

  it('groups sessions by project, using the project name as the group heading', () => {
    // Reverting the `byProject` grouping (e.g. flattening rows into a
    // single list) would drop the per-project heading, failing this
    // assertion.
    const html = renderToStaticMarkup(
      <MissionControlSessionList
        sessions={[
          row({ session_id: 's1', project_id: 'proj_1', project_name: 'Project A' }),
          row({ session_id: 's2', project_id: 'proj_2', project_name: 'Project B', branch: 'feat/b' }),
        ]}
      />,
    );
    expect(html).toContain('Project A');
    expect(html).toContain('Project B');
  });

  it('shows "No case yet" for a session on a branch with no bound case', () => {
    // Reverting the `row.case ? (...) : (...)` branch (or always rendering
    // the case link) would fail this assertion.
    const html = renderToStaticMarkup(
      <MissionControlSessionList sessions={[row({ case: null })]} />,
    );
    expect(html).toContain('No case yet');
  });

  it('links to the case and shows its status badge when a case is bound', () => {
    // Reverting the case-bound branch's `<Link href={`/cases/${...}`}>` (or
    // dropping the StatusBadge) would fail these assertions.
    const html = renderToStaticMarkup(
      <MissionControlSessionList
        sessions={[
          row({
            case: { case_id: 'case_bound', title: 'Bound case title', status: 'in_review', case_type: 'other' },
          }),
        ]}
      />,
    );
    expect(html).toContain('/cases/case_bound');
    expect(html).toContain('Bound case title');
    expect(html).not.toContain('No case yet');
  });

  it('shows the agent name and repository@branch for each session', () => {
    // Reverting the row's agent_name / repository_name / branch
    // interpolation would drop these strings from the row markup.
    const html = renderToStaticMarkup(
      <MissionControlSessionList
        sessions={[row({ agent_name: 'codex', repository_name: 'arbitra-mcp', branch: 'fix/xyz' })]}
      />,
    );
    expect(html).toContain('codex');
    expect(html).toContain('arbitra-mcp@fix/xyz');
  });

  // Issue #1018: Mission Control renders the same `StatusBadge` the case
  // detail page does, so an Observed Case's bound session must show
  // "Observing" — not the generic "Building" label — for consistency.
  it('shows "Observing" (not "Building") for an in_build session bound to an Observed Case', () => {
    const html = renderToStaticMarkup(
      <MissionControlSessionList
        sessions={[
          row({
            case: { case_id: 'case_observed', title: 'Observed: main', status: 'in_build', case_type: 'observed' },
          }),
        ]}
      />,
    );
    expect(html).toContain('Observing');
    expect(html).not.toContain('Building');
  });

  // Issue #1003: the server-side row cap needs an explicit "and N more"
  // indicator, never a silent truncation.
  it('shows an "and N more" indicator when truncatedCount is greater than zero', () => {
    // Reverting the `truncatedCount > 0 && (...)` guard (or the prop
    // default of 0) would either always render the indicator or never
    // render it — either way failing one of these two assertions.
    const html = renderToStaticMarkup(
      <MissionControlSessionList sessions={[row()]} truncatedCount={5} />,
    );
    expect(html).toContain('and 5 more');
  });

  it('shows no truncation indicator when truncatedCount is omitted or zero', () => {
    const html = renderToStaticMarkup(<MissionControlSessionList sessions={[row()]} />);
    expect(html).not.toContain('more session');
  });
});
