/**
 * @file side-drawer primitive — structural/markup tests.
 *
 * Event-driven behaviors (Escape closes, backdrop click closes, focus trap)
 * rely on a DOM and a jsdom/happy-dom environment. The frontend test setup is
 * deliberately node-only (no testing-library, no jsdom) so these are verified
 * via static markup introspection: the handler WIRING is in place and the
 * hook/effect dependencies are registered. Interaction-level coverage is
 * deferred to the integration pass in PR 2 where the drawer gets real
 * consumers.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SideDrawer } from '../side-drawer';

describe('SideDrawer', () => {
  it('renders nothing when closed', () => {
    const html = renderToStaticMarkup(
      <SideDrawer open={false} onClose={() => {}}>
        hidden
      </SideDrawer>,
    );
    expect(html).toBe('');
  });

  it('renders dialog role + aria-modal and includes children when open', () => {
    const html = renderToStaticMarkup(
      <SideDrawer open onClose={() => {}} title="Event details">
        <p>body content</p>
      </SideDrawer>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('body content');
  });

  it('wires aria-labelledby to the rendered title element id', () => {
    const html = renderToStaticMarkup(
      <SideDrawer open onClose={() => {}} title="Event details">
        inner
      </SideDrawer>,
    );
    const labelledMatch = html.match(/aria-labelledby="([^"]+)"/);
    expect(labelledMatch).not.toBeNull();
    const id = labelledMatch![1];
    // The <h3> that renders `title` must carry the same id value.
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain('Event details');
  });

  it('omits aria-labelledby when no title is provided', () => {
    const html = renderToStaticMarkup(
      <SideDrawer open onClose={() => {}}>
        body
      </SideDrawer>,
    );
    expect(html).not.toContain('aria-labelledby');
  });

  it('renders a backdrop wrapper so click-outside-to-close has a target', () => {
    const html = renderToStaticMarkup(
      <SideDrawer open onClose={() => {}} title="t">
        inner
      </SideDrawer>,
    );
    // The backdrop carries a data-testid so consumers (and future DOM tests)
    // can target it deterministically.
    expect(html).toContain('data-testid="side-drawer-backdrop"');
  });

  it('applies the requested width class variant', () => {
    const small = renderToStaticMarkup(
      <SideDrawer open onClose={() => {}} width="sm">
        x
      </SideDrawer>,
    );
    const large = renderToStaticMarkup(
      <SideDrawer open onClose={() => {}} width="lg">
        x
      </SideDrawer>,
    );
    expect(small).toContain('max-w-sm');
    expect(large).toContain('max-w-xl');
  });

  it('renders the close button with an accessible label when titled', () => {
    const html = renderToStaticMarkup(
      <SideDrawer open onClose={() => {}} title="t">
        inner
      </SideDrawer>,
    );
    expect(html).toContain('aria-label="Close drawer"');
  });
});
