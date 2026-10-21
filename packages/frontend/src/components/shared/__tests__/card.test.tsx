/**
 * @file card primitive — structural tests.
 *
 * Locks the prop surface:
 *   - default tag is <div>, overridable via `as`
 *   - className merges after defaults (caller wins on conflict order)
 *   - light + dark surface tokens both render
 *   - padding scale resolves to the right tailwind token
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Card from '../card';

describe('Card', () => {
  it('renders children inside a div by default', () => {
    const html = renderToStaticMarkup(<Card>hello</Card>);
    expect(html).toContain('<div');
    expect(html).toContain('hello');
  });

  it('honours the `as` prop for semantic tags', () => {
    const section = renderToStaticMarkup(<Card as="section">x</Card>);
    const article = renderToStaticMarkup(<Card as="article">x</Card>);
    expect(section).toContain('<section');
    expect(article).toContain('<article');
  });

  it('emits the surface-raised semantic token + border tokens', () => {
    const html = renderToStaticMarkup(<Card>x</Card>);
    expect(html).toContain('bg-surface-raised');
    expect(html).toContain('border-gray-200');
    expect(html).toContain('dark:border-border-subtle');
    expect(html).toContain('rounded-lg');
  });

  it('defaults padding to `md` (= p-6, the spec default)', () => {
    const html = renderToStaticMarkup(<Card>x</Card>);
    expect(html).toContain('p-6');
  });

  it('resolves the padding scale', () => {
    expect(renderToStaticMarkup(<Card padding="none">x</Card>)).not.toMatch(/\bp-\d/);
    expect(renderToStaticMarkup(<Card padding="compact">x</Card>)).toContain('p-4');
    expect(renderToStaticMarkup(<Card padding="sm">x</Card>)).toContain('p-4');
    expect(renderToStaticMarkup(<Card padding="lg">x</Card>)).toContain('p-8');
  });

  it('defaults elevation to flat (no shadow)', () => {
    expect(renderToStaticMarkup(<Card>x</Card>)).not.toContain('shadow');
  });

  it('emits shadow-sm when elevation="raised"', () => {
    const html = renderToStaticMarkup(<Card elevation="raised">x</Card>);
    expect(html).toContain('shadow-sm');
  });

  it('adds a hover affordance when interactive', () => {
    const html = renderToStaticMarkup(<Card interactive>x</Card>);
    expect(html).toContain('transition-shadow');
    expect(html).toContain('hover:shadow-md');
    expect(html).toContain('hover:-translate-y-0.5');
  });

  it('omits the hover affordance by default', () => {
    const html = renderToStaticMarkup(<Card>x</Card>);
    expect(html).not.toContain('hover:shadow-md');
    expect(html).not.toContain('hover:-translate-y-0.5');
  });

  it('appends className after the defaults (caller wins on conflict order)', () => {
    const html = renderToStaticMarkup(
      <Card elevation="raised" interactive className="custom-x">
        x
      </Card>,
    );
    expect(html).toContain('custom-x');
    expect(html).toContain('rounded-lg');
    // className is merged last, so it appears after the variant classes.
    const className = html.match(/class="([^"]*)"/)?.[1] ?? '';
    expect(className.indexOf('custom-x')).toBeGreaterThan(className.indexOf('shadow-sm'));
    expect(className.indexOf('custom-x')).toBeGreaterThan(className.indexOf('hover:shadow-md'));
  });

  it('forwards arbitrary HTML props (e.g. data-*, role)', () => {
    const html = renderToStaticMarkup(
      <Card data-testid="my-card" role="region">
        x
      </Card>,
    );
    expect(html).toContain('data-testid="my-card"');
    expect(html).toContain('role="region"');
  });
});
