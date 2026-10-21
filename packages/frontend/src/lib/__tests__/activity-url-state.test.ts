/**
 * URL ↔ MultiActivityFilter roundtrip tests for the consolidated activity
 * filter bar.
 *
 * Covers:
 *  - Default filter serializes to an empty query string (clean shareable URL).
 *  - Non-default filters roundtrip losslessly.
 *  - Legacy single-value `?actor=` and `?project=` aliases get promoted into
 *    the new multi-select arrays so old bookmarks still resolve.
 *  - Plural URL kind tokens (`findings`, `decisions`) translate to the
 *    singular internal `ActivityKind` enum.
 *  - Bad/unknown tokens are dropped, not thrown.
 *  - FilterDelta / applyFilterDelta compose and toggle correctly.
 */
import { describe, expect, it } from 'vitest';
import {
  applyFilterDelta,
  multiFilterFromParams,
  multiFilterToParams,
  roundtripMultiFilter,
  ACTOR_TOKEN_AGENTS,
  type FilterDelta,
} from '../activity-url-state';
import {
  DEFAULT_MULTI_FILTER,
  type MultiActivityFilter,
} from '../activity-feed-presentation';

describe('activity-url-state', () => {
  it('default filter encodes to an empty query string', () => {
    const params = multiFilterToParams(DEFAULT_MULTI_FILTER);
    expect(params.toString()).toBe('');
  });

  it('null/empty params decode to the default filter', () => {
    expect(multiFilterFromParams(null)).toEqual(DEFAULT_MULTI_FILTER);
    expect(multiFilterFromParams(new URLSearchParams())).toEqual(
      DEFAULT_MULTI_FILTER,
    );
  });

  it('encodes the spec example URL exactly (default mode/since omitted)', () => {
    const filter: MultiActivityFilter = {
      mode: 'signal',
      kinds: ['finding', 'decision'],
      actors: ['agents'],
      projects: ['acme-atlas'],
      since: '24h',
    };
    const qs = multiFilterToParams(filter).toString();
    expect(qs).toBe('kinds=findings%2Cdecisions&actors=agents&projects=acme-atlas');
  });

  it('roundtrips a non-default filter losslessly', () => {
    const filter: MultiActivityFilter = {
      mode: 'raw',
      kinds: ['lifecycle', 'finding', 'system'],
      actors: ['agents', 'cursor'],
      projects: ['p1', 'p2'],
      since: '7d',
    };
    expect(roundtripMultiFilter(filter)).toEqual(filter);
  });

  it('drops unknown kind tokens but keeps valid ones', () => {
    const params = new URLSearchParams('kinds=findings,nonsense,decisions');
    const filter = multiFilterFromParams(params);
    expect(filter.kinds).toEqual(['finding', 'decision']);
  });

  it('promotes legacy `?actor=` to the actors array', () => {
    const params = new URLSearchParams('actor=cursor');
    expect(multiFilterFromParams(params).actors).toEqual(['cursor']);
  });

  it('promotes legacy `?project=` to the projects array', () => {
    const params = new URLSearchParams('project=acme-atlas');
    expect(multiFilterFromParams(params).projects).toEqual(['acme-atlas']);
  });

  it('falls back to default `since` when value is unrecognized', () => {
    const params = new URLSearchParams('since=eternity');
    expect(multiFilterFromParams(params).since).toBe(DEFAULT_MULTI_FILTER.since);
  });

  it('treats any non-`raw` mode value as `signal`', () => {
    expect(multiFilterFromParams(new URLSearchParams('mode=raw')).mode).toBe('raw');
    expect(multiFilterFromParams(new URLSearchParams('mode=bogus')).mode).toBe('signal');
    expect(multiFilterFromParams(new URLSearchParams('mode=signal')).mode).toBe('signal');
  });

  it('dedupes repeated CSV tokens', () => {
    const params = new URLSearchParams('kinds=findings,findings&actors=agents,agents');
    const filter = multiFilterFromParams(params);
    expect(filter.kinds).toEqual(['finding']);
    expect(filter.actors).toEqual(['agents']);
  });
});

describe('applyFilterDelta', () => {
  it('toggles a project_id into and out of the projects set', () => {
    const start: MultiActivityFilter = { ...DEFAULT_MULTI_FILTER };
    const added = applyFilterDelta(start, { toggleProject: 'acme-atlas' });
    expect(added.projects).toEqual(['acme-atlas']);
    const removed = applyFilterDelta(added, { toggleProject: 'acme-atlas' });
    expect(removed.projects).toEqual([]);
  });

  it('toggles an actor token (agents or client_name) symmetrically', () => {
    const f1 = applyFilterDelta(DEFAULT_MULTI_FILTER, { toggleActor: 'cursor' });
    expect(f1.actors).toEqual(['cursor']);
    const f2 = applyFilterDelta(f1, { toggleActor: ACTOR_TOKEN_AGENTS });
    expect(f2.actors).toEqual(['cursor', ACTOR_TOKEN_AGENTS]);
    const f3 = applyFilterDelta(f2, { toggleActor: 'cursor' });
    expect(f3.actors).toEqual([ACTOR_TOKEN_AGENTS]);
  });

  it('toggles a kind into the kinds set', () => {
    const f = applyFilterDelta(DEFAULT_MULTI_FILTER, { toggleKind: 'system' });
    expect(f.kinds).toEqual(['system']);
  });

  it('attributionMissing forces mode=raw without touching other dimensions', () => {
    const start: MultiActivityFilter = {
      ...DEFAULT_MULTI_FILTER,
      projects: ['acme-atlas'],
    };
    const out = applyFilterDelta(start, { attributionMissing: true });
    expect(out.mode).toBe('raw');
    expect(out.projects).toEqual(['acme-atlas']);
  });

  it('setMode replaces mode regardless of prior value', () => {
    const out = applyFilterDelta(DEFAULT_MULTI_FILTER, { setMode: 'raw' });
    expect(out.mode).toBe('raw');
    const back = applyFilterDelta(out, { setMode: 'signal' });
    expect(back.mode).toBe('signal');
  });

  it('composes multiple toggles in a single delta (project + kind)', () => {
    const delta: FilterDelta = { toggleProject: 'acme-atlas', toggleKind: 'finding' };
    const out = applyFilterDelta(DEFAULT_MULTI_FILTER, delta);
    expect(out.projects).toEqual(['acme-atlas']);
    expect(out.kinds).toEqual(['finding']);
  });

  it('returns a new filter object (immutable update)', () => {
    const start: MultiActivityFilter = { ...DEFAULT_MULTI_FILTER };
    const out = applyFilterDelta(start, { toggleProject: 'p1' });
    expect(out).not.toBe(start);
    expect(start.projects).toEqual([]);
  });
});
