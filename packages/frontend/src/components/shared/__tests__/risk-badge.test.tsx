/**
 * @file risk-badge — color-token regression tests.
 *
 * `Risk: Low` was rendered in
 * warning-yellow, which read as "low-grade hazard" rather than "we are fine".
 * Lock the corrected ramp:
 *   - low      → corp-green   (success / not worried)
 *   - medium   → corp-yellow  (warning)
 *   - high     → corp-orange  (warning escalated)
 *   - critical → corp-red     (danger)
 * The rendered label text always backs up the color (color is not the only
 * signal).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RiskBadge } from '../risk-badge';

describe('RiskBadge color tokens', () => {
  it('Low uses success-green (corp-green), not warning-yellow', () => {
    const html = renderToStaticMarkup(<RiskBadge level="low" />);
    expect(html).toContain('corp-green');
    expect(html).not.toContain('yellow-500');
  });

  it('Medium uses corp-yellow (warning)', () => {
    const html = renderToStaticMarkup(<RiskBadge level="medium" />);
    expect(html).toContain('corp-yellow');
    expect(html).not.toContain('orange-500');
  });

  it('High uses corp-orange', () => {
    const html = renderToStaticMarkup(<RiskBadge level="high" />);
    expect(html).toContain('corp-orange');
    expect(html).not.toContain('red-500');
  });

  it('Critical uses corp-red', () => {
    const html = renderToStaticMarkup(<RiskBadge level="critical" />);
    expect(html).toContain('corp-red');
    expect(html).not.toContain('rose-600');
  });

  it('renders the contextual "Risk: <Level>" label so color is not the sole signal', () => {
    expect(renderToStaticMarkup(<RiskBadge level="low" />)).toContain('Risk: Low');
    expect(renderToStaticMarkup(<RiskBadge level="critical" />)).toContain('Risk: Critical');
  });
});
