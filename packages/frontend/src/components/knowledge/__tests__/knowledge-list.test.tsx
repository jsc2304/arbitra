/**
 * @file knowledge-list — selected-row highlight rendering tests.
 *
 * Node-only per the frontend convention (renderToStaticMarkup, no jsdom).
 * Asserts the master-detail selected-state wiring added in #659: the row
 * matching `selectedId` gets the accent highlight + `aria-current`, and
 * non-selected rows do not.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KnowledgeAsset } from '@arbitra/shared';

// useCanEditKnowledge fetches `users/me` via SWR/api — stub it so the
// renderer doesn't attempt a network call.
vi.mock('../../../hooks/use-can-edit-knowledge', () => ({
  useCanEditKnowledge: () => true,
}));

import { KnowledgeList } from '../knowledge-list';

function makeAsset(overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  return {
    knowledge_id: 'kn_1',
    title: 'Asset One',
    summary: 'Summary one',
    body: '',
    type: 'pattern',
    status: 'verified',
    scope_type: 'global',
    scope_ref: '',
    trust_level: 3,
    version: 1,
    source_case_refs: [],
    source_decision_refs: [],
    tags: [],
    artifact_refs: [],
    created_by: 'user_1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const ASSETS: KnowledgeAsset[] = [
  makeAsset({ knowledge_id: 'kn_1', title: 'Asset One' }),
  makeAsset({ knowledge_id: 'kn_2', title: 'Asset Two' }),
];

describe('KnowledgeList selected-row highlight', () => {
  it('marks the selected row with aria-current and the accent highlight', () => {
    const html = renderToStaticMarkup(
      <KnowledgeList assets={ASSETS} selectedId="kn_2" onSelect={() => {}} />,
    );

    // Exactly one row carries aria-current.
    const ariaCurrentCount = (html.match(/aria-current="true"/g) ?? []).length;
    expect(ariaCurrentCount).toBe(1);

    // The selected row carries the accent ring/background highlight.
    expect(html).toContain('ring-accent/30');
    expect(html).toContain('bg-accent/10');
  });

  it('renders no selected highlight when nothing is selected', () => {
    const html = renderToStaticMarkup(
      <KnowledgeList assets={ASSETS} selectedId={null} onSelect={() => {}} />,
    );

    expect(html).not.toContain('aria-current="true"');
    expect(html).not.toContain('ring-accent/30');
  });

  // Status-filter toggle accessibility (#662).
  it('reflects the active status filter via aria-pressed', () => {
    const html = renderToStaticMarkup(<KnowledgeList assets={ASSETS} />);
    // Default filter is "all" → exactly one pressed toggle, the rest unpressed.
    const pressedCount = (html.match(/aria-pressed="true"/g) ?? []).length;
    const unpressedCount = (html.match(/aria-pressed="false"/g) ?? []).length;
    expect(pressedCount).toBe(1);
    expect(unpressedCount).toBeGreaterThan(0);
  });

  it('keeps status filters in a horizontal nowrap rail', () => {
    const html = renderToStaticMarkup(<KnowledgeList assets={ASSETS} />);

    expect(html).toContain('scrollbar-subtle');
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('w-max items-center gap-1');
    expect(html).toContain('shrink-0 whitespace-nowrap');
  });

  it('renders each row title in its own block above wrapping metadata', () => {
    const html = renderToStaticMarkup(
      <KnowledgeList
        assets={[
          makeAsset({
            title:
              'Request changes — Restore scroll position to last-viewed material on browser back navigation',
            type: 'implementation_note',
            status: 'suggested',
            scope_type: 'project',
          }),
        ]}
      />,
    );

    expect(html).toContain('text-sm font-semibold leading-snug');
    expect(html).toContain('flex flex-wrap items-center gap-1.5');
    expect(html).not.toContain('flex items-center justify-between gap-3');
  });
});
