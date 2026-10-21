'use client';

import { useMemo } from 'react';
import {
  formatAbsoluteDate,
  formatAbsoluteTooltip,
  formatClockTime,
} from '../../lib/relative-time';
import { useRelativeTime } from '../../lib/use-relative-time';
import { Tooltip } from './tooltip';

interface RelativeTimeProps {
  /** ISO-8601 string, epoch number, or `Date` instance. */
  timestamp: string | number | Date;
  /** Extra className applied to the rendered <time> element. */
  className?: string;
  /** Optional prefix prepended with a single space ("Created", "Updated", …). */
  prefix?: string;
  /**
   * Display mode:
   *  - "relative" (default): bucketed `just now` / `Nm ago` / `Nh ago` /
   *    `Nd ago` / `MMM D` / `MMM D, YYYY`. Auto-refreshes via the shared 60s
   *    tick.
   *  - "absolute": stable long-form date (`May 6, 2026`). Used on case
   *    headers and other surfaces that want the canonical date alongside a
   *    relative companion field.
   *  - "exact": full local datetime plus UTC offset. Used when the instant is
   *    itself part of the meaning, such as a Clerk answer's `as_of` anchor.
   *
   * In either mode the hover/focus tooltip surfaces the full datetime with
   * timezone offset (`2026-05-06 14:24:08 (UTC+02:00)`).
   */
  mode?: 'relative' | 'absolute' | 'exact';
  /**
   * When true, refreshes every second while the timestamp is younger than
   * 60s, then degrades to the shared 60s tick. Used for fresh streamed-in
   * rows. Costs one extra shared interval app-wide — never per-row.
   */
  liveSeconds?: boolean;
  /**
   * Inline time precision appended to the relative label:
   *  - "minute" (default): bucketed relative label only.
   *  - "seconds": appends ` · HH:MM:SS` (local, 24h) so the second-level
   *    signal stays inline on tightly-clustered surfaces (timeline burst
   *    groups) where the bucketed label collapses several events to the same
   *    string. Only applied in the default "relative" mode.
   */
  precision?: 'minute' | 'seconds';
}

/**
 * Canonical timestamp primitive — every user-visible timestamp in the app
 * should render through this component. Single source of truth for the
 * timestamp formatting rules.
 *
 * Uses the shared `<Tooltip>` primitive so the absolute
 * datetime is keyboard-focusable (focus-visible) and not invisible on touch
 * the way native `title=` is. The semantic `<time>` element with `dateTime`
 * is preserved for accessibility/SEO.
 */
export function RelativeTime({
  timestamp,
  className,
  prefix,
  mode = 'relative',
  liveSeconds = false,
  precision = 'minute',
}: RelativeTimeProps) {
  const relative = useRelativeTime(timestamp, liveSeconds);
  const iso = useMemo(() => safeIso(timestamp), [timestamp]);
  const tooltip = useMemo(() => formatAbsoluteTooltip(timestamp), [timestamp]);
  const absolute = useMemo(() => formatAbsoluteDate(timestamp), [timestamp]);
  const clock = useMemo(
    () =>
      mode === 'relative' && precision === 'seconds'
        ? formatClockTime(timestamp)
        : '',
    [mode, precision, timestamp],
  );

  const base = mode === 'absolute' ? absolute : mode === 'exact' ? tooltip : relative;
  const label = clock ? `${base} · ${clock}` : base;
  const text = prefix ? `${prefix} ${label}` : label;

  return (
    <Tooltip label={tooltip}>
      <time dateTime={iso} className={className} tabIndex={0}>
        {text}
      </time>
    </Tooltip>
  );
}

function safeIso(value: string | number | Date): string {
  try {
    const d = value instanceof Date ? value : new Date(value);
    const ms = d.getTime();
    if (Number.isNaN(ms)) return '';
    return d.toISOString();
  } catch {
    return '';
  }
}
