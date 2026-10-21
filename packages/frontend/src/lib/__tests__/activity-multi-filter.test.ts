/**
 * MultiActivityFilter — multi-select + since-window + mode tests.
 *
 * The new consolidated filter bar emits union-semantics across kinds, actors,
 * and projects, and adds a previously-missing time-window dimension. These
 * tests pin down the contract between the filter shape and `applyMultiFilter`
 * so the FilterBar can stay a dumb controlled view.
 */
import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '@arbitra/shared';
import {
  applyMultiFilter,
  countByKind,
  DEFAULT_MULTI_FILTER,
  deriveServerFetchFilters,
  isMultiFilterPristine,
  type MultiActivityFilter,
} from '../activity-feed-presentation';

const NOW = Date.parse('2026-05-06T12:00:00.000Z');

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 'e1',
    kind: 'case_event',
    subkind: 'case_created',
    timestamp: '2026-05-06T11:30:00.000Z',
    case_id: 'case_1',
    case_title: 'Case One',
    project_id: 'proj_1',
    project_name: 'Project One',
    summary: 'opened',
    href: '/cases/case_1?tab=timeline',
    signal: true,
    ...overrides,
  };
}

function withFilter(overrides: Partial<MultiActivityFilter> = {}): MultiActivityFilter {
  return { ...DEFAULT_MULTI_FILTER, ...overrides };
}

describe('isMultiFilterPristine', () => {
  it('reports true for the unmodified default', () => {
    expect(isMultiFilterPristine(DEFAULT_MULTI_FILTER)).toBe(true);
  });

  it('flips false when ANY dimension changes', () => {
    expect(isMultiFilterPristine(withFilter({ mode: 'raw' }))).toBe(false);
    expect(isMultiFilterPristine(withFilter({ kinds: ['finding'] }))).toBe(false);
    expect(isMultiFilterPristine(withFilter({ actors: ['agents'] }))).toBe(false);
    expect(isMultiFilterPristine(withFilter({ projects: ['proj_1'] }))).toBe(false);
    expect(isMultiFilterPristine(withFilter({ since: '7d' }))).toBe(false);
  });
});

describe('applyMultiFilter', () => {
  const sample: ActivityEntry[] = [
    entry({ id: 'lifecycle-signal', kind: 'case_event', subkind: 'case_created', signal: true }),
    entry({ id: 'lifecycle-noise', kind: 'case_event', subkind: 'status_changed', signal: false }),
    entry({ id: 'comment', kind: 'comment', signal: false }),
    entry({
      id: 'cursor-finding',
      kind: 'finding',
      subkind: 'critical',
      signal: true,
      actor_metadata: { client_name: 'cursor' },
    }),
    entry({
      id: 'claude-evidence',
      kind: 'evidence',
      subkind: 'ci_result',
      signal: true,
      actor_metadata: { client_name: 'claude-code' },
      project_id: 'proj_2',
      project_name: 'Project Two',
    }),
  ];

  it('signal mode hides non-signal rows', () => {
    const out = applyMultiFilter(sample, withFilter({ mode: 'signal' }), NOW);
    expect(out.map((e) => e.id).sort()).toEqual(
      ['lifecycle-signal', 'cursor-finding', 'claude-evidence'].sort(),
    );
  });

  it('raw mode shows everything (within the time window)', () => {
    const out = applyMultiFilter(sample, withFilter({ mode: 'raw' }), NOW);
    expect(out).toHaveLength(sample.length);
  });

  it('multi-select kinds are union (OR), not intersection', () => {
    const out = applyMultiFilter(
      sample,
      withFilter({ mode: 'raw', kinds: ['finding', 'comment'] }),
      NOW,
    );
    expect(out.map((e) => e.id).sort()).toEqual(['comment', 'cursor-finding'].sort());
  });

  it('multi-select projects narrow to the selected ids only (union)', () => {
    const out = applyMultiFilter(
      sample,
      withFilter({ mode: 'raw', projects: ['proj_2'] }),
      NOW,
    );
    expect(out.map((e) => e.id)).toEqual(['claude-evidence']);
  });

  it('actor token `agents` matches any client-tagged row', () => {
    const out = applyMultiFilter(
      sample,
      withFilter({ mode: 'raw', actors: ['agents'] }),
      NOW,
    );
    expect(out.map((e) => e.id).sort()).toEqual(
      ['cursor-finding', 'claude-evidence'].sort(),
    );
  });

  it('explicit client_name token matches only that client (union with `agents`)', () => {
    const out = applyMultiFilter(
      sample,
      withFilter({ mode: 'raw', actors: ['cursor'] }),
      NOW,
    );
    expect(out.map((e) => e.id)).toEqual(['cursor-finding']);
  });

  it('since-window drops rows outside the window', () => {
    const ancient = entry({
      id: 'old',
      timestamp: '2026-05-01T00:00:00.000Z', // 5+ days before NOW
    });
    const recent = entry({
      id: 'recent',
      timestamp: '2026-05-06T11:50:00.000Z',
    });
    const filter = withFilter({ mode: 'raw', since: '1h' });
    expect(applyMultiFilter([ancient, recent], filter, NOW).map((e) => e.id)).toEqual([
      'recent',
    ]);
    // `all` disables the window — both pass.
    expect(
      applyMultiFilter([ancient, recent], withFilter({ mode: 'raw', since: 'all' }), NOW)
        .map((e) => e.id)
        .sort(),
    ).toEqual(['old', 'recent']);
  });
});

describe('deriveServerFetchFilters — multi-actor union semantics', () => {
  it('actors=[] → no server narrowing', () => {
    expect(deriveServerFetchFilters({ actors: [], projects: [] })).toEqual({});
  });

  it('actors=["agents"] → agentsOnly only, no clientName', () => {
    expect(deriveServerFetchFilters({ actors: ['agents'], projects: [] })).toEqual({
      agentsOnly: true,
    });
  });

  it('actors=["cursor"] → clientName only, no agentsOnly', () => {
    expect(deriveServerFetchFilters({ actors: ['cursor'], projects: [] })).toEqual({
      clientName: 'cursor',
    });
  });

  it('actors=["agents","cursor"] — multi-actor — wide fetch (no server narrowing)', () => {
    // Previously broken: code pushed clientName='cursor' which excluded agent rows.
    // With the fix, multi-actor selections return {} so the server returns all
    // entries and applyMultiFilter applies the OR union client-side.
    expect(deriveServerFetchFilters({ actors: ['agents', 'cursor'], projects: [] })).toEqual({});
  });

  it('actors=["cursor","claude-code"] — two explicit clients — wide fetch', () => {
    expect(
      deriveServerFetchFilters({ actors: ['cursor', 'claude-code'], projects: [] }),
    ).toEqual({});
  });

  it('single project is always pushed regardless of actors', () => {
    expect(
      deriveServerFetchFilters({ actors: ['agents', 'cursor'], projects: ['proj_x'] }),
    ).toEqual({ projectId: 'proj_x' });
  });

  it('multi-project → no projectId narrowing', () => {
    expect(
      deriveServerFetchFilters({ actors: [], projects: ['proj_x', 'proj_y'] }),
    ).toEqual({});
  });
});

describe('countByKind', () => {
  it('counts entries per kind for the dropdown badges', () => {
    const counts = countByKind([
      entry({ id: '1', kind: 'case_event' }),
      entry({ id: '2', kind: 'case_event' }),
      entry({ id: '3', kind: 'finding' }),
      entry({ id: '4', kind: 'comment' }),
      entry({ id: '5', kind: 'workspace_event' }),
    ]);
    expect(counts).toEqual({
      lifecycle: 2,
      finding: 1,
      decision: 0,
      evidence: 0,
      comment: 1,
      system: 1,
    });
  });
});
