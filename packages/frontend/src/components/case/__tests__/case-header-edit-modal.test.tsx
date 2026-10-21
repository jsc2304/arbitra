/**
 * @file EditCaseModal (case-header-edit-modal.tsx) — dialog-semantics render
 * contract (issue #794 P1, "Create and edit overlays lack dialog
 * semantics" — the issue text explicitly names both overlays: "Neither
 * overlay exposed a dialog element, role=dialog, aria-modal, or a dialog
 * label. The edit form controls had no IDs, names, or accessible labels.").
 *
 * The stale-draft-state defect from the same issue ("Cancel does not
 * reliably discard draft state") is specific to the create overlay in the
 * issue body and was already fixed for this file's re-seed effect (every
 * prop-seeded useState is reset on the closed->open transition) prior to
 * this change — see the `useEffect` a few lines below the state
 * declarations. That effect only runs on a real open transition, which is
 * unreachable from a single SSR pass (see create-case-modal.test.tsx for
 * the same limitation), so it is not re-asserted here.
 *
 * Node-only per the frontend test convention (renderToStaticMarkup, no
 * jsdom, no fireEvent/userEvent).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Case } from '@arbitra/shared';
import { EditCaseModal } from '../case-header-edit-modal';

function baseCase(over?: Partial<Case>): Case {
  return {
    case_id: 'case_abc123',
    title: 'Wire up the foo',
    description: 'Some description',
    status: 'open',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'usr_1',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    source_type: 'manual',
    source_ref: '',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    jira_refs: [],
    decision_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Case;
}

function renderOpen(overrides?: Partial<Case>) {
  return renderToStaticMarkup(
    <EditCaseModal
      caseData={baseCase(overrides)}
      open={true}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
}

describe('EditCaseModal (dialog-semantics render contract)', () => {
  it('renders nothing when open=false', () => {
    const html = renderToStaticMarkup(
      <EditCaseModal caseData={baseCase()} open={false} onClose={() => {}} onSaved={() => {}} />,
    );
    expect(html).toBe('');
  });

  it('exposes role="dialog" and aria-modal="true" on the overlay root', () => {
    // Reverting the role/aria-modal attributes on the outer container
    // (case-header-edit-modal.tsx's `<div className="fixed inset-0 z-50 ...">`)
    // makes this assertion fail.
    const html = renderOpen();
    expect(html).toMatch(/<div[^>]*role="dialog"[^>]*aria-modal="true"[^>]*>/);
  });

  it('wires aria-labelledby on the dialog root to the "Edit Case" heading id', () => {
    // Reverting the `aria-labelledby={dialogTitleId}` / `id={dialogTitleId}`
    // pair (either side) makes this assertion fail.
    const html = renderOpen();
    const labelledbyMatch = html.match(/aria-labelledby="([^"]+)"/);
    expect(labelledbyMatch).not.toBeNull();
    const titleId = labelledbyMatch![1];
    expect(html).toMatch(new RegExp(`<h2 id="${titleId}"[^>]*>Edit Case</h2>`));
  });

  it('labels every field via htmlFor/id (Title, Description, Project ID, Risk Level, Priority, Validation Track, Case Type)', () => {
    // Reverting any single `htmlFor`/`id` pair (e.g. the Title field) makes
    // this fail: the label count found stays the same, but the referenced
    // id disappears from an `id="..."` attribute in the markup.
    const html = renderOpen();
    const hrefIds = Array.from(html.matchAll(/<label[^>]*for="([^"]+)"/g)).map((m) => m[1]);
    expect(hrefIds).toHaveLength(7);
    for (const id of hrefIds) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('seeds the title field from the passed case on a fresh render', () => {
    const html = renderOpen({ title: 'Investigate the bar' });
    expect(html).toMatch(/value="Investigate the bar"/);
  });
});
