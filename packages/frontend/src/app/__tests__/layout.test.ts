/**
 * @file `app/layout.tsx` — viewport export contract
 * (rework of PR #712).
 *
 * iOS Safari auto-zooms the page on focus whenever a form control's
 * computed font-size is under 16px, and the zoom persists after blur.
 * Next.js ships a default `width=device-width, initial-scale=1` viewport
 * meta tag even without an explicit `viewport` export, but that default is
 * not reliably honored by iOS Safari — an explicit export is required.
 *
 * We import the real `app/layout.tsx` module (not a re-declared literal)
 * so a reverted/edited export is actually caught. `next/font/google` is
 * mocked because the raw npm package throws outside the Next.js SWC font
 * transform ("Mulish is not a function") — `RootLayout` itself is never
 * rendered, so no other provider/component in the import graph executes
 * browser-only code.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/google', () => ({
  Mulish: () => ({ variable: '--font-mulish' }),
}));

const { viewport } = await import('../layout');

describe('layout viewport export', () => {
  it('sets width=device-width and initialScale=1', () => {
    // Reverting the `export const viewport` block entirely makes this
    // `undefined` and fails here first.
    expect(viewport).toBeDefined();
    expect(viewport.width).toBe('device-width');
    expect(viewport.initialScale).toBe(1);
  });

  it('does not restrict manual pinch-zoom', () => {
    // A `maximumScale` or `userScalable: false` here would disable pinch
    // zoom for every user, which is an accessibility regression — the
    // fix is scoped to killing the unwanted auto-zoom-on-focus only.
    expect(viewport.maximumScale).toBeUndefined();
    expect(viewport.userScalable).toBeUndefined();
  });

  it('does not opt into the safe-area-inset sweep dropped from PR #712', () => {
    // PR #712 paired the viewport export with `viewportFit: 'cover'` to
    // drive an edge-to-edge safe-area padding sweep across ~30 files.
    // That sweep is out of scope here, so `viewportFit` must stay unset
    // (an unset value has no effect on `env(safe-area-inset-*)`).
    expect(viewport.viewportFit).toBeUndefined();
  });
});
