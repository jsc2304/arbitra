/**
 * @file section-header primitive — structural tests.
 *
 * Locks the prop surface: title renders at the specified type/weight, description is muted,
 * the actions slot is right-aligned, and the heading level is selectable.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import SectionHeader from '../section-header';

describe('SectionHeader', () => {
  it('renders the title in an h2 by default', () => {
    const html = renderToStaticMarkup(<SectionHeader title="Findings" />);
    expect(html).toContain('<h2');
    expect(html).toContain('Findings');
  });

  it('renders an h3 when level={3}', () => {
    const html = renderToStaticMarkup(<SectionHeader title="Sub" level={3} />);
    expect(html).toContain('<h3');
    expect(html).not.toContain('<h2');
  });

  it('forwards `id` onto the heading element for aria-labelledby pairing', () => {
    const html = renderToStaticMarkup(<SectionHeader title="x" id="my-section-heading" />);
    expect(html).toContain('id="my-section-heading"');
  });

  it('applies the spec title typography (text-lg / font-semibold)', () => {
    const html = renderToStaticMarkup(<SectionHeader title="x" />);
    expect(html).toContain('text-lg');
    expect(html).toContain('font-semibold');
    expect(html).toContain('text-gray-900');
    expect(html).toContain('dark:text-gray-100');
  });

  it('renders description in a muted gray below the title', () => {
    const html = renderToStaticMarkup(
      <SectionHeader title="t" description="d" />,
    );
    expect(html).toContain('d');
    expect(html).toContain('text-gray-500');
    expect(html).toContain('dark:text-gray-400');
  });

  it('omits the description node when not provided', () => {
    const html = renderToStaticMarkup(<SectionHeader title="t" />);
    expect(html).not.toContain('<p');
  });

  it('renders the actions slot in a right-aligned flex row', () => {
    const html = renderToStaticMarkup(
      <SectionHeader title="t" actions={<button>Go</button>} />,
    );
    expect(html).toContain('Go');
    // Wrapper uses `justify-between` so the actions slot sits on the right.
    expect(html).toContain('justify-between');
  });

  it('omits the actions wrapper when no actions provided', () => {
    const html = renderToStaticMarkup(<SectionHeader title="t" />);
    expect(html).not.toContain('shrink-0');
  });

  it('appends className after the defaults', () => {
    const html = renderToStaticMarkup(
      <SectionHeader title="t" className="custom-y" />,
    );
    expect(html).toContain('custom-y');
    expect(html).toContain('justify-between');
  });

  describe('eyebrow variant', () => {
    it('renders the title with uppercase tracking-wide treatment', () => {
      const html = renderToStaticMarkup(
        <SectionHeader title="Users" eyebrow />,
      );
      expect(html).toContain('Users');
      expect(html).toContain('uppercase');
      expect(html).toContain('tracking-wide');
      expect(html).toContain('text-gray-700');
      expect(html).toContain('dark:text-gray-300');
    });

    it('does not apply the default title typography in eyebrow mode', () => {
      const html = renderToStaticMarkup(
        <SectionHeader title="Users" eyebrow />,
      );
      // The eyebrow label is `text-sm`, not the default `text-lg` heading.
      expect(html).not.toContain('text-lg');
    });

    it('keeps the title typography when eyebrow is omitted', () => {
      const html = renderToStaticMarkup(<SectionHeader title="Findings" />);
      expect(html).toContain('text-lg');
      expect(html).not.toContain('uppercase');
    });
  });

  describe('count pill', () => {
    it('renders the count in an inline pill next to the title', () => {
      const html = renderToStaticMarkup(
        <SectionHeader title="My Cases" count={7} />,
      );
      expect(html).toContain('My Cases');
      expect(html).toContain('>7<');
      expect(html).toContain('rounded-full');
    });

    it('renders a zero count when explicitly provided', () => {
      const html = renderToStaticMarkup(
        <SectionHeader title="Findings" count={0} />,
      );
      expect(html).toContain('>0<');
    });

    it('omits the count pill when no count is provided', () => {
      const html = renderToStaticMarkup(<SectionHeader title="Findings" />);
      expect(html).not.toContain('rounded-full');
    });

    it('pairs the count pill with the eyebrow variant', () => {
      const html = renderToStaticMarkup(
        <SectionHeader title="Users" eyebrow count={3} />,
      );
      expect(html).toContain('uppercase');
      expect(html).toContain('>3<');
    });
  });
});
