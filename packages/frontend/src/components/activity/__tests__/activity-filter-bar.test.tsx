/**
 * <ActivityFilterBar> — controlled-view tests for the consolidated bar.
 *
 * Tests use `renderToStaticMarkup` (frontend test setup is node-only — no DOM,
 * no fireEvent), so we assert structural markup and emit-on-render behaviour
 * via the `onChange` prop directly. Interactive open-state of the dropdowns
 * is exercised in dedicated DOM-level tests when those land; here we cover:
 *   - mode toggle markup (Signal/Raw both rendered, aria-pressed reflects)
 *   - active-chip strip absent when filter is pristine
 *   - active-chip strip present + Clear All when any dimension is non-default
 *   - chip labels reflect kinds / actors / projects / since / mode
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityFilterBar } from '../activity-filter-bar';
import {
  DEFAULT_MULTI_FILTER,
  type MultiActivityFilter,
} from '../../../lib/activity-feed-presentation';

const noop = () => {};

function bar(
  filter: MultiActivityFilter = DEFAULT_MULTI_FILTER,
  overrides: Partial<{
    entries: Parameters<typeof ActivityFilterBar>[0]['entries'];
    projectOptions: Parameters<typeof ActivityFilterBar>[0]['projectOptions'];
    clientOptions: string[];
  }> = {},
) {
  return renderToStaticMarkup(
    <ActivityFilterBar
      filter={filter}
      onChange={noop}
      entries={overrides.entries ?? []}
      projectOptions={overrides.projectOptions ?? [{ id: 'p1', name: 'Project One' }]}
      clientOptions={overrides.clientOptions ?? ['cursor', 'claude-code']}
    />,
  );
}

describe('ActivityFilterBar — pristine state', () => {
  it('renders both mode buttons with Signal pressed by default', () => {
    const html = bar();
    expect(html).toMatch(/data-testid="activity-mode-signal"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-testid="activity-mode-raw"[^>]*aria-pressed="false"/);
  });

  it('omits the active-chip strip when no refinements are applied', () => {
    const html = bar();
    expect(html).not.toContain('data-testid="activity-filter-chips"');
    expect(html).not.toContain('Clear all');
  });

  it('renders all four dropdown labels in order', () => {
    const html = bar();
    const idxWhat = html.indexOf('What');
    const idxWho = html.indexOf('Who');
    const idxWhere = html.indexOf('Where');
    const idxWhen = html.indexOf('When');
    expect(idxWhat).toBeGreaterThan(0);
    expect(idxWho).toBeGreaterThan(idxWhat);
    expect(idxWhere).toBeGreaterThan(idxWho);
    expect(idxWhen).toBeGreaterThan(idxWhere);
  });
});

describe('ActivityFilterBar — active filters', () => {
  it('shows the chip strip + Clear all once any dimension is non-default', () => {
    const html = bar({
      ...DEFAULT_MULTI_FILTER,
      mode: 'raw',
      kinds: ['finding', 'decision'],
      actors: ['agents', 'cursor'],
      projects: ['p1'],
      since: '7d',
    });
    expect(html).toContain('data-testid="activity-filter-chips"');
    expect(html).toContain('Clear all');
    expect(html).toContain('Mode: Raw');
    expect(html).toContain('When: 7d');
    expect(html).toContain('What: Findings');
    expect(html).toContain('What: Decisions');
    expect(html).toContain('Who: Agents');
    expect(html).toContain('Where: Project One');
  });

  it('flips the mode toggle aria-pressed when in Raw', () => {
    const html = bar({ ...DEFAULT_MULTI_FILTER, mode: 'raw' });
    expect(html).toMatch(/data-testid="activity-mode-raw"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-testid="activity-mode-signal"[^>]*aria-pressed="false"/);
  });

  it('falls back to project_id when the project name is unavailable', () => {
    const html = bar(
      { ...DEFAULT_MULTI_FILTER, projects: ['unknown-project'] },
      { projectOptions: [] },
    );
    expect(html).toContain('Where: unknown-project');
  });
});
