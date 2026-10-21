/**
 * @file sidebar — admin-gated Intelligence entry tests.
 *
 * Node-only rendering via renderToStaticMarkup. We mock next/navigation
 * (usePathname), the launcher provider, and `useIsAdmin` to assert that
 * the "Intelligence" link shows for admins, hides for non-admins, and
 * lights up with `aria-current="page"` on the intelligence route.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const { navState, adminState } = vi.hoisted(() => ({
  navState: { pathname: '/board' },
  adminState: { isAdmin: false, isLoading: false },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navState.pathname,
}));

vi.mock('../../../providers/launcher-provider', () => ({
  useLauncher: () => ({ open: () => {} }),
}));

vi.mock('../../../hooks/use-is-admin', () => ({
  useIsAdmin: () => adminState,
}));

vi.mock('../../../hooks/use-runs', () => ({
  useActiveRuns: () => ({ activeRunsByCase: {}, isLoading: false, error: undefined }),
}));

import { Sidebar } from '../sidebar';

beforeEach(() => {
  navState.pathname = '/board';
  adminState.isAdmin = false;
  adminState.isLoading = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Sidebar', () => {
  it('hides the Intelligence entry for non-admin users', () => {
    adminState.isAdmin = false;
    const html = renderToStaticMarkup(<Sidebar />);
    expect(html).not.toContain('/observatory/intelligence');
    // Parent Observatory link stays visible for everyone.
    expect(html).toContain('href="/observatory"');
  });

  it('shows the Intelligence entry for admin users', () => {
    adminState.isAdmin = true;
    const html = renderToStaticMarkup(<Sidebar />);
    expect(html).toContain('href="/observatory/intelligence"');
    expect(html).toContain('>Intelligence<');
  });

  it('marks Intelligence with aria-current=page on the intelligence route', () => {
    adminState.isAdmin = true;
    navState.pathname = '/observatory/intelligence';
    const html = renderToStaticMarkup(<Sidebar />);
    // React may emit the aria-current attribute before or after `class`,
    // so we match an anchor where both `aria-current="page"` and the
    // intelligence href appear within the same `<a ...>` opening tag.
    const anchors = [...html.matchAll(/<a\s[^>]*>/g)].map((m) => m[0]);
    const intelligenceAnchor = anchors.find((a) =>
      a.includes('href="/observatory/intelligence"'),
    );
    expect(intelligenceAnchor).toBeDefined();
    expect(intelligenceAnchor).toContain('aria-current="page"');
    // The parent Observatory link must NOT steal active styling on the
    // intelligence route — otherwise two sidebar rows would light up.
    const observatoryAnchor = anchors.find(
      (a) =>
        a.includes('href="/observatory"') &&
        !a.includes('href="/observatory/'),
    );
    expect(observatoryAnchor).toBeDefined();
    expect(observatoryAnchor).not.toContain('aria-current="page"');
  });

  it('still marks Observatory active on /observatory itself', () => {
    adminState.isAdmin = true;
    navState.pathname = '/observatory';
    const html = renderToStaticMarkup(<Sidebar />);
    const anchors = [...html.matchAll(/<a\s[^>]*>/g)].map((m) => m[0]);
    const observatoryAnchor = anchors.find(
      (a) =>
        a.includes('href="/observatory"') &&
        !a.includes('href="/observatory/'),
    );
    expect(observatoryAnchor).toBeDefined();
    expect(observatoryAnchor).toContain('aria-current="page"');
  });

  // Landmark + focus accessibility (#662).
  it('labels the aside landmark and the nav', () => {
    const html = renderToStaticMarkup(<Sidebar />);
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('aria-label="Primary navigation"');
  });

  it('gives nav items a >=44px touch target', () => {
    const html = renderToStaticMarkup(<Sidebar />);
    // Every primary/secondary nav link bumps to the 44px min-height target.
    expect(html).toContain('min-h-[44px]');
  });

  it('gives the logo launcher trigger a focus-visible ring', () => {
    const html = renderToStaticMarkup(<Sidebar />);
    expect(html).toContain('focus-visible:ring-accent');
  });
});
