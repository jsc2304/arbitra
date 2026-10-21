/**
 * @file Docs page landmark regression (#674).
 *
 * The root layout already renders `<main id="main">` (#662). This page must
 * not render a second `<main>` inside it — nested main landmarks confuse
 * screen-reader "skip to content" navigation. Pinned as a render-level
 * string check since this page is rendered standalone here (outside the
 * root layout), so a reintroduced `<main>` would otherwise go unnoticed.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import DocsPage from './page';

describe('DocsPage', () => {
  it('does not render its own <main> landmark', () => {
    const html = renderToStaticMarkup(<DocsPage />);

    expect(html).not.toContain('<main');
  });
});
