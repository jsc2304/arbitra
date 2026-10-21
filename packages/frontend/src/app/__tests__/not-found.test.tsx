/**
 * @file not-found — branded 404 page rendering tests.
 *
 * Vanilla Next.js 404 chrome used to leak on unknown routes. Lock that the branded page renders the 404 affordance + a
 * back-to-board CTA. Static markup via renderToStaticMarkup (node-only).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// next/link in static-markup tests just renders an anchor.
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    <a href={href} className={className}>{children}</a>,
}));

import NotFound from '../not-found';

describe('NotFound', () => {
  const html = renderToStaticMarkup(<NotFound />);

  it('renders a "404" affordance', () => {
    expect(html).toContain('404');
  });

  it('renders the headline copy', () => {
    expect(html).toContain('Page not found');
  });

  it('renders a back-to-board CTA linking to /board', () => {
    expect(html).toMatch(/href="\/board"[^>]*>[^<]*Back to board/);
  });

  it('renders a secondary Dashboard link to /', () => {
    expect(html).toMatch(/href="\/"[^>]*>[^<]*Dashboard/);
  });
});
