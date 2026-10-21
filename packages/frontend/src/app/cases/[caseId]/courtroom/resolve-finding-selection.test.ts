// @vitest-environment node
//
// Node-only regression tests for the courtroom `?finding=` URL → selection
// sync (#631). The param→selection *decision* lives in the pure
// `resolveFindingSelection` helper precisely so it can be exercised here
// without a DOM — the full page hook would otherwise need jsdom + a mocked
// `useSearchParams`. The helper mirrors exactly what the page effect feeds to
// its functional `setSelectedFindingId(prev => ...)`.
import { describe, it, expect } from 'vitest';
import {
  resolveFindingSelection,
  buildCourtroomFindingHref,
} from './resolve-finding-selection';

const IDS = ['finding-a', 'finding-b', 'finding-c'];

describe('resolveFindingSelection', () => {
  // (a) initializes from `?finding=` — first run, no prior selection.
  it('selects the param on mount when it matches a known finding', () => {
    expect(
      resolveFindingSelection({
        findingParam: 'finding-a',
        selectedFindingId: null,
        findingIds: IDS,
      }),
    ).toEqual({ kind: 'select', findingId: 'finding-a' });
  });

  // (b) unknown param cleared once findings load — but only while the phantom
  // param is still the active selection.
  it('clears an unknown param once findings have loaded', () => {
    expect(
      resolveFindingSelection({
        findingParam: 'finding-zzz',
        selectedFindingId: 'finding-zzz',
        findingIds: IDS,
      }),
    ).toEqual({ kind: 'clear' });
  });

  it('does not clear when the unknown param is no longer the active selection', () => {
    // User clicked away to a real finding; the stale param must not yank it back.
    expect(
      resolveFindingSelection({
        findingParam: 'finding-zzz',
        selectedFindingId: 'finding-b',
        findingIds: IDS,
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('waits (noop) while findings are still loading, even for an unknown param', () => {
    expect(
      resolveFindingSelection({
        findingParam: 'finding-zzz',
        selectedFindingId: 'finding-zzz',
        findingIds: [],
      }),
    ).toEqual({ kind: 'noop' });
  });

  // (c) param change A → B updates selection.
  it('updates selection when the param changes from one valid finding to another', () => {
    expect(
      resolveFindingSelection({
        findingParam: 'finding-b',
        selectedFindingId: 'finding-a',
        findingIds: IDS,
      }),
    ).toEqual({ kind: 'select', findingId: 'finding-b' });
  });

  // The no-fight-user-clicks safeguard: once the user has clicked a *different*
  // finding the URL param is unchanged, so the effect re-runs with
  // selectedFindingId === param's target only when they match. A click moves
  // selection to something the param does NOT point at → param still points at
  // its own id, which differs, so it WOULD re-select. The guard that prevents
  // that is: the effect only runs when `findingParam` (or the id set) changes,
  // NOT when `selectedFindingId` changes. We assert the helper itself never
  // re-selects a param that already equals the live selection.
  it('is a noop when the param already equals the current selection (idempotent re-run)', () => {
    expect(
      resolveFindingSelection({
        findingParam: 'finding-a',
        selectedFindingId: 'finding-a',
        findingIds: IDS,
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('is a noop when there is no param at all', () => {
    expect(
      resolveFindingSelection({
        findingParam: null,
        selectedFindingId: 'finding-a',
        findingIds: IDS,
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('does not clear a null selection for an unknown param (avoids redundant updates)', () => {
    expect(
      resolveFindingSelection({
        findingParam: 'finding-zzz',
        selectedFindingId: null,
        findingIds: IDS,
      }),
    ).toEqual({ kind: 'noop' });
  });
});

describe('buildCourtroomFindingHref (BlockerStrip deep-link format)', () => {
  // (d) BlockerStrip/href format unchanged: `/cases/<id>/courtroom?finding=<encoded-id>`.
  it('builds the canonical courtroom deep-link', () => {
    expect(buildCourtroomFindingHref('case-xyz', 'finding-a')).toBe(
      '/cases/case-xyz/courtroom?finding=finding-a',
    );
  });

  it('URL-encodes finding ids that contain reserved characters', () => {
    expect(buildCourtroomFindingHref('case-xyz', 'a/b c&d')).toBe(
      '/cases/case-xyz/courtroom?finding=a%2Fb%20c%26d',
    );
  });
});
