/**
 * @file activity-cluster-row — expand affordance + project pill tests.
 *
 * Verifies the two UX fixes for grouped activity rows:
 *   1. Caret/chevron + row title area expand the cluster (in addition to the
 *      pre-existing count badge).
 *   2. Project label renders as a pill (ProjectBadge), not plain text.
 *
 * Mirrors the existing activity-entry-row.test.tsx style: static markup
 * assertions via `renderToStaticMarkup` (the frontend test setup is node-only
 * by design — no DOM, no fireEvent). Structural assertions are sufficient to
 * catch the regressions that matter:
 *   - count-badge button still present and labelled (regression guard).
 *   - row header is a role="button" with aria-expanded + aria-controls.
 *   - project label is rendered with the data-testid="project-badge" hook.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivityEntry } from '@arbitra/shared';
import { ActivityClusterRow } from '../activity-feed';
import type { ActivityFeedClusterItem } from '../../../lib/activity-feed-presentation';

const baseEntry: ActivityEntry = {
  id: 'case_event:evt_1',
  kind: 'case_event',
  timestamp: '2026-04-23T12:00:00.000Z',
  case_id: 'case_abc',
  case_title: 'Acme Atlas',
  summary: 'opened case',
  href: '/cases/case_abc',
  project_id: 'proj_1',
  project_name: 'Acme Atlas',
};

const baseCluster: ActivityFeedClusterItem = {
  kind: 'cluster',
  id: 'cluster_1',
  case_id: 'case_abc',
  case_title: 'Acme Atlas',
  href: '/cases/case_abc',
  project_id: 'proj_1',
  project_name: 'Acme Atlas',
  label: 'Cursor opened the case, Cursor opened the case',
  preview: 'merge ready · pr merged · +3 more',
  verbChips: ['opened'],
  countLabel: '6 in 1m',
  latest_timestamp: '2026-04-23T12:00:00.000Z',
  entries: [baseEntry, baseEntry, baseEntry, baseEntry, baseEntry, baseEntry],
};

const noop = () => {};

describe('ActivityClusterRow — expand affordances', () => {
  it('renders the count badge as a button with aria-expanded (regression)', () => {
    const html = renderToStaticMarkup(
      <ActivityClusterRow
        item={baseCluster}
        expanded={false}
        onToggle={noop}
        onProjectClick={noop}
        onActorClick={noop}
      />,
    );
    // Count badge: <button> carrying the entry count and the cluster
    // expand/collapse aria-label.
    expect(html).toMatch(
      /<button[^>]*aria-label="Expand activity cluster"[^>]*>[\s\S]*?6[\s\S]*?<\/button>/,
    );
  });

  it('renders the row header as role="button" with aria-expanded + aria-controls', () => {
    const html = renderToStaticMarkup(
      <ActivityClusterRow
        item={baseCluster}
        expanded={false}
        onToggle={noop}
        onProjectClick={noop}
        onActorClick={noop}
      />,
    );
    // Pressable header overlay — covers chevron, title, project, preview, time.
    // Must be focusable (tabIndex) and announce expanded state.
    expect(html).toMatch(/role="button"[^>]*tabindex="0"/i);
    expect(html).toMatch(/role="button"[^>]*aria-expanded="false"/i);
    expect(html).toMatch(/aria-controls="activity-cluster-panel-cluster_1"/);
  });

  it('flips aria-expanded to true when the cluster is expanded', () => {
    const html = renderToStaticMarkup(
      <ActivityClusterRow
        item={baseCluster}
        expanded
        onToggle={noop}
        onProjectClick={noop}
        onActorClick={noop}
      />,
    );
    // Count-badge button AND the row-header role=button both reflect state.
    expect(html).toMatch(/aria-label="Collapse activity cluster"/);
    expect(html).toMatch(/role="button"[^>]*aria-expanded="true"/i);
    // Expanded panel uses the id referenced by aria-controls.
    expect(html).toMatch(/id="activity-cluster-panel-cluster_1"/);
  });

  it('keeps the chevron present and rotates it when expanded', () => {
    const collapsed = renderToStaticMarkup(
      <ActivityClusterRow
        item={baseCluster}
        expanded={false}
        onToggle={noop}
        onProjectClick={noop}
        onActorClick={noop}
      />,
    );
    const expanded = renderToStaticMarkup(
      <ActivityClusterRow
        item={baseCluster}
        expanded
        onToggle={noop}
        onProjectClick={noop}
        onActorClick={noop}
      />,
    );
    // The chevron path is stable; rotation class is added only when expanded.
    expect(collapsed).toContain('M9 18l6-6-6-6');
    expect(expanded).toContain('M9 18l6-6-6-6');
    expect(expanded).toMatch(/transition-transform[^"]*rotate-90/);
    expect(collapsed).not.toMatch(/transition-transform[^"]*rotate-90/);
  });
});

describe('ActivityClusterRow — project pill', () => {
  it('renders the project label inside a ProjectBadge (data-testid hook)', () => {
    const html = renderToStaticMarkup(
      <ActivityClusterRow
        item={baseCluster}
        expanded={false}
        onToggle={noop}
        onProjectClick={noop}
        onActorClick={noop}
      />,
    );
    // The badge surfaces the project name and exposes a stable testid.
    expect(html).toMatch(
      /data-testid="project-badge"[^>]*>[\s\S]*?Acme Atlas/,
    );
  });

  it('omits the project pill when the cluster has no project_id', () => {
    const html = renderToStaticMarkup(
      <ActivityClusterRow
        item={{ ...baseCluster, project_id: undefined, project_name: undefined }}
        expanded={false}
        onToggle={noop}
        onProjectClick={noop}
        onActorClick={noop}
      />,
    );
    expect(html).not.toContain('data-testid="project-badge"');
  });
});
