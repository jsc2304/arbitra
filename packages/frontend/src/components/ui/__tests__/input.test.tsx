/**
 * @file `<Input>` — render-contract tests for the shared field primitive
 * (issue #655).
 *
 * Same node-only / SSR setup as `button.test.tsx`: no jsdom, no `fireEvent` —
 * we render with `renderToStaticMarkup` and assert on the markup. Covers the
 * polymorphic `as`, the label↔control wiring, the error a11y wiring
 * (`aria-invalid` + red border + `aria-describedby`), the hint, `disabled`,
 * the className-merged-last contract, and native-prop pass-through.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Input } from '../input';

describe('Input', () => {
  it('renders an <input> by default', () => {
    const html = renderToStaticMarkup(<Input />);
    expect(html).toMatch(/<input[^>]*\/?>/);
  });

  it('renders a <textarea> when as="textarea"', () => {
    const html = renderToStaticMarkup(<Input as="textarea" />);
    expect(html).toContain('<textarea');
    // textarea-specific affordance
    expect(html).toContain('resize-y');
  });

  it('renders a <select> when as="select"', () => {
    const html = renderToStaticMarkup(
      <Input as="select">
        <option value="a">A</option>
      </Input>,
    );
    expect(html).toContain('<select');
    expect(html).toContain('<option');
    // select keeps the native chevron but gets an accent tint
    expect(html).toContain('accent-accent');
  });

  it('renders the base token classes on the control', () => {
    const html = renderToStaticMarkup(<Input />);
    expect(html).toContain('border-border-default');
    expect(html).toContain('bg-input-bg');
    expect(html).toContain('focus-visible:ring-accent');
  });

  it('label wires htmlFor to the control id', () => {
    const html = renderToStaticMarkup(<Input label="Title" />);
    const labelFor = html.match(/<label[^>]*for="([^"]+)"/)?.[1];
    const inputId = html.match(/<input[^>]*id="([^"]+)"/)?.[1];
    expect(labelFor).toBeTruthy();
    expect(labelFor).toBe(inputId);
    expect(html).toContain('Title');
  });

  it('respects an explicit id for the label wiring', () => {
    const html = renderToStaticMarkup(<Input id="my-field" label="Name" />);
    expect(html).toMatch(/<label[^>]*for="my-field"/);
    expect(html).toMatch(/<input[^>]*id="my-field"/);
  });

  it('error sets aria-invalid, the red border, and aria-describedby↔message', () => {
    const html = renderToStaticMarkup(<Input id="f" error="Required" />);
    expect(html).toMatch(/<input[^>]*aria-invalid="true"/);
    expect(html).toContain('border-red-500');
    // aria-describedby points at the message <p id>
    const describedby = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedby).toBe('f-error');
    expect(html).toMatch(/<p[^>]*id="f-error"[^>]*>Required<\/p>/);
  });

  it('does not set aria-invalid when there is no error', () => {
    const html = renderToStaticMarkup(<Input />);
    expect(html).not.toContain('aria-invalid');
  });

  it('hint renders below the control and is wired via aria-describedby', () => {
    const html = renderToStaticMarkup(<Input id="g" hint="Optional helper" />);
    expect(html).toContain('Optional helper');
    expect(html).toMatch(/aria-describedby="g-hint"/);
    expect(html).toMatch(/<p[^>]*id="g-hint"/);
  });

  it('error takes precedence over hint', () => {
    const html = renderToStaticMarkup(<Input id="h" hint="helper" error="boom" />);
    expect(html).toContain('boom');
    expect(html).not.toContain('helper');
    expect(html).toMatch(/aria-describedby="h-error"/);
  });

  it('renders the native disabled attribute when disabled', () => {
    const html = renderToStaticMarkup(<Input disabled />);
    expect(html).toMatch(/<input[^>]*disabled/);
  });

  it('size=sm and size=md render the expected padding', () => {
    expect(renderToStaticMarkup(<Input size="sm" />)).toContain('py-1.5');
    expect(renderToStaticMarkup(<Input size="md" />)).toContain('py-2');
  });

  it('sizes render a >=16px font below md so iOS Safari does not auto-zoom on focus', () => {
    // iOS Safari zooms the page in on focus when a form control's computed
    // font-size is under 16px. `text-base` (16px)
    // must render unconditionally and `md:text-sm` must restore the
    // original 14px only at/above the `md` breakpoint. A regression to a
    // bare `text-sm`/`text-xs` (no `text-base` fallback) fails this.
    for (const size of ['sm', 'md'] as const) {
      const html = renderToStaticMarkup(<Input size={size} />);
      const classMatch = html.match(/<input[^>]*class="([^"]*)"/);
      const classList = classMatch?.[1] ?? '';
      expect(classList).toContain('text-base');
      expect(classList).toContain('md:text-sm');
    }
  });

  it('applies the same >=16px focus fix to the textarea and select variants', () => {
    // `<Input as="textarea"|"select">` shares `sizeClasses` with the
    // default `<input>` render, so the same iOS auto-zoom fix must show up
    // on all three controls without a separate per-variant treatment.
    const textareaHtml = renderToStaticMarkup(<Input as="textarea" />);
    const textareaClass = textareaHtml.match(/<textarea[^>]*class="([^"]*)"/)?.[1] ?? '';
    expect(textareaClass).toContain('text-base');
    expect(textareaClass).toContain('md:text-sm');

    const selectHtml = renderToStaticMarkup(
      <Input as="select">
        <option value="a">A</option>
      </Input>,
    );
    const selectClass = selectHtml.match(/<select[^>]*class="([^"]*)"/)?.[1] ?? '';
    expect(selectClass).toContain('text-base');
    expect(selectClass).toContain('md:text-sm');
  });

  it('merges a className override last so call sites can extend', () => {
    const html = renderToStaticMarkup(<Input className="custom-field-override" />);
    expect(html).toContain('custom-field-override');
    expect(html).toContain('bg-input-bg');
    const classMatch = html.match(/<input[^>]*class="([^"]*)"/);
    const classList = classMatch?.[1] ?? '';
    expect(classList.indexOf('custom-field-override')).toBeGreaterThan(
      classList.indexOf('bg-input-bg'),
    );
  });

  it('passes native props (placeholder, value) through to the control', () => {
    const html = renderToStaticMarkup(
      <Input placeholder="Brief title…" defaultValue="hello" />,
    );
    expect(html).toContain('placeholder="Brief title…"');
    expect(html).toContain('value="hello"');
  });

  it('accepts a controlled value with onChange without type error', () => {
    // Compile-time contract: a controlled text field type-checks.
    const html = renderToStaticMarkup(
      <Input value="x" onChange={() => {}} />,
    );
    expect(html).toContain('value="x"');
  });

  it('renders a left icon inside the field wrapper', () => {
    const html = renderToStaticMarkup(<Input leftIcon={<span>L</span>} />);
    expect(html).toContain('L');
    // control gets left padding to clear the icon
    expect(html).toContain('pl-9');
  });
});
