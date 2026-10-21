import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ActivityEntry } from '@arbitra/shared';
import {
  computeFeedStatus,
  mergeActivity,
  resolvePollSince,
  shouldPollFallback,
} from '../use-activity-feed';

// `useSWR`'s `revalidateOnFocus` option isn't reachable through the hook's
// exported pure functions above, and this repo's frontend tests are
// node-only (no jsdom/testing-library — see active-sessions-panel.test.tsx),
// so there's no interactive renderer to mount `useActivityFeed` and inspect
// what it actually passed to `useSWR`. Source-text assertion is the existing
// idiom for exactly this gap (see route.test.ts's "does not read or write
// .arbitra/.active-case" check on arbitra-context-inject.sh).
describe('useActivityFeed — activity:init SWR config', () => {
  const hookSrc = readFileSync(new URL('../use-activity-feed.ts', import.meta.url), 'utf8');

  it(
    'disables revalidateOnFocus on the activity:init key '
    + '(pre-fix: use-activity-feed.ts `{ revalidateOnFocus: false }` on the `activity:init` useSWR call — '
    + 'restore `{ revalidateOnFocus: true }` and this assertion fails)',
    () => {
      const swrCallMatch = hookSrc.match(
        /const initialKey[\s\S]*?useSWR\(\s*initialKey,[\s\S]*?\{\s*revalidateOnFocus:\s*(true|false)\s*\}/,
      );
      expect(swrCallMatch).not.toBeNull();
      expect(swrCallMatch?.[1]).toBe('false');
    },
  );
});

function entry(id: string, ts: string): ActivityEntry {
  return {
    id,
    kind: 'comment',
    timestamp: ts,
    case_id: 'case_1',
    summary: 'commented on case',
    href: '/cases/case_1',
  };
}

describe('mergeActivity', () => {
  it('prepends new rows above the existing list', () => {
    const existing = [entry('a', '2026-04-19T00:00:00.000Z'), entry('b', '2026-04-18T00:00:00.000Z')];
    const incoming = [entry('c', '2026-04-19T01:00:00.000Z')];
    const merged = mergeActivity(existing, incoming);
    expect(merged.map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });

  it('dedupes by id — an incoming row shadowing an existing one keeps the incoming copy only', () => {
    const a1 = entry('a', '2026-04-19T00:00:00.000Z');
    const a2 = { ...a1, summary: 'updated' };
    const merged = mergeActivity([a1], [a2]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.summary).toBe('updated');
  });

  it('is a no-op (returns the same reference) when `incoming` is empty — avoids re-render flicker', () => {
    const existing = [entry('a', '2026-04-19T00:00:00.000Z')];
    const merged = mergeActivity(existing, []);
    expect(merged).toBe(existing);
  });

  it('preserves relative order among existing rows when multiple new rows arrive', () => {
    const existing = [
      entry('old1', '2026-04-19T00:00:00.000Z'),
      entry('old2', '2026-04-18T00:00:00.000Z'),
    ];
    const incoming = [
      entry('new1', '2026-04-19T02:00:00.000Z'),
      entry('new2', '2026-04-19T01:30:00.000Z'),
    ];
    const merged = mergeActivity(existing, incoming);
    expect(merged.map((e) => e.id)).toEqual(['new1', 'new2', 'old1', 'old2']);
  });
});

// ---------------------------------------------------------------------------
// resolvePollSince — the poll-baseline decision. Encodes the #630 fix: an
// empty initial load must still poll (off a wall-clock baseline) so a feed
// opened with no rows picks up newly created activity when SSE is unavailable.
// DOM-free by design: the hook composes this helper with its refs, so testing
// the helper exercises the full baseline logic without jsdom.
// ---------------------------------------------------------------------------
describe('resolvePollSince', () => {
  const BASELINE = '2026-04-19T00:00:00.000Z';
  const LATEST = '2026-04-19T01:00:00.000Z';

  it('non-empty feed: polls from the newest row timestamp (existing behavior)', () => {
    expect(resolvePollSince({ latest: LATEST, baseline: BASELINE })).toBe(
      LATEST,
    );
  });

  it('prefers the latest row over the baseline once any row is held', () => {
    // latest is always >= baseline; the row timestamp is the tighter floor and
    // avoids re-fetching rows the feed already shows.
    expect(resolvePollSince({ latest: LATEST, baseline: null })).toBe(LATEST);
  });

  it('empty initial load: polls from the load-time baseline (#630 regression)', () => {
    // The bug: with `latest` null the poll short-circuited and never fetched,
    // so an empty feed without SSE never surfaced new activity until reload.
    // The fix delta-fetches from the baseline instead, picking up first rows.
    expect(resolvePollSince({ latest: null, baseline: BASELINE })).toBe(
      BASELINE,
    );
  });

  it('no baseline yet (initial load not landed): skips the poll', () => {
    expect(resolvePollSince({ latest: null, baseline: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// shouldPollFallback — the delta-poll gate. Encodes the fix for the double
// read: the SWR poll used to run unconditionally once the initial load
// landed, even with an open SSE stream already delivering the same deltas,
// so every open tab issued two `listActivity` calls per tick instead of one.
// DOM-free by design: `visible` is a plain boolean the hook derives from
// `useDocumentVisible()`, so testing the helper exercises the full gate
// logic without jsdom.
// ---------------------------------------------------------------------------
describe('shouldPollFallback', () => {
  // Fails if the implementation at use-activity-feed.ts:119
  // (`return visible && streamState !== 'open';`) is replaced with a
  // constant `true` — the poll would never stop running next to an open
  // stream.
  it('visible + idle stream: polls (no stream to fall back on yet)', () => {
    expect(shouldPollFallback({ streamState: 'idle', visible: true })).toBe(true);
  });

  it('visible + errored stream: polls (stream is down, fallback must cover)', () => {
    expect(shouldPollFallback({ streamState: 'error', visible: true })).toBe(true);
  });

  // Fails if the `streamState !== 'open'` check is dropped — this is the
  // exact case that used to double `listActivity` reads per tick.
  it('visible + open stream: does not poll (stream already delivers deltas)', () => {
    expect(shouldPollFallback({ streamState: 'open', visible: true })).toBe(false);
  });

  // Fails if the `visible &&` guard is dropped — a hidden tab would keep
  // polling for a list nothing renders.
  it('hidden + idle stream: does not poll (nothing on screen to keep fresh)', () => {
    expect(shouldPollFallback({ streamState: 'idle', visible: false })).toBe(false);
  });

  it('hidden + open stream: does not poll (both reasons apply at once)', () => {
    expect(shouldPollFallback({ streamState: 'open', visible: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeFeedStatus — covers the four transitions the live-pulse indicator
// must support. DOM-free by design: the hook composes this helper with React
// state, so testing the helper exercises the full status logic without
// needing jsdom/@testing-library (which the package doesn't pull in).
// ---------------------------------------------------------------------------
const POLL = 2_000;
const NOW = 1_700_000_000_000;

describe('computeFeedStatus', () => {
  it('cold start: no successful fetch yet → reconnecting (not stopped)', () => {
    // The initial-load window. If we reported `stopped` here, the user would
    // see "Refresh the page" before the very first fetch had a chance.
    expect(
      computeFeedStatus({
        streamState: 'idle',
        lastSuccessAt: null,
        refreshIntervalMs: POLL,
        now: NOW,
      }),
    ).toBe('reconnecting');
  });

  it('cold start → live: SSE opens while no fetch has landed yet', () => {
    expect(
      computeFeedStatus({
        streamState: 'open',
        lastSuccessAt: null,
        refreshIntervalMs: POLL,
        now: NOW,
      }),
    ).toBe('live');
  });

  it('keeps reporting live when SSE drops but the poll is still landing updates', () => {
    expect(
      computeFeedStatus({
        streamState: 'error',
        lastSuccessAt: NOW - POLL,
        refreshIntervalMs: POLL,
        now: NOW,
      }),
    ).toBe('live');
    expect(
      computeFeedStatus({
        streamState: 'idle',
        lastSuccessAt: NOW - POLL,
        refreshIntervalMs: POLL,
        now: NOW,
      }),
    ).toBe('live');
  });

  it('live → stopped: poll silence exceeds 3× the poll interval', () => {
    expect(
      computeFeedStatus({
        streamState: 'error',
        lastSuccessAt: NOW - 3 * POLL - 1,
        refreshIntervalMs: POLL,
        now: NOW,
      }),
    ).toBe('stopped');
  });

  it('stopped → live: a fresh successful poll lands after a long silence', () => {
    // Same scenario as above but now lastSuccessAt was just updated. The
    // bug we fixed: `error` from SWR stayed truthy across the recovery and
    // pinned the status at `stopped`. The helper relies on lastSuccessAt
    // only, so a successful poll alone is sufficient.
    expect(
      computeFeedStatus({
        streamState: 'error',
        lastSuccessAt: NOW,
        refreshIntervalMs: POLL,
        now: NOW,
      }),
    ).toBe('live');
  });

  it('reconnecting → live: SSE reopens after recovery', () => {
    expect(
      computeFeedStatus({
        streamState: 'open',
        lastSuccessAt: NOW,
        refreshIntervalMs: POLL,
        now: NOW,
      }),
    ).toBe('live');
  });

  it('boundary: exactly at the 3× threshold counts as stale', () => {
    // `Date.now() - lastSuccessAt < 3 * refreshIntervalMs` — strictly less than.
    expect(
      computeFeedStatus({
        streamState: 'idle',
        lastSuccessAt: NOW - 3 * POLL,
        refreshIntervalMs: POLL,
        now: NOW,
      }),
    ).toBe('stopped');
  });
});
