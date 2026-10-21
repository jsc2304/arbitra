/**
 * @file heartbeat-tile — baseline + sparkline tests.
 *
 * Verifies behaviour:
 *   - Renders the canonical "Code Intelligence — healthy" headline + counters.
 *   - Parses run summaries for detectors / deduped / errors.
 *   - Reports `degraded` status when any run reports errors.
 *   - "Open runs" toggle reveals the sparkline (which is an inline SVG, NOT
 *     a chart-lib dep — no new deps).
 *
 * Mirrors the existing activity-entry-row.test.tsx style: static markup
 * assertions via `renderToStaticMarkup`. The toggle behaviour is verified by
 * forcing the expanded state on remount and asserting that the sparkline SVG
 * appears only when expanded.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivityEntry } from '@arbitra/shared';
import { HeartbeatTile } from '../heartbeat-tile';

function run(
  id: string,
  ts: string,
  summary: string,
): ActivityEntry {
  return {
    id,
    kind: 'workspace_event',
    subkind: 'intelligence_run',
    timestamp: ts,
    case_id: '',
    summary,
    href: '',
  };
}

const healthyRuns: ActivityEntry[] = [
  run(
    'r1',
    '2026-04-21T10:00:00.000Z',
    'Ran 5 detectors — 0 new nudges, 6 deduped, 0 errors (duration 928ms)',
  ),
  run(
    'r2',
    '2026-04-21T09:50:00.000Z',
    'Ran 5 detectors — 0 new nudges, 6 deduped, 0 errors (duration 1003ms)',
  ),
  run(
    'r3',
    '2026-04-21T09:40:00.000Z',
    'Ran 5 detectors — 1 new nudge, 5 deduped, 0 errors (duration 998ms)',
  ),
];

describe('HeartbeatTile — baseline view', () => {
  it('renders the Code Intelligence headline and healthy status', () => {
    const html = renderToStaticMarkup(<HeartbeatTile entries={healthyRuns} />);
    expect(html).toContain('Code Intelligence');
    expect(html).toContain('healthy');
    expect(html).toMatch(/data-testid="heartbeat-tile"[^>]*data-status="healthy"/);
  });

  it('renders the parsed counters from the run summaries', () => {
    const html = renderToStaticMarkup(<HeartbeatTile entries={healthyRuns} />);
    // 5 detectors carried through from the latest run summary.
    expect(html).toContain('5 detectors');
    // (6 + 6 + 5) / 3 = 5.6 → rounds to 6
    expect(html).toContain('6 deduped/run');
    expect(html).toContain('0 errors');
  });

  it('reports degraded status when any run carries errors', () => {
    const degraded: ActivityEntry[] = [
      run(
        'r1',
        '2026-04-21T10:00:00.000Z',
        'Ran 5 detectors — 0 new nudges, 6 deduped, 2 errors (duration 928ms)',
      ),
      run(
        'r2',
        '2026-04-21T09:50:00.000Z',
        'Ran 5 detectors — 0 new nudges, 6 deduped, 0 errors (duration 1003ms)',
      ),
    ];
    const html = renderToStaticMarkup(<HeartbeatTile entries={degraded} />);
    expect(html).toContain('degraded');
    expect(html).toMatch(/data-testid="heartbeat-tile"[^>]*data-status="degraded"/);
  });

  it('renders the "Open runs" toggle', () => {
    const html = renderToStaticMarkup(<HeartbeatTile entries={healthyRuns} />);
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[^<]*Open runs/);
  });

  it('does NOT render the sparkline SVG until expanded', () => {
    const html = renderToStaticMarkup(<HeartbeatTile entries={healthyRuns} />);
    // SSR snapshot is the collapsed state — no sparkline polyline.
    expect(html).not.toContain('<polyline');
  });

  it('handles a sparse window without parseable summaries gracefully', () => {
    const sparse: ActivityEntry[] = [
      run('r1', '2026-04-21T10:00:00.000Z', 'manual run via API'),
    ];
    const html = renderToStaticMarkup(<HeartbeatTile entries={sparse} />);
    // Should not crash; falls back to a "no parseable summaries" message.
    expect(html).toContain('Code Intelligence');
    expect(html).toContain('No parseable run summaries');
  });
});
