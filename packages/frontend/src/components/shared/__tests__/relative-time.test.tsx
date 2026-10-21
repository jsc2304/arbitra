/**
 * @file RelativeTime primitive — render-surface tests.
 *
 * Server-render only (renderToStaticMarkup). Locks:
 *   1. The default "relative" output is unchanged by the new `precision` prop.
 *   2. `precision="seconds"` appends ` · HH:MM:SS` inline so the second-level
 *      signal survives on tightly-clustered surfaces (timeline burst groups).
 *   3. `precision="seconds"` is a no-op in "absolute" mode.
 *   4. Exact mode renders the full datetime plus timezone offset inline.
 *   5. The semantic <time dateTime> + tooltip wiring is preserved.
 *
 * The 60s/1s tick refresh behaviour lives in `use-relative-time` and isn't
 * exercised here — the first paint (useState initializer) is deterministic.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RelativeTime } from '../relative-time';

// A fixed instant well inside the "Nm ago" bucket relative to render time, so
// the relative label is stable across the test run (always "just now" or a
// small-minutes label). We instead use a clearly-bucketed older timestamp for
// the seconds-precision assertions where the date portion is deterministic.
const CLUSTERED = '2026-05-06T12:24:08.000Z';

describe('RelativeTime — precision="seconds" (burst groups)', () => {
  it('default output is unchanged (no inline clock time)', () => {
    const html = renderToStaticMarkup(<RelativeTime timestamp={CLUSTERED} />);
    // No appended ` · HH:MM:SS` segment in the default relative mode.
    expect(html).not.toMatch(/·\s*\d{2}:\d{2}:\d{2}/);
  });

  it('appends an inline HH:MM:SS clock segment in seconds precision', () => {
    const html = renderToStaticMarkup(
      <RelativeTime timestamp={CLUSTERED} precision="seconds" />,
    );
    expect(html).toMatch(/·\s*\d{2}:\d{2}:\d{2}/);
    // The seconds component is preserved (the whole point of the mode).
    expect(html).toMatch(/:08(?!\d)/);
  });

  it('keeps the same clustered-minute label but distinct second segments', () => {
    const a = renderToStaticMarkup(
      <RelativeTime timestamp="2026-05-06T12:24:01.000Z" precision="seconds" />,
    );
    const b = renderToStaticMarkup(
      <RelativeTime timestamp="2026-05-06T12:24:47.000Z" precision="seconds" />,
    );
    expect(a).toMatch(/:01(?!\d)/);
    expect(b).toMatch(/:47(?!\d)/);
    expect(a).not.toBe(b);
  });

  it('is a no-op in absolute mode (no clock time appended)', () => {
    const html = renderToStaticMarkup(
      <RelativeTime timestamp={CLUSTERED} mode="absolute" precision="seconds" />,
    );
    expect(html).not.toMatch(/·\s*\d{2}:\d{2}:\d{2}/);
  });

  it('renders the full local datetime and UTC offset in exact mode', () => {
    const html = renderToStaticMarkup(
      <RelativeTime timestamp={CLUSTERED} mode="exact" prefix="As of" />,
    );

    expect(html).toContain('As of');
    expect(html).toMatch(/12:24:08/);
    expect(html).toContain('UTC');
  });

  it('preserves the semantic <time dateTime> element', () => {
    const html = renderToStaticMarkup(
      <RelativeTime timestamp={CLUSTERED} precision="seconds" />,
    );
    expect(html).toMatch(/<time[^>]*datetime="2026-05-06T12:24:08\.000Z"/i);
  });
});
