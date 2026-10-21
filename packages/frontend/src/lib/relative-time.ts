/**
 * Compact relative-time formatting for user-visible timestamps. Single
 * canonical formatter used by `<RelativeTime>` everywhere a timestamp
 * is rendered to the user.
 *
 * Thresholds:
 *   <  60s     → "just now"
 *   <  60min   → "Nm ago"
 *   <  24h     → "Nh ago"
 *   <   7d    → "Nd ago"
 *   <  365d   → "MMM D"          (e.g. "Apr 29")
 *   >= 365d   → "MMM D, YYYY"    (e.g. "Apr 29, 2025")
 *
 * The formatter is pure — no React imports. Companion `useRelativeTime`
 * (see ./use-relative-time) keeps rendered strings fresh via a single
 * shared 60s broadcast tick.
 */

const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

const CLOCK_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const LONG_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

export function formatRelativeTime(
  timestamp: string | number | Date,
  now: number = Date.now(),
): string {
  const thenMs = toMs(timestamp);
  if (Number.isNaN(thenMs)) return '';

  const diffMs = now - thenMs;

  // Future timestamps (clock skew or just-posted): treat as "just now".
  if (diffMs < MINUTE_MS) return 'just now';

  if (diffMs < HOUR_MS) {
    const minutes = Math.floor(diffMs / MINUTE_MS);
    return `${minutes}m ago`;
  }

  if (diffMs < DAY_MS) {
    const hours = Math.floor(diffMs / HOUR_MS);
    return `${hours}h ago`;
  }

  if (diffMs < WEEK_MS) {
    const days = Math.floor(diffMs / DAY_MS);
    return `${days}d ago`;
  }

  const date = new Date(thenMs);
  if (diffMs < YEAR_MS) return SHORT_DATE_FORMATTER.format(date);
  return LONG_DATE_FORMATTER.format(date);
}

/**
 * Long-form absolute label used as the hover/focus tooltip on every
 * `<RelativeTime>`. Always includes timezone offset so a user reading the
 * absolute time across regions can disambiguate.
 *
 * Example output: `2026-05-06 14:24:08 (UTC+02:00)`
 *
 * `Intl.DateTimeFormat` is used with the user's locale (`undefined`) so the
 * date portion respects locale conventions; the trailing `(UTC±HH:MM)`
 * suffix is appended deterministically since not every locale renders the
 * offset in a stable, parseable way.
 */
export function formatAbsoluteTooltip(
  timestamp: string | number | Date,
): string {
  const ms = toMs(timestamp);
  if (Number.isNaN(ms)) return '';
  const date = new Date(ms);
  const datePart = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
  return `${datePart} (${formatTzOffset(date)})`;
}

/**
 * Long-form absolute date used by the case-header "Created" line and other
 * surfaces that need a stable absolute label (no time-of-day) instead of
 * the relative form.
 *
 * Example output: `May 6, 2026`
 */
export function formatAbsoluteDate(
  timestamp: string | number | Date,
): string {
  const ms = toMs(timestamp);
  if (Number.isNaN(ms)) return '';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(ms));
}

/**
 * Local clock time at second resolution (`HH:MM:SS`, 24h). Used by the
 * `precision="seconds"` mode of `<RelativeTime>` to keep the second-level
 * signal inline on tightly-clustered surfaces (timeline burst groups), where
 * the bucketed relative label collapses multiple events to the same string.
 *
 * Example output: `14:24:08`
 */
export function formatClockTime(timestamp: string | number | Date): string {
  const ms = toMs(timestamp);
  if (Number.isNaN(ms)) return '';
  return CLOCK_TIME_FORMATTER.format(new Date(ms));
}

/**
 * True when the timestamp is at least 365 days old — the point at which
 * `formatRelativeTime` switches to the long-form `MMM D, YYYY` label. Single
 * source of truth for the year threshold so callers (e.g. the case-header
 * range presentation) stay in lockstep with the formatter.
 */
export function isOlderThanOneYear(
  timestamp: string | number | Date,
  now: number = Date.now(),
): boolean {
  const ms = toMs(timestamp);
  if (Number.isNaN(ms)) return false;
  return now - ms >= YEAR_MS;
}

function formatTzOffset(date: Date): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

function toMs(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}
