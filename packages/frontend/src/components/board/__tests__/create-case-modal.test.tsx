/**
 * @file CreateCaseModal — dialog-semantics render contract (issue #794 P1,
 * "Create and edit overlays lack dialog semantics").
 *
 * Node-only per the frontend test convention (renderToStaticMarkup, no
 * jsdom, no fireEvent/userEvent) — same pattern as case-delete-dialog.test.tsx
 * and comments-thread.test.tsx. Data-fetching (`api.caseTemplates.list`,
 * `api.projects.list`) and the reset-on-open effect both live in
 * `useEffect`, which never runs during an SSR render, so they need no
 * mocking here and are out of reach for this test file — that gap is the
 * same one case-delete-dialog.test.tsx documents for click-driven behavior
 * and is left to the Playwright suite.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreateCaseModal } from '../create-case-modal';
import { ToastProvider } from '../../../providers/toast-provider';

function renderOpen() {
  return renderToStaticMarkup(
    <ToastProvider>
      <CreateCaseModal open={true} onClose={() => {}} onCreated={() => {}} />
    </ToastProvider>,
  );
}

describe('CreateCaseModal (dialog-semantics render contract)', () => {
  it('renders nothing when open=false', () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <CreateCaseModal open={false} onClose={() => {}} onCreated={() => {}} />
      </ToastProvider>,
    );
    expect(html).toBe('');
  });

  it('exposes role="dialog" and aria-modal="true" on the overlay root', () => {
    // Reverting the role/aria-modal attributes on the outer container
    // (create-case-modal.tsx's `<div className="fixed inset-0 z-50 ...">`)
    // makes this assertion fail.
    const html = renderOpen();
    expect(html).toMatch(/<div[^>]*role="dialog"[^>]*aria-modal="true"[^>]*>/);
  });

  it('wires aria-labelledby on the dialog root to the title heading id', () => {
    // Reverting the `aria-labelledby={dialogTitleId}` / `id={dialogTitleId}`
    // pair (either side) makes this assertion fail: either no
    // aria-labelledby attribute is found, or the id it points to does not
    // exist anywhere in the markup.
    const html = renderOpen();
    const labelledbyMatch = html.match(/aria-labelledby="([^"]+)"/);
    expect(labelledbyMatch).not.toBeNull();
    const titleId = labelledbyMatch![1];
    expect(html).toContain(`id="${titleId}"`);
    // The referenced element is the "New Case" heading, not some other node.
    expect(html).toMatch(new RegExp(`<h3 id="${titleId}"[^>]*>New Case</h3>`));
  });

  it('labels every visible field via htmlFor/id (Input primitive + attachments)', () => {
    const html = renderOpen();
    // Every <label htmlFor="X"> must have a matching id="X" on some control.
    const hrefIds = Array.from(html.matchAll(/<label[^>]*for="([^"]+)"/g)).map((m) => m[1]);
    // At minimum: Title, Description, Source Type, Validation Track, Risk
    // Level, Priority, Project, Repository, Working Branch, Pull Request,
    // Attachments, Jira References — 12 labelled fields (template select is
    // conditionally rendered only once templates have loaded, so it is not
    // counted here).
    expect(hrefIds.length).toBeGreaterThanOrEqual(12);
    for (const id of hrefIds) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('wires the Attachments label to the hidden file input via htmlFor', () => {
    // Reverting the `htmlFor="case-attachment-input"` addition on the
    // Attachments <label> makes this assertion fail (the label would no
    // longer carry a `for` attribute at all).
    const html = renderOpen();
    expect(html).toMatch(/<label[^>]*for="case-attachment-input"[^>]*>\s*Attachments/);
    expect(html).toContain('id="case-attachment-input"');
  });
});
