import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '@arbitra/shared';
import {
  buildActivityFeedItems,
  classifyActivityType,
  filterActivityEntries,
  isSignalEntry,
} from '../activity-feed-presentation';

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 'entry_1',
    kind: 'case_event',
    timestamp: '2026-04-21T10:00:00.000Z',
    case_id: 'case_1',
    case_title: 'Case One',
    project_id: 'proj_1',
    project_name: 'Project One',
    summary: 'summary',
    href: '/cases/case_1?tab=timeline',
    ...overrides,
  };
}

describe('activity-feed-presentation', () => {
  it('classifies entries into the expected filter buckets', () => {
    expect(classifyActivityType(entry({ kind: 'case_event' }))).toBe('lifecycle');
    expect(classifyActivityType(entry({ kind: 'finding' }))).toBe('finding');
    expect(classifyActivityType(entry({ kind: 'decision' }))).toBe('decision');
    expect(classifyActivityType(entry({ kind: 'evidence' }))).toBe('evidence');
    expect(classifyActivityType(entry({ kind: 'comment' }))).toBe('comment');
    expect(classifyActivityType(entry({ kind: 'workspace_event', case_id: '', href: '' }))).toBe('system');
  });

  it('keeps only high-signal rows in signal mode', () => {
    expect(isSignalEntry(entry({ kind: 'decision', subkind: 'approve' }))).toBe(true);
    expect(isSignalEntry(entry({ kind: 'workspace_event', case_id: '', href: '' }))).toBe(true);
    expect(isSignalEntry(entry({ kind: 'finding', subkind: 'critical' }))).toBe(true);
    expect(isSignalEntry(entry({ kind: 'case_event', subkind: 'merge_ready' }))).toBe(true);
    expect(isSignalEntry(entry({ kind: 'case_event', subkind: 'pr_merged' }))).toBe(true);
    expect(isSignalEntry(entry({ kind: 'case_event', subkind: 'review_marked_not_applicable' }))).toBe(true);
    expect(isSignalEntry(entry({ kind: 'case_event', subkind: 'review_not_applicable_cleared' }))).toBe(true);
    expect(isSignalEntry(entry({ kind: 'comment' }))).toBe(false);
    expect(isSignalEntry(entry({ kind: 'evidence', subkind: 'unit_test_result' }))).toBe(false);
    expect(isSignalEntry(entry({ kind: 'case_event', subkind: 'status_changed' }))).toBe(false);
  });

  it('applies mode and type filters together', () => {
    const entries = [
      entry({ id: 'a', kind: 'decision', subkind: 'approve' }),
      entry({ id: 'b', kind: 'comment' }),
      entry({ id: 'c', kind: 'finding', subkind: 'critical' }),
      entry({ id: 'd', kind: 'evidence', subkind: 'ci_result' }),
    ];

    expect(filterActivityEntries(entries, 'signal', 'all').map((item) => item.id)).toEqual(['a', 'c', 'd']);
    expect(filterActivityEntries(entries, 'signal', 'decision').map((item) => item.id)).toEqual(['a']);
    expect(filterActivityEntries(entries, 'raw', 'comment').map((item) => item.id)).toEqual(['b']);
  });

  it('groups consecutive same-case bursts into one cluster', () => {
    const items = buildActivityFeedItems(
      [
        entry({
          id: 'a',
          kind: 'decision',
          timestamp: '2026-04-21T10:00:00.000Z',
          summary: 'approved on case',
        }),
        entry({
          id: 'b',
          kind: 'decision',
          timestamp: '2026-04-21T09:59:30.000Z',
          summary: 'requested changes on case',
        }),
        entry({
          id: 'c',
          kind: 'decision',
          case_id: 'case_2',
          case_title: 'Case Two',
          href: '/cases/case_2?tab=timeline',
          timestamp: '2026-04-21T09:58:00.000Z',
          summary: 'approved on case',
        }),
      ],
      { mode: 'raw', typeFilter: 'all' },
    );

    expect(items).toHaveLength(2);
    expect(items[0]?.kind).toBe('cluster');
    if (items[0]?.kind === 'cluster') {
      expect(items[0].entries.map((item) => item.id)).toEqual(['a', 'b']);
      // The narrative line replaces the count-and-label; verb chips and
      // count label carry the scannability that the old label provided.
      expect(items[0].label.length).toBeGreaterThan(0);
      expect(items[0].preview).toContain('approved on case');
      expect(items[0].verbChips.length).toBeGreaterThan(0);
      expect(items[0].countLabel).toMatch(/2 in \d+m/);
    }
  });

  it('collapses consecutive intelligence_run heartbeats into a HeartbeatTile', () => {
    const items = buildActivityFeedItems(
      [
        entry({
          id: 'wse_1',
          kind: 'workspace_event',
          subkind: 'intelligence_run',
          case_id: '',
          href: '',
          timestamp: '2026-04-21T10:00:00.000Z',
          summary: 'Ran 5 detectors — 0 new nudges, 6 deduped, 0 errors (duration 928ms)',
        }),
        entry({
          id: 'wse_2',
          kind: 'workspace_event',
          subkind: 'intelligence_run',
          case_id: '',
          href: '',
          timestamp: '2026-04-21T09:50:00.000Z',
          summary: 'Ran 5 detectors — 0 new nudges, 6 deduped, 0 errors (duration 1003ms)',
        }),
        entry({
          id: 'wse_3',
          kind: 'workspace_event',
          subkind: 'intelligence_run',
          case_id: '',
          href: '',
          timestamp: '2026-04-21T09:40:00.000Z',
          summary: 'Ran 5 detectors — 0 new nudges, 6 deduped, 0 errors (duration 998ms)',
        }),
        entry({
          id: 'd_1',
          kind: 'decision',
          subkind: 'approve',
          timestamp: '2026-04-21T09:30:00.000Z',
        }),
      ],
      { mode: 'raw', typeFilter: 'all' },
    );
    expect(items).toHaveLength(2);
    expect(items[0]?.kind).toBe('heartbeat');
    if (items[0]?.kind === 'heartbeat') {
      expect(items[0].entries).toHaveLength(3);
      expect(items[0].id).toMatch(/^heartbeat:/);
      // The latest run's timestamp anchors the tile.
      expect(items[0].latest_timestamp).toBe('2026-04-21T10:00:00.000Z');
    }
    // The non-heartbeat row passes through untouched.
    expect(items[1]?.kind).toBe('entry');
  });

  it('promotes a single intelligence_run row to a HeartbeatTile too', () => {
    // The tile replaces the placeholder cluster wholesale; a
    // single run still renders as a tile (not as a raw row) so the
    // heartbeat surface stays consistent regardless of run count.
    const items = buildActivityFeedItems(
      [
        entry({
          id: 'wse_solo',
          kind: 'workspace_event',
          subkind: 'intelligence_run',
          case_id: '',
          href: '',
          timestamp: '2026-04-21T10:00:00.000Z',
          summary: 'Ran 5 detectors — 0 new nudges, 6 deduped, 0 errors (duration 928ms)',
        }),
      ],
      { mode: 'raw', typeFilter: 'all' },
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('heartbeat');
  });

  it('does not group workspace rows or same-case rows outside the burst window', () => {
    const items = buildActivityFeedItems(
      [
        entry({
          id: 'a',
          kind: 'workspace_event',
          case_id: '',
          href: '',
          timestamp: '2026-04-21T10:00:00.000Z',
          summary: 'Scheduler run completed',
        }),
        entry({
          id: 'b',
          kind: 'decision',
          timestamp: '2026-04-21T09:58:00.000Z',
          summary: 'approved on case',
        }),
        entry({
          id: 'c',
          kind: 'decision',
          timestamp: '2026-04-21T09:55:00.000Z',
          summary: 'requested changes on case',
        }),
      ],
      { mode: 'raw', typeFilter: 'all' },
    );

    expect(items.map((item) => item.kind)).toEqual(['entry', 'entry', 'entry']);
  });

  it('collapses 3+ same-group_key entries into a streak', () => {
    const items = buildActivityFeedItems(
      [
        entry({
          id: 'c1',
          kind: 'comment',
          timestamp: '2026-04-21T10:07:00.000Z',
          group_key: 'case:case_1:202604211000',
        }),
        entry({
          id: 'c2',
          kind: 'comment',
          timestamp: '2026-04-21T10:04:00.000Z',
          group_key: 'case:case_1:202604211000',
        }),
        entry({
          id: 'c3',
          kind: 'comment',
          timestamp: '2026-04-21T10:00:00.000Z',
          group_key: 'case:case_1:202604211000',
        }),
      ],
      { mode: 'raw', typeFilter: 'all' },
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('streak');
    if (items[0]?.kind === 'streak') {
      expect(items[0].count).toBe(3);
      expect(items[0].verb_label).toBe('comments');
      expect(items[0].window_minutes).toBe(7);
    }
  });

  it('does NOT collapse 2 same-group_key entries into a streak', () => {
    const items = buildActivityFeedItems(
      [
        entry({
          id: 'c1',
          kind: 'comment',
          timestamp: '2026-04-21T10:07:00.000Z',
          group_key: 'case:case_1:202604211000',
        }),
        entry({
          id: 'c2',
          kind: 'comment',
          timestamp: '2026-04-21T10:04:00.000Z',
          group_key: 'case:case_1:202604211000',
        }),
      ],
      { mode: 'raw', typeFilter: 'all' },
    );
    // The two comments still cluster via the burst-window path (90s window
    // is too tight here — 3 minutes apart). Each remains its own entry item.
    expect(items.every((it) => it.kind === 'entry')).toBe(true);
    expect(items.length).toBe(2);
  });

  it('keeps the same cluster id when a burst grows with additional matching entries', () => {
    const firstPass = buildActivityFeedItems(
      [
        entry({
          id: 'a',
          kind: 'decision',
          timestamp: '2026-04-21T10:00:00.000Z',
        }),
        entry({
          id: 'b',
          kind: 'decision',
          timestamp: '2026-04-21T09:59:30.000Z',
        }),
      ],
      { mode: 'raw', typeFilter: 'all' },
    );
    const secondPass = buildActivityFeedItems(
      [
        entry({
          id: 'new',
          kind: 'decision',
          timestamp: '2026-04-21T10:00:20.000Z',
        }),
        entry({
          id: 'a',
          kind: 'decision',
          timestamp: '2026-04-21T10:00:00.000Z',
        }),
        entry({
          id: 'b',
          kind: 'decision',
          timestamp: '2026-04-21T09:59:30.000Z',
        }),
      ],
      { mode: 'raw', typeFilter: 'all' },
    );

    expect(firstPass[0]?.kind).toBe('cluster');
    expect(secondPass[0]?.kind).toBe('cluster');
    if (firstPass[0]?.kind === 'cluster' && secondPass[0]?.kind === 'cluster') {
      expect(secondPass[0].id).toBe(firstPass[0].id);
      expect(secondPass[0].entries.map((item) => item.id)).toEqual(['new', 'a', 'b']);
    }
  });

  // Regression: the "idle over threshold"
  // chip is supposed to narrow the feed to detector-opened cases. Previously
  // the chip handler mapped to typeFilter='lifecycle' which surfaced ALL
  // lifecycle rows. With the new caseDetectorOpened client-side filter, only
  // rows whose envelope `opened_by === 'detector'` survive.
  it('caseDetectorOpened client filter keeps only detector-opened rows', () => {
    const detectorOpened = entry({
      id: 'evt_detector',
      kind: 'case_event',
      subkind: 'case_created',
      opened_by: 'detector',
    });
    const humanOpened = entry({
      id: 'evt_human',
      kind: 'case_event',
      subkind: 'case_created',
      opened_by: 'user',
    });
    const webhookOpened = entry({
      id: 'evt_webhook',
      kind: 'case_event',
      subkind: 'case_created',
      opened_by: 'webhook',
    });

    const result = filterActivityEntries(
      [detectorOpened, humanOpened, webhookOpened],
      'raw',
      'all',
      { caseDetectorOpened: true },
    );
    expect(result.map((e) => e.id)).toEqual(['evt_detector']);
  });
});
