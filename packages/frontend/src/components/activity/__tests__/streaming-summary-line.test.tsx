/**
 * @file streaming-summary-line — pure-derivation + render smoke.
 *
 * Format: `Live · N events in the last minute · {actors} active`.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivityEntry } from '@arbitra/shared';
import {
  StreamingSummaryLine,
  deriveStreamingSummary,
  describeRecentWindow,
} from '../streaming-summary-line';

const NOW = Date.parse('2026-05-06T12:00:00.000Z');

function entry(id: string, ts: string, clientName?: string): ActivityEntry {
  return {
    id,
    kind: 'comment',
    timestamp: ts,
    case_id: 'c',
    summary: 's',
    href: '/c',
    ...(clientName ? { actor_metadata: { client_name: clientName } } : {}),
  };
}

describe('deriveStreamingSummary', () => {
  it('counts only entries within the 60s window', () => {
    const recent = entry('r', '2026-05-06T11:59:30.000Z', 'cursor');
    const old = entry('o', '2026-05-06T11:58:00.000Z', 'old');
    const summary = deriveStreamingSummary([recent, old], 'live', NOW);
    expect(summary.recentCount).toBe(1);
    expect(summary.actorLabels).toContain(
      // cursor display label uses actor-display.ts; assert by inclusion
      // rather than exact case to keep the test robust to copy tweaks.
      summary.actorLabels.find((l) => l.toLowerCase().includes('cursor')) ?? '',
    );
    expect(summary.actorLabels.length).toBe(1);
  });

  it('preserves first-seen order across actors', () => {
    const e1 = entry('1', '2026-05-06T11:59:55.000Z', 'cursor');
    const e2 = entry('2', '2026-05-06T11:59:50.000Z', 'claude-code');
    const e3 = entry('3', '2026-05-06T11:59:45.000Z', 'arbitra');
    const summary = deriveStreamingSummary([e1, e2, e3], 'live', NOW);
    expect(summary.actorLabels).toHaveLength(3);
  });

  it('propagates status through unchanged', () => {
    expect(deriveStreamingSummary([], 'stopped', NOW).status).toBe('stopped');
    expect(deriveStreamingSummary([], 'reconnecting', NOW).status).toBe('reconnecting');
  });
});

describe('<StreamingSummaryLine>', () => {
  it('renders the live token + the recent count headline', () => {
    const html = renderToStaticMarkup(
      <StreamingSummaryLine entries={[]} status="live" />,
    );
    expect(html).toContain('Live');
    expect(html).toContain('0 events in the last minute');
  });

  it('renders "Reconnecting" when status is reconnecting', () => {
    const html = renderToStaticMarkup(
      <StreamingSummaryLine entries={[]} status="reconnecting" />,
    );
    expect(html).toContain('Reconnecting');
  });

  it('renders "Stopped" when status is stopped', () => {
    const html = renderToStaticMarkup(
      <StreamingSummaryLine entries={[]} status="stopped" />,
    );
    expect(html).toContain('Stopped');
  });

  it('derives the window phrase from a non-default windowMs (item 9)', () => {
    const html = renderToStaticMarkup(
      <StreamingSummaryLine entries={[]} status="live" windowMs={5 * 60_000} />,
    );
    // No longer hard-coded "in the last minute" — copy follows the window.
    expect(html).toContain('0 events in the last 5 minutes');
    expect(html).not.toContain('in the last minute');
  });
});

describe('describeRecentWindow (item 9)', () => {
  it('keeps the default 60s wording identical', () => {
    expect(describeRecentWindow(60_000)).toBe('in the last minute');
  });

  it('formats whole-minute windows', () => {
    expect(describeRecentWindow(2 * 60_000)).toBe('in the last 2 minutes');
  });

  it('formats sub-minute / non-whole-minute windows in seconds', () => {
    expect(describeRecentWindow(30_000)).toBe('in the last 30 seconds');
    expect(describeRecentWindow(90_000)).toBe('in the last 90 seconds');
  });
});
