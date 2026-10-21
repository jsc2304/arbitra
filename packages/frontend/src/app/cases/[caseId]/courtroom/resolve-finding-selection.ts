/**
 * Pure decision helper for the courtroom `?finding=<id>` URL → selection sync.
 *
 * The courtroom seeds `selectedFindingId` from the `finding` query param at
 * mount, then keeps it in sync as the URL changes (browser back/forward, or a
 * future same-page deep link to a different finding). This helper encodes the
 * decision so it can be unit-tested without a DOM:
 *
 *   - `'clear'`   — param points at a finding that doesn't exist (stale link,
 *                   hand-typed id). The caller clears the preselection *only*
 *                   if the current selection still equals that phantom param.
 *   - `'select'`  — param points at a known finding that differs from the
 *                   current selection. The caller selects it.
 *   - `'noop'`    — no param, findings not loaded yet, or the param already
 *                   matches the current selection. The caller leaves selection
 *                   untouched so manual clicks on *other* findings keep winning
 *                   until the URL param itself changes.
 *
 * Critically, the `'select'` branch only fires when `findingParam !==
 * selectedFindingId`. Once the user clicks a different finding, the param is
 * unchanged, so this returns `'noop'` and the user's click is not fought — the
 * regression caught mid-PR #537.
 */
export type FindingSelectionAction =
  | { kind: 'noop' }
  | { kind: 'clear' }
  | { kind: 'select'; findingId: string };

export function resolveFindingSelection(args: {
  findingParam: string | null;
  selectedFindingId: string | null;
  /** All finding ids currently loaded (post-filter is irrelevant; uses full set). */
  findingIds: readonly string[];
}): FindingSelectionAction {
  const { findingParam, selectedFindingId, findingIds } = args;

  // No deep-link param → nothing to sync. (Mount seed handled separately.)
  if (!findingParam) return { kind: 'noop' };

  // Findings not loaded yet → can't validate the param; wait for data.
  if (findingIds.length === 0) return { kind: 'noop' };

  const exists = findingIds.includes(findingParam);

  if (!exists) {
    // Stale / hand-typed id. Clear it only if the current selection is that
    // phantom param; otherwise the user has already navigated away — leave it.
    return selectedFindingId === findingParam ? { kind: 'clear' } : { kind: 'noop' };
  }

  // Known finding. Select it only when it differs from the current selection.
  // When equal (incl. after a same-target click), this is a noop so user
  // clicks on *other* findings are never overridden until the URL changes.
  if (findingParam !== selectedFindingId) {
    return { kind: 'select', findingId: findingParam };
  }

  return { kind: 'noop' };
}

/**
 * Canonical courtroom deep-link for a preselected finding:
 * `/cases/<caseId>/courtroom?finding=<encoded-id>`.
 *
 * Shared by the BlockerStrip rows (the only in-app caller today) so the link
 * format the courtroom's `?finding=` sync reads is produced in exactly one
 * place — and is regression-testable node-only.
 */
export function buildCourtroomFindingHref(caseId: string, findingId: string): string {
  return `/cases/${caseId}/courtroom?finding=${encodeURIComponent(findingId)}`;
}
