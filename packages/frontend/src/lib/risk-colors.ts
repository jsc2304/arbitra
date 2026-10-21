import type { RiskLevel } from '@arbitra/shared';

/**
 * Risk palette — full traffic-light ramp (green → yellow → orange → red).
 *
 * `Risk: Low` previously used
 * warning-yellow, which made low risk read as a low-grade hazard rather than
 * the "we are not worried about this" semantic the rest of the app relies on.
 * The ramp is now monotonic from success-green to danger-red so a quick scan
 * matches intuition.
 *
 * Token alignment: low/medium/high/critical now share the corp-green /
 * corp-yellow / corp-orange / corp-red semantic tokens — the same family used
 * by `SeverityBadge`, so risk and severity read as one consistent ramp.
 */

export interface RiskPillColor {
  /** background + text + ring classes for the pill container (light + dark) */
  pill: string;
  /** solid colour class for a companion dot (same hue as the pill) */
  dot: string;
  /** box-shadow string for a subtle glow around the dot */
  glow: string;
}

export const RISK_PILL_COLORS: Record<RiskLevel, RiskPillColor> = {
  low: {
    pill:
      'bg-corp-green/15 text-corp-dark ring-1 ring-corp-green/40 ' +
      'dark:bg-corp-green/20 dark:text-corp-green dark:ring-corp-green/40',
    dot: 'bg-corp-green',
    glow: '0 0 4px 1px rgba(151,211,63,0.45)',
  },
  medium: {
    pill:
      'bg-corp-yellow/20 text-corp-dark ring-1 ring-corp-yellow/50 ' +
      'dark:bg-corp-yellow/25 dark:text-corp-yellow dark:ring-corp-yellow/50',
    dot: 'bg-corp-yellow',
    glow: '0 0 4px 1px rgba(252,203,48,0.45)',
  },
  high: {
    pill:
      'bg-corp-orange/15 text-corp-dark ring-1 ring-corp-orange/40 ' +
      'dark:bg-corp-orange/20 dark:text-corp-orange dark:ring-corp-orange/40',
    dot: 'bg-corp-orange',
    glow: '0 0 4px 1px rgba(247,151,36,0.5)',
  },
  critical: {
    pill:
      'bg-corp-red/15 text-corp-dark ring-1 ring-corp-red/45 ' +
      'dark:bg-corp-red/25 dark:text-corp-red dark:ring-corp-red/45',
    dot: 'bg-corp-red',
    glow: '0 0 5px 1px rgba(238,72,29,0.55)',
  },
};

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

/**
 * Hex values for the risk ramp — used in chart/visualisation contexts where
 * Tailwind class strings cannot be applied (e.g. Recharts colour props).
 * Keep these in sync with the Tailwind tokens above.
 */
export const RISK_HEX: Record<RiskLevel, string> = {
  low: '#97D33F',     // corp-green
  medium: '#FCCB30',  // corp-yellow
  high: '#F79724',    // corp-orange
  critical: '#EE481D', // corp-red
};
