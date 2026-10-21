import { describe, expect, it } from 'vitest';
import type { ActivityLeaderboardRow } from '@arbitra/shared';
import {
  describeLeaderboardMix,
  getLeaderboardContributionSegments,
  getLeaderboardSourceLabel,
  getLeaderboardShare,
  getLeaderboardSourceDescriptor,
  isFallbackLeaderboardRow,
  splitActivitySourceRows,
} from '../activity-leaderboard-presentation';

function makeRow(overrides: Partial<ActivityLeaderboardRow> = {}): ActivityLeaderboardRow {
  return {
    source_kind: 'client',
    client_name: 'cursor',
    counts: {
      cases_created: 0,
      comments: 0,
      evidence: 0,
      findings: 0,
      decisions: 0,
      workspace_events: 0,
      total: 0,
    },
    ...overrides,
  };
}

describe('activity-leaderboard-presentation', () => {
  it('sorts contribution segments by descending volume and omits zero metrics', () => {
    const row = makeRow({
      counts: {
        cases_created: 2,
        comments: 9,
        evidence: 3,
        findings: 0,
        decisions: 5,
        workspace_events: 1,
        total: 20,
      },
    });

    expect(getLeaderboardContributionSegments(row)).toEqual([
      expect.objectContaining({ label: 'Comments', value: 9 }),
      expect.objectContaining({ label: 'Decisions', value: 5 }),
      expect.objectContaining({ label: 'Evidence', value: 3 }),
      expect.objectContaining({ label: 'Cases', value: 2 }),
      expect.objectContaining({ label: 'System', value: 1 }),
    ]);
  });

  it('describes synthetic rows with a human-readable descriptor', () => {
    const row = makeRow({ source_kind: 'human', client_name: 'human' });
    expect(isFallbackLeaderboardRow(row)).toBe(true);
    expect(getLeaderboardSourceLabel(row)).toBe('Direct / Unattributed');
    expect(getLeaderboardSourceDescriptor(row)).toBe(
      'Actions without a detected client signature. This can include direct browser usage and any agent writes that did not preserve client metadata.',
    );
  });

  it('builds agent descriptors from version and model when present', () => {
    const row = makeRow({
      client_name: 'claude-code',
      client_version: '2.1.0',
      model: 'claude-sonnet-4.7',
    });

    expect(getLeaderboardSourceDescriptor(row)).toBe('v2.1.0 · claude-sonnet-4.7');
  });

  it('computes activity share and mix summaries', () => {
    const row = makeRow({
      counts: {
        cases_created: 0,
        comments: 2,
        evidence: 8,
        findings: 0,
        decisions: 0,
        workspace_events: 0,
        total: 10,
      },
    });

    expect(getLeaderboardShare(row, 25)).toBe(40);
    expect(describeLeaderboardMix(row)).toBe('Mostly evidence.');
  });

  it('splits detected clients from fallback buckets', () => {
    const result = splitActivitySourceRows([
      makeRow({ client_name: 'cursor' }),
      makeRow({ source_kind: 'system', client_name: 'system' }),
      makeRow({ source_kind: 'human', client_name: 'human' }),
    ]);

    expect(result.clientRows).toHaveLength(1);
    expect(result.fallbackRows.map((row) => row.source_kind)).toEqual(['system', 'human']);
  });
});
