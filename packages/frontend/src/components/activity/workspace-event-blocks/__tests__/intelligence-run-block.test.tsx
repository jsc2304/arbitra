/**
 * @file intelligence-run-block — rendering tests.
 *
 * Node-only rendering via renderToStaticMarkup (no jsdom). We verify the
 * detector summary table + run totals + run-id link gating.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkspaceEvent } from '@arbitra/shared';
import { IntelligenceRunBlock } from '../intelligence-run-block';

function makeEvent(evidence: Record<string, unknown> | undefined): WorkspaceEvent {
  return {
    event_id: 'workspaceEvent_run_1',
    type: 'intelligence_run',
    actor_user_id: 'system:arbitra-intelligence',
    timestamp: '2026-04-23T12:00:00.000Z',
    summary: 'Ran 2 detectors — 1 new nudge, 0 deduped, 0 errors (duration 320ms)',
    evidence,
  };
}

describe('IntelligenceRunBlock', () => {
  it('renders a row per detector with id, finding count, and duration', () => {
    const html = renderToStaticMarkup(
      <IntelligenceRunBlock
        event={makeEvent({
          duration_ms: 320,
          cases_created: 1,
          errors: 0,
          detectors: [
            { detector: 'stale_pr', cases_created: 1, cases_skipped_existing: 0, duration_ms: 210 },
            { detector: 'never_merged', cases_created: 0, cases_skipped_existing: 2, duration_ms: 110 },
          ],
        })}
      />,
    );
    expect(html).toContain('stale_pr');
    expect(html).toContain('never_merged');
    // Durations render in ms.
    expect(html).toContain('210 ms');
    expect(html).toContain('110 ms');
    // Finding count pulls from cases_created.
    expect(html).toContain('>1<');
    expect(html).toContain('>0<');
  });

  it('renders the total run duration and detector count as top-level stats', () => {
    const html = renderToStaticMarkup(
      <IntelligenceRunBlock
        event={makeEvent({
          duration_ms: 555,
          detectors: [{ detector: 'a', duration_ms: 100 }],
        })}
      />,
    );
    expect(html).toContain('555 ms');
    expect(html).toContain('Duration');
    expect(html).toContain('Detectors');
  });

  it('flags the detector row when it carried an error', () => {
    const html = renderToStaticMarkup(
      <IntelligenceRunBlock
        event={makeEvent({
          detectors: [
            { detector: 'broken_detector', duration_ms: 40, error: 'connection refused' },
          ],
        })}
      />,
    );
    expect(html).toContain('broken_detector');
    expect(html).toContain('error');
    expect(html).toContain('connection refused');
  });

  it('renders the top-level run error when present', () => {
    const html = renderToStaticMarkup(
      <IntelligenceRunBlock event={makeEvent({ error: 'lock_contention', detectors: [] })} />,
    );
    expect(html).toContain('Run error');
    expect(html).toContain('lock_contention');
  });

  it('omits the "View full run" link when run_id is absent', () => {
    const html = renderToStaticMarkup(
      <IntelligenceRunBlock event={makeEvent({ detectors: [] })} />,
    );
    expect(html).not.toContain('View full run');
  });

  it('renders the "View full run" link when run_id is present', () => {
    const html = renderToStaticMarkup(
      <IntelligenceRunBlock
        event={makeEvent({ run_id: 'irun_abc', detectors: [] })}
      />,
    );
    expect(html).toContain('View full run');
    expect(html).toContain('/observatory/intelligence/runs/irun_abc');
  });

  it('falls back to a friendly message when there are no detector summaries', () => {
    const html = renderToStaticMarkup(
      <IntelligenceRunBlock event={makeEvent({ detectors: [] })} />,
    );
    expect(html).toContain('No per-detector summaries');
  });
});
