/**
 * @file `<Button>` — render-contract tests for the shared button primitive
 * (issue #654).
 *
 * The frontend test setup is intentionally node-only / SSR
 * (`renderToStaticMarkup`) — no jsdom, no `fireEvent`, no `userEvent`. We
 * therefore assert on the rendered markup: the key token class per variant,
 * the loading spinner + disabled state, the native `disabled` attribute, the
 * default `type`, and that a `className` override survives the merge (it is
 * appended LAST). See `case-delete-dialog.test.tsx` for the same pattern.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, type ButtonVariant } from '../button';

describe('Button', () => {
  it('renders its children', () => {
    const html = renderToStaticMarkup(<Button>Save</Button>);
    expect(html).toContain('Save');
  });

  it('defaults to type="button"', () => {
    const html = renderToStaticMarkup(<Button>Go</Button>);
    expect(html).toMatch(/<button[^>]*type="button"/);
  });

  it('honours an explicit type="submit"', () => {
    const html = renderToStaticMarkup(<Button type="submit">Submit</Button>);
    expect(html).toMatch(/<button[^>]*type="submit"/);
  });

  it.each<[ButtonVariant, string]>([
    ['primary', 'bg-accent-700'],
    ['secondary', 'border-border-default'],
    ['ghost', 'hover:bg-surface-base'],
    ['link', 'hover:underline'],
    ['danger', 'bg-red-600'],
    ['warning', 'bg-amber-500'],
    ['success', 'bg-corp-green-dark'],
  ])('variant=%s renders the expected key class', (variant, expectedClass) => {
    const html = renderToStaticMarkup(<Button variant={variant}>x</Button>);
    expect(html).toContain(expectedClass);
  });

  it('defaults to the primary variant', () => {
    const html = renderToStaticMarkup(<Button>x</Button>);
    expect(html).toContain('bg-accent-700');
  });

  it.each<['xs' | 'sm' | 'md', string]>([
    ['xs', 'px-2.5'],
    ['sm', 'px-3'],
    ['md', 'px-4'],
  ])('size=%s renders the expected padding class', (size, expectedClass) => {
    const html = renderToStaticMarkup(<Button size={size}>x</Button>);
    expect(html).toContain(expectedClass);
  });

  it('loading disables the button and shows a spinner', () => {
    const html = renderToStaticMarkup(<Button loading>Saving</Button>);
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain('animate-spin');
    // The label is retained while loading.
    expect(html).toContain('Saving');
  });

  it('does not render a spinner when not loading', () => {
    const html = renderToStaticMarkup(<Button>Idle</Button>);
    expect(html).not.toContain('animate-spin');
  });

  it('renders the native disabled attribute when disabled', () => {
    const html = renderToStaticMarkup(<Button disabled>x</Button>);
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it('merges a className override last so call sites can extend', () => {
    const html = renderToStaticMarkup(<Button className="custom-z-override">x</Button>);
    expect(html).toContain('custom-z-override');
    // Base + variant classes are still present alongside the override.
    expect(html).toContain('bg-accent');
    // The override appears after the computed classes in the class attribute.
    const classMatch = html.match(/class="([^"]*)"/);
    expect(classMatch).not.toBeNull();
    const classList = classMatch?.[1] ?? '';
    expect(classList.indexOf('custom-z-override')).toBeGreaterThan(classList.indexOf('bg-accent'));
  });

  it('applies w-full when fullWidth is set', () => {
    const html = renderToStaticMarkup(<Button fullWidth>x</Button>);
    expect(html).toContain('w-full');
  });

  it('uses square padding for iconOnly', () => {
    const html = renderToStaticMarkup(
      <Button iconOnly aria-label="Close">
        <span>×</span>
      </Button>,
    );
    expect(html).toContain('p-2');
    expect(html).not.toContain('px-4');
  });

  it('supports a circular icon-only launcher without radius overrides', () => {
    const html = renderToStaticMarkup(
      <Button shape="circle" iconOnly aria-label="Open assistant">A</Button>,
    );

    expect(html).toContain('rounded-full');
    expect(html).not.toContain('rounded-md');
  });

  it('warns when iconOnly is used without an accessible name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderToStaticMarkup(<Button iconOnly>×</Button>);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('does not warn when iconOnly has an aria-label', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderToStaticMarkup(
      <Button iconOnly aria-label="Close">
        ×
      </Button>,
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('renders left and right icons around the label', () => {
    const html = renderToStaticMarkup(
      <Button leftIcon={<span>L</span>} rightIcon={<span>R</span>}>
        mid
      </Button>,
    );
    expect(html).toContain('L');
    expect(html).toContain('mid');
    expect(html).toContain('R');
    expect(html.indexOf('L')).toBeLessThan(html.indexOf('mid'));
    expect(html.indexOf('mid')).toBeLessThan(html.indexOf('R'));
  });
});
