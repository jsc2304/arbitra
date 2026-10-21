import type { CaseStatus } from '@arbitra/shared';

export type BoardViewMode = 'board' | 'list' | 'lifecycle';

export const BOARD_VIEW_STORAGE_KEY = 'arbitra:board-default-view';

export const BOARD_HIDE_EMPTY_COLUMNS_STORAGE_KEY = 'arbitra.board.hideEmptyColumns';

/**
 * Whether the kanban hides empty status columns by default.
 *
 * Rendering twelve empty
 * columns out of the box defeats triage. Default to `true` and let the
 * user opt out via the toolbar toggle (persisted under
 * `BOARD_HIDE_EMPTY_COLUMNS_STORAGE_KEY`).
 */
export const BOARD_HIDE_EMPTY_COLUMNS_DEFAULT = true;

/**
 * Resolve the user's preference for hiding empty kanban columns from a
 * persisted localStorage string. Returns the default when the value is
 * absent or unrecognised so a forward-compat string never silently flips
 * the default.
 */
export function resolveHideEmptyColumns(stored: string | null | undefined): boolean {
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return BOARD_HIDE_EMPTY_COLUMNS_DEFAULT;
}

/**
 * Filter the visible kanban statuses given the cases-per-status map and
 * the current toggle state. Pure helper extracted from the board page so
 * the default-hide-empty contract can be locked in tests.
 */
export function visibleBoardStatuses(
  baseStatuses: readonly CaseStatus[],
  casesByStatus: Record<string, { length: number }>,
  hideEmptyColumns: boolean,
): CaseStatus[] {
  if (!hideEmptyColumns) return [...baseStatuses];
  return baseStatuses.filter((s) => (casesByStatus[s]?.length ?? 0) > 0);
}
