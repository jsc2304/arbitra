/**
 * @file board-preferences — kanban hide-empty-columns default + filter tests.
 *
 * The kanban defaulted to
 * showing all 12 status columns, which painted ~10 empty buckets out of
 * the box and defeated triage. The default is now `true` (hide empty);
 * a previously-stored `'false'` should still opt the user out.
 */
import { describe, expect, it } from 'vitest';
import type { CaseStatus } from '@arbitra/shared';
import {
  BOARD_HIDE_EMPTY_COLUMNS_DEFAULT,
  resolveHideEmptyColumns,
  visibleBoardStatuses,
} from '../board-preferences';

describe('BOARD_HIDE_EMPTY_COLUMNS_DEFAULT', () => {
  it('defaults to true (hide empty kanban columns by default)', () => {
    expect(BOARD_HIDE_EMPTY_COLUMNS_DEFAULT).toBe(true);
  });
});

describe('resolveHideEmptyColumns', () => {
  it('returns the default when no value is stored', () => {
    expect(resolveHideEmptyColumns(null)).toBe(true);
    expect(resolveHideEmptyColumns(undefined)).toBe(true);
  });

  it('respects an explicit "true"', () => {
    expect(resolveHideEmptyColumns('true')).toBe(true);
  });

  it('respects an explicit "false" (user opted out of hide)', () => {
    expect(resolveHideEmptyColumns('false')).toBe(false);
  });

  it('falls back to the default for unrecognised values', () => {
    expect(resolveHideEmptyColumns('garbage')).toBe(true);
    expect(resolveHideEmptyColumns('')).toBe(true);
  });
});

describe('visibleBoardStatuses', () => {
  const statuses: CaseStatus[] = ['open', 'exploration', 'in_review', 'done'];

  it('returns all statuses when hideEmptyColumns is false', () => {
    expect(
      visibleBoardStatuses(statuses, { open: { length: 0 }, exploration: { length: 0 }, in_review: { length: 0 }, done: { length: 0 } }, false),
    ).toEqual(statuses);
  });

  it('filters out empty buckets when hideEmptyColumns is true', () => {
    expect(
      visibleBoardStatuses(
        statuses,
        { open: { length: 2 }, exploration: { length: 0 }, in_review: { length: 0 }, done: { length: 1 } },
        true,
      ),
    ).toEqual(['open', 'done']);
  });

  it('returns an empty array when hideEmptyColumns is true and every bucket is empty', () => {
    expect(
      visibleBoardStatuses(
        statuses,
        { open: { length: 0 }, exploration: { length: 0 }, in_review: { length: 0 }, done: { length: 0 } },
        true,
      ),
    ).toEqual([]);
  });

  it('treats missing bucket entries as empty', () => {
    expect(visibleBoardStatuses(statuses, {}, true)).toEqual([]);
  });
});
