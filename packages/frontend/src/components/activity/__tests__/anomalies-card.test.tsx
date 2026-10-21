/**
 * @file anomalies-card — three-row off-baseline rail card.
 *
 * Covers:
 *  - All three anomaly rows render (Detector errors, Latency spikes,
 *    Attribution drops).
 *  - Stub rows surface a "coming soon" tag instead of a fabricated count.
 *  - Detector-errors count is parsed from the intelligence_run summary text
 *    when at least one run carries `errors > 0`.
 *  - Detector-errors becomes an interactive button only when count > 0.
 *  - Attribution-drops row is interactive whenever `onFilterClick` is wired
 *    (the rail click is the action even when the count is stubbed at 0 —
 *    spec calls out the click-through, not the metric).
 *
 * Node-only — mocks SWR + the api client and asserts via
 * `renderToStaticMarkup`. Click semantics are exercised by reading the
 * presence of the wrapping `<button>` element.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivityEntry } from '@arbitra/shared';

type SWRState = { data?: { entries: ActivityEntry[] }; error?: unknown; isLoading: boolean };
const swrState: SWRState = { isLoading: false };

vi.mock('swr', () => ({
  default: () => swrState,
}));

vi.mock('../../../lib/api-client', () => ({
  api: { activity: { list: vi.fn() } },
}));

import { AnomaliesCard } from '../anomalies-card';

function entry(id: string, ts: string, summary: string): ActivityEntry {
  return {
    id,
    kind: 'workspace_event',
    subkind: 'intelligence_run',
    timestamp: ts,
    case_id: '',
    summary,
    href: '',
  } as ActivityEntry;
}

const NOW_ISO = new Date().toISOString();

beforeEach(() => {
  swrState.data = { entries: [] };
  swrState.error = undefined;
  swrState.isLoading = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AnomaliesCard', () => {
  it('renders all three anomaly rows', () => {
    const html = renderToStaticMarkup(<AnomaliesCard onFilterClick={() => {}} />);
    expect(html).toContain('Detector errors');
    expect(html).toContain('Latency spikes');
    expect(html).toContain('Attribution drops');
  });

  it('renders the "coming soon" tag for stubbed rows', () => {
    const html = renderToStaticMarkup(<AnomaliesCard onFilterClick={() => {}} />);
    // Latency spikes: stub=true, no onClick → coming-soon tag, no button.
    expect(html).toContain('Latency spikes');
    expect(html).toMatch(/coming soon[\s\S]+?Latency spikes|Latency spikes[\s\S]{0,600}?coming soon/);
    // Attribution drops: stub=true BUT has an onClick (click-through is the action) → coming-soon tag + button.
    expect(html).toContain('Attribution drops');
    expect(html).toMatch(/<li><button type="button"[\s\S]+?Attribution drops/);
    // Detector errors: stub=false → no coming-soon tag, real count rendered.
    // With count=0 it must NOT be wrapped in a button.
    expect(html).not.toMatch(/<li><button[^>]*>[\s\S]{0,600}?Detector errors/);
    // Exactly two coming-soon tags total (one per stub row).
    const matches = html.match(/coming soon/g);
    expect(matches?.length).toBe(2);
  });

  it('shows zero detector errors when no runs are in the window', () => {
    swrState.data = { entries: [] };
    const html = renderToStaticMarkup(<AnomaliesCard onFilterClick={() => {}} />);
    // Count cell carries data-testid="anomaly-count" — shape: <span ...>0</span>.
    expect(html).toMatch(/data-testid="anomaly-count"[^>]*>0<\/span>/);
  });

  it('parses detector errors from intelligence_run summary text', () => {
    swrState.data = {
      entries: [
        entry('r1', NOW_ISO, 'Ran 5 detectors — 0 new nudges, 6 deduped, 2 errors (duration 928ms)'),
        entry('r2', NOW_ISO, 'Ran 5 detectors — 1 new nudges, 6 deduped, 1 errors (duration 800ms)'),
      ],
    };
    const html = renderToStaticMarkup(<AnomaliesCard onFilterClick={() => {}} />);
    // 2 + 1 = 3 errors over the window.
    expect(html).toMatch(/data-testid="anomaly-count"[^>]*>3<\/span>/);
  });

  it('skips runs older than 24h when computing detector errors', () => {
    const oldTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    swrState.data = {
      entries: [
        entry('r1', oldTs, 'Ran 5 detectors — 0 new nudges, 6 deduped, 7 errors (duration 928ms)'),
      ],
    };
    const html = renderToStaticMarkup(<AnomaliesCard onFilterClick={() => {}} />);
    expect(html).toMatch(/data-testid="anomaly-count"[^>]*>0<\/span>/);
  });

  it('makes the detector-errors row interactive only when count > 0', () => {
    // Count is 0 — the detector-errors row must NOT be wrapped in a button.
    swrState.data = { entries: [] };
    const htmlA = renderToStaticMarkup(<AnomaliesCard onFilterClick={() => {}} />);
    // Explicit negative assertion: no <li><button ...>...Detector errors sequence.
    expect(htmlA).not.toMatch(/<li><button[^>]*>[\s\S]+?Detector errors/);

    // Count > 0 → wrapped in a button.
    swrState.data = {
      entries: [
        entry('r1', NOW_ISO, 'Ran 5 detectors — 0 new nudges, 6 deduped, 4 errors (duration 928ms)'),
      ],
    };
    const htmlB = renderToStaticMarkup(<AnomaliesCard onFilterClick={() => {}} />);
    // The detector-errors row is the first <li>, and now it should contain a
    // <button type="button">.
    expect(htmlB).toMatch(/<li><button type="button"[\s\S]+?Detector errors/);
  });

  it('renders attribution-drops as an interactive button when onFilterClick is wired', () => {
    const html = renderToStaticMarkup(<AnomaliesCard onFilterClick={() => {}} />);
    // Attribution drops gets a button regardless of count (the click is the
    // action — Raw mode pin lands users on the audit log).
    expect(html).toMatch(/<li><button type="button"[\s\S]+?Attribution drops/);
  });

  it('renders all rows as plain <li> when onFilterClick is omitted', () => {
    const html = renderToStaticMarkup(<AnomaliesCard />);
    // No <button> wrappers when click is not wired.
    expect(html.match(/<li><button/g)).toBeNull();
  });
});
