/**
 * @file status-badge — color-token regression tests.
 *
 * `Open` and `Done` looked
 * the same on quick scan. Lock the new mapping:
 *   - Open → corp-blue-light  (active, just started)
 *   - Done → muted gray       (completed, neutral)
 * so a regression that re-collapses them to the same hue fails this file.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusBadge } from '../status-badge';

describe('StatusBadge color tokens', () => {
  it('Open uses the corp-blue-light active accent', () => {
    const html = renderToStaticMarkup(<StatusBadge status="open" />);
    expect(html).toContain('corp-blue-light');
    expect(html).not.toContain('corp-green');
  });

  it('Done uses muted neutral gray (not green)', () => {
    const html = renderToStaticMarkup(<StatusBadge status="done" />);
    expect(html).toMatch(/bg-gray-(200|700)/);
    expect(html).not.toContain('corp-green');
    expect(html).not.toContain('corp-blue-light');
  });

  it('Open and Done do not share the same pill background token', () => {
    const open = renderToStaticMarkup(<StatusBadge status="open" />);
    const done = renderToStaticMarkup(<StatusBadge status="done" />);
    // Different statuses must produce different markup.
    expect(open).not.toBe(done);
  });

  // Follow-up #103: collisions with adjacent gray/blue-light tokens.
  it('Done is visually distinct from the unknown/fallback pill', () => {
    const done = renderToStaticMarkup(<StatusBadge status="done" />);
    const unknown = renderToStaticMarkup(<StatusBadge status="some_unknown_status" />);
    expect(done).not.toBe(unknown);
    // Done = bg-gray-200 (deliberate terminal); fallback = bg-gray-50 (ghost).
    expect(done).toContain('bg-gray-200');
    expect(unknown).toContain('bg-gray-50');
  });

  it('Open, exploration, and ready_for_build are visually distinct in pills', () => {
    const open = renderToStaticMarkup(<StatusBadge status="open" />);
    const exploration = renderToStaticMarkup(<StatusBadge status="exploration" />);
    const ready = renderToStaticMarkup(<StatusBadge status="ready_for_build" />);
    expect(open).not.toBe(exploration);
    expect(open).not.toBe(ready);
    expect(exploration).not.toBe(ready);
    // All three share the corp-blue-light hue (palette is locked) but differ
    // in opacity / ring tier.
    expect(open).toContain('corp-blue-light');
    expect(exploration).toContain('corp-blue-light');
    expect(ready).toContain('corp-blue-light');
  });

  it('renders the label text alongside the dot (color is not the only signal)', () => {
    const open = renderToStaticMarkup(<StatusBadge status="open" />);
    const done = renderToStaticMarkup(<StatusBadge status="done" />);
    expect(open).toContain('Open');
    expect(done).toContain('Done');
  });

  // Reduced-motion guard (#662): the live-status pulse is driven by the
  // `.status-dot-pulse` CSS class (gated behind prefers-reduced-motion in
  // globals.css) rather than an inline `animation` style.
  it('drives the non-terminal pulse via the gated CSS class, not inline animation', () => {
    const open = renderToStaticMarkup(<StatusBadge status="open" />);
    expect(open).toContain('status-dot-pulse');
    expect(open).not.toContain('animation:');
  });

  it('does not pulse terminal statuses', () => {
    const done = renderToStaticMarkup(<StatusBadge status="done" />);
    expect(done).not.toContain('status-dot-pulse');
  });

  // Issue #1018: an Observed Case's `in_build` reads as "Observing" (it
  // never builds anything itself) — every other case type keeps "Building".
  it('renders "Observing" for in_build when caseType is observed', () => {
    const html = renderToStaticMarkup(<StatusBadge status="in_build" caseType="observed" />);
    expect(html).toContain('Observing');
    expect(html).not.toContain('Building');
  });

  it('keeps "Building" for in_build on every other case type', () => {
    const engineering = renderToStaticMarkup(<StatusBadge status="in_build" />);
    const assistant = renderToStaticMarkup(<StatusBadge status="in_build" caseType="assistant_task" />);
    expect(engineering).toContain('Building');
    expect(assistant).toContain('Building');
  });
});
