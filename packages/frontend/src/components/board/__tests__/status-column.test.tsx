/**
 * @file status-column — Kanban column surface regressions.
 *
 * Node-only per the frontend convention (renderToStaticMarkup, no jsdom).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusColumn } from '../status-column';

describe('StatusColumn', () => {
  it('uses the subtle scrollbar utility for overflowing Kanban columns', () => {
    const html = renderToStaticMarkup(
      <StatusColumn
        status="open"
        cases={[]}
        projectMap={{}}
      />,
    );

    expect(html).toContain('scrollbar-subtle');
    expect(html).toContain('overflow-y-auto');
  });
});
