/**
 * @file CaseDeleteDialog — type-to-confirm gate tests.
 *
 * The destructive gate has two halves:
 *   1. `canConfirmDelete` — pure helper that decides whether the Delete button
 *      should be active. Unit-tested directly.
 *   2. The component itself — render-time assertions about the gate's
 *      *visual* state (`aria-disabled`) and the structural contract the
 *      focus trap depends on (Cancel, input, Delete in tab order).
 *
 * The frontend test setup is intentionally node-only / SSR
 * (`renderToStaticMarkup`) — no jsdom, no `fireEvent`, no `userEvent`.
 * Existing dialog tests in the repo follow the same pattern (see
 * `decision-history.test.tsx`, `activity-cluster-row.test.tsx`). Behaviour
 * that requires real DOM events (Esc closes, Cancel click → onCancel,
 * onConfirm fires exactly once on click) is covered by the pure helper plus
 * the rendered `aria-disabled`/`onClick` wiring; full e2e click coverage is
 * deferred to the Playwright suite.
 *
 * PR #552 review I4.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CaseDeleteDialog, canConfirmDelete } from '../case-delete-dialog';

const baseCounts = {
  findings: 0,
  evidence: 0,
  decisions: 0,
  comments: 0,
  related: 0,
};

describe('canConfirmDelete', () => {
  it('returns false for empty input', () => {
    expect(canConfirmDelete('', 'case_abc123', false)).toBe(false);
  });

  it('returns false when typed value differs only by case (lowercase wrong-case)', () => {
    expect(canConfirmDelete('case_ABC123', 'case_abc123', false)).toBe(false);
    expect(canConfirmDelete('CASE_abc123', 'case_abc123', false)).toBe(false);
  });

  it('returns false for prefix-only input', () => {
    expect(canConfirmDelete('case_', 'case_abc123', false)).toBe(false);
    expect(canConfirmDelete('case_abc', 'case_abc123', false)).toBe(false);
  });

  it('returns false for suffix overflow', () => {
    expect(canConfirmDelete('case_abc1234', 'case_abc123', false)).toBe(false);
  });

  it('returns false when loading even if value matches exactly', () => {
    // Guard: while a delete is mid-flight we never want a duplicate fire.
    expect(canConfirmDelete('case_abc123', 'case_abc123', true)).toBe(false);
  });

  it('returns true on exact, character-for-character match', () => {
    expect(canConfirmDelete('case_abc123', 'case_abc123', false)).toBe(true);
  });

  it('returns true for IDs containing special characters when matched exactly', () => {
    expect(canConfirmDelete('case_a-b_c.1', 'case_a-b_c.1', false)).toBe(true);
  });
});

describe('CaseDeleteDialog (render contract)', () => {
  function renderOpen(props?: Partial<Parameters<typeof CaseDeleteDialog>[0]>) {
    return renderToStaticMarkup(
      <CaseDeleteDialog
        open={true}
        caseId="case_abc123"
        caseTitle="Wire up the foo"
        counts={baseCounts}
        loading={false}
        onConfirm={() => {}}
        onCancel={() => {}}
        {...props}
      />,
    );
  }

  it('renders nothing when open=false', () => {
    const html = renderToStaticMarkup(
      <CaseDeleteDialog
        open={false}
        caseId="case_abc123"
        caseTitle="x"
        counts={baseCounts}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toBe('');
  });

  it('renders the title with the truncated case title', () => {
    const html = renderOpen();
    expect(html).toContain('Wire up the foo');
    expect(html).toContain('Delete case');
  });

  it('renders the destructive button as aria-disabled when nothing is typed', () => {
    // Initial render: the typed input is empty, so the gate is closed.
    // The button must carry `aria-disabled="true"` (and not the native
    // `disabled` attribute) so it stays in the tab order — the focus trap
    // cycles Cancel → input → Delete and depends on Delete being focusable.
    const html = renderOpen();
    expect(html).toMatch(/aria-disabled="true"[^>]*>\s*Delete case/);
    // Native `disabled` attribute MUST NOT appear on the destructive button
    // (it would remove it from the tab order).
    const deleteButtonMatch = html.match(/<button[^>]*>\s*Delete case\s*<\/button>/);
    expect(deleteButtonMatch).not.toBeNull();
    expect(deleteButtonMatch?.[0]).not.toMatch(/\sdisabled(\s|=|>)/);
  });

  it('renders both Cancel and Delete buttons (focus-trap contract)', () => {
    const html = renderOpen();
    expect(html).toContain('>Cancel<');
    expect(html).toMatch(/>\s*Delete case\s*</);
  });

  it('renders the type-to-confirm input wired to a label via htmlFor (no aria-label dup)', () => {
    const html = renderOpen();
    // Visible label exists and references the input via htmlFor/id.
    const labelMatch = html.match(/<label[^>]*for="([^"]+)"/);
    expect(labelMatch).not.toBeNull();
    const inputId = labelMatch![1];
    expect(html).toContain(`id="${inputId}"`);
    // `aria-label` was dropped (PR #552 review N4) — the htmlFor wiring is
    // the canonical accessible name. We assert there is no `aria-label` on
    // the input row.
    const inputMatch = html.match(/<input[^>]*>/);
    expect(inputMatch).not.toBeNull();
    expect(inputMatch?.[0]).not.toContain('aria-label');
  });

  it('shows the case ID inline so the user knows what to type', () => {
    const html = renderOpen();
    // The case ID appears at least once inside a <code> block.
    expect(html).toMatch(/<code[^>]*>\s*case_abc123\s*<\/code>/);
  });

  it('renders the loading label when loading=true and disables Cancel natively', () => {
    const html = renderOpen({ loading: true });
    expect(html).toContain('Deleting…');
    // While loading, the Cancel button takes the native `disabled` attribute
    // so a stray click cannot fire mid-request.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Cancel/);
  });

  it('shows total related count in body copy', () => {
    const html = renderOpen({
      counts: { findings: 2, evidence: 1, decisions: 0, comments: 4, related: 3 },
    });
    // 2 + 1 + 0 + 4 + 3 = 10
    expect(html).toContain('10 related items');
  });

  it('uses singular form when total relateds is exactly 1', () => {
    const html = renderOpen({
      counts: { findings: 1, evidence: 0, decisions: 0, comments: 0, related: 0 },
    });
    expect(html).toContain('1 related item');
    expect(html).not.toContain('1 related items');
  });
});
