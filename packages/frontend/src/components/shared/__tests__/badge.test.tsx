/**
 * @file `<Badge>` — render-contract tests for the shared badge STRUCTURAL
 * primitive (issue #658).
 *
 * The frontend test setup is node-only / SSR (`renderToStaticMarkup`) — no
 * jsdom. We assert on rendered markup: the locked structure (`rounded-full`,
 * the xs/sm/md size scale, ring-vs-border tone discipline), the dot/icon
 * mutual exclusion (+ dev-mode warning), and that `className` survives the
 * merge (appended LAST). See `ui/__tests__/button.test.tsx` for the pattern.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge, type BadgeSize } from '../badge';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Badge structure', () => {
  it('is always rounded-full (kills the SystemActorPill `rounded` drift)', () => {
    const html = renderToStaticMarkup(<Badge>x</Badge>);
    expect(html).toContain('rounded-full');
    expect(html).not.toMatch(/class="[^"]*\brounded\b(?!-full)/);
  });

  it('carries the shared base structure classes', () => {
    const html = renderToStaticMarkup(<Badge>x</Badge>);
    expect(html).toContain('inline-flex');
    expect(html).toContain('items-center');
    expect(html).toContain('gap-1.5');
    expect(html).toContain('whitespace-nowrap');
    expect(html).toContain('font-medium');
  });

  it('renders its children', () => {
    expect(renderToStaticMarkup(<Badge>Hello</Badge>)).toContain('Hello');
  });
});

describe('Badge size scale (no arbitrary text-[10px]/text-[11px])', () => {
  it.each<[BadgeSize, string]>([
    ['xs', 'px-2 py-0.5 text-xs'],
    ['sm', 'px-2.5 py-0.5 text-xs'],
    ['md', 'px-3 py-1 text-sm'],
  ])('size=%s applies the expected padding + text class', (size, expected) => {
    const html = renderToStaticMarkup(<Badge size={size}>x</Badge>);
    for (const cls of expected.split(' ')) {
      expect(html).toContain(cls);
    }
  });

  it('defaults to the sm size', () => {
    const html = renderToStaticMarkup(<Badge>x</Badge>);
    expect(html).toContain('px-2.5');
    expect(html).toContain('text-xs');
  });

  it('never emits the legacy arbitrary text sizes', () => {
    for (const size of ['xs', 'sm', 'md'] as const) {
      const html = renderToStaticMarkup(<Badge size={size}>x</Badge>);
      expect(html).not.toContain('text-[10px]');
      expect(html).not.toContain('text-[11px]');
    }
  });
});

describe('Badge tone (ring over border)', () => {
  it('soft tone applies ring-1 ring-inset (never a border)', () => {
    const html = renderToStaticMarkup(
      <Badge tone="soft" colorClassName="ring-corp-green/40">
        x
      </Badge>,
    );
    expect(html).toContain('ring-1');
    expect(html).toContain('ring-inset');
    expect(html).not.toMatch(/class="[^"]*\bborder\b/);
  });

  it('outline tone applies a neutral ring', () => {
    const html = renderToStaticMarkup(<Badge tone="outline">x</Badge>);
    expect(html).toContain('ring-1');
    expect(html).toContain('ring-inset');
    expect(html).toContain('ring-gray-200');
  });

  it('solid tone applies no ring', () => {
    const html = renderToStaticMarkup(<Badge tone="solid">x</Badge>);
    expect(html).not.toContain('ring-1');
  });

  it('defaults to the soft tone', () => {
    const html = renderToStaticMarkup(<Badge>x</Badge>);
    expect(html).toContain('ring-1');
    expect(html).toContain('ring-inset');
  });
});

describe('Badge dot / icon (mutually exclusive)', () => {
  it('renders a dot when dot is set', () => {
    const html = renderToStaticMarkup(<Badge dot dotClassName="bg-corp-green">x</Badge>);
    expect(html).toContain('bg-corp-green');
    expect(html).toContain('aria-hidden="true"');
  });

  it('renders the icon when icon is set', () => {
    const html = renderToStaticMarkup(
      <Badge icon={<svg data-testid="cat-icon" />}>x</Badge>,
    );
    expect(html).toContain('data-testid="cat-icon"');
  });

  it('warns and renders the dot only when BOTH dot and icon are passed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = renderToStaticMarkup(
      <Badge dot dotClassName="bg-corp-red" icon={<svg data-testid="should-not-render" />}>
        x
      </Badge>,
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(html).toContain('bg-corp-red');
    expect(html).not.toContain('data-testid="should-not-render"');
  });

  it('does not warn for dot alone or icon alone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderToStaticMarkup(<Badge dot>x</Badge>);
    renderToStaticMarkup(<Badge icon={<svg />}>x</Badge>);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Badge passthrough + merge', () => {
  it('merges className LAST so call-site overrides win', () => {
    const html = renderToStaticMarkup(<Badge className="flex-shrink-0">x</Badge>);
    expect(html).toContain('flex-shrink-0');
  });

  it('passes native span props through (title, data-*)', () => {
    const html = renderToStaticMarkup(
      <Badge title="hover" data-testid="my-badge">
        x
      </Badge>,
    );
    expect(html).toContain('title="hover"');
    expect(html).toContain('data-testid="my-badge"');
  });

  it('applies colorClassName before className', () => {
    const html = renderToStaticMarkup(
      <Badge colorClassName="bg-corp-blue/15" className="bg-override">
        x
      </Badge>,
    );
    expect(html).toContain('bg-corp-blue/15');
    expect(html).toContain('bg-override');
    // className appears after colorClassName in the class string.
    expect(html.indexOf('bg-override')).toBeGreaterThan(html.indexOf('bg-corp-blue/15'));
  });
});
