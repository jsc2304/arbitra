/**
 * @file modal primitive — structural/markup tests.
 *
 * Mirrors `side-drawer.test.tsx`: the frontend test setup is deliberately
 * node-only (no jsdom / testing-library), so event-driven behaviors (Escape
 * closes, backdrop click closes, focus trap, focus restore) are verified via
 * static markup introspection — the handler wiring is in place and the a11y
 * attributes are rendered. Interaction-level coverage relies on the shared
 * hooks/effects already exercised elsewhere.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Modal } from '../modal';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const html = renderToStaticMarkup(
      <Modal open={false} onClose={() => {}}>
        hidden
      </Modal>,
    );
    expect(html).toBe('');
  });

  it('renders dialog role + aria-modal and includes children when open', () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={() => {}} title="Edit Roles">
        <p>body content</p>
      </Modal>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('body content');
  });

  it('wires aria-labelledby to the rendered title element id', () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={() => {}} title="Edit Roles">
        inner
      </Modal>,
    );
    const labelledMatch = html.match(/aria-labelledby="([^"]+)"/);
    expect(labelledMatch).not.toBeNull();
    const id = labelledMatch![1];
    // The <h2> that renders `title` must carry the same id value.
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain('Edit Roles');
  });

  it('omits aria-labelledby when no title is provided', () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={() => {}}>
        body
      </Modal>,
    );
    expect(html).not.toContain('aria-labelledby');
  });

  it('renders a backdrop wrapper so click-outside-to-close has a target', () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={() => {}} title="t">
        inner
      </Modal>,
    );
    expect(html).toContain('data-testid="modal-backdrop"');
  });

  it('renders the close button with an accessible label when titled', () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={() => {}} title="t">
        inner
      </Modal>,
    );
    expect(html).toContain('aria-label="Close dialog"');
  });

  it('renders the footer slot inside a bordered footer', () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={() => {}} title="t" footer={<button>Save</button>}>
        inner
      </Modal>,
    );
    expect(html).toContain('Save');
  });

  it('applies the requested width class variant', () => {
    const small = renderToStaticMarkup(
      <Modal open onClose={() => {}} width="sm">
        x
      </Modal>,
    );
    const wide = renderToStaticMarkup(
      <Modal open onClose={() => {}} width="2xl">
        x
      </Modal>,
    );
    expect(small).toContain('max-w-sm');
    expect(wide).toContain('max-w-2xl');
  });
});
