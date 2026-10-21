import { describe, expect, it } from 'vitest';
import {
  formatAbsoluteDate,
  formatAbsoluteTooltip,
  formatClockTime,
  formatRelativeTime,
  isOlderThanOneYear,
} from '../relative-time';

const NOW = Date.parse('2026-04-23T14:50:43.000Z');

function agoMs(ms: number): number {
  return NOW - ms;
}

describe('formatRelativeTime', () => {
  it('returns "just now" for timestamps under 60 seconds old', () => {
    expect(formatRelativeTime(agoMs(0), NOW)).toBe('just now');
    expect(formatRelativeTime(agoMs(5_000), NOW)).toBe('just now');
    expect(formatRelativeTime(agoMs(59_000), NOW)).toBe('just now');
  });

  it('returns "just now" for slightly future timestamps (clock skew)', () => {
    expect(formatRelativeTime(NOW + 2_000, NOW)).toBe('just now');
  });

  it('returns "Nm ago" between 1 minute and 60 minutes', () => {
    expect(formatRelativeTime(agoMs(60_000), NOW)).toBe('1m ago');
    expect(formatRelativeTime(agoMs(5 * 60_000), NOW)).toBe('5m ago');
    expect(formatRelativeTime(agoMs(59 * 60_000), NOW)).toBe('59m ago');
  });

  it('returns "Nh ago" between 1 and 24 hours', () => {
    expect(formatRelativeTime(agoMs(60 * 60_000), NOW)).toBe('1h ago');
    expect(formatRelativeTime(agoMs(23 * 60 * 60_000), NOW)).toBe('23h ago');
  });

  it('returns "Nd ago" between 1 and 7 days', () => {
    expect(formatRelativeTime(agoMs(24 * 60 * 60_000), NOW)).toBe('1d ago');
    expect(formatRelativeTime(agoMs(6 * 24 * 60 * 60_000), NOW)).toBe('6d ago');
  });

  it('falls back to month/day at 7+ days, no year, under 365 days', () => {
    const sevenDays = agoMs(7 * 24 * 60 * 60_000);
    const result = formatRelativeTime(sevenDays, NOW);
    expect(result).not.toMatch(/ago$/);
    expect(result).not.toBe('just now');
    // Should NOT include a 4-digit year for sub-365d.
    expect(result).not.toMatch(/\d{4}/);
    // Should look like `MMM D` (e.g. "Apr 16").
    expect(result).toMatch(/^[A-Z][a-z]{2,} \d{1,2}$/);
  });

  it('includes the year for timestamps 365+ days old', () => {
    const oneYear = agoMs(366 * 24 * 60 * 60_000);
    const result = formatRelativeTime(oneYear, NOW);
    expect(result).toMatch(/\d{4}/);
    // `MMM D, YYYY` form.
    expect(result).toMatch(/^[A-Z][a-z]{2,} \d{1,2}, \d{4}$/);
  });

  it('accepts ISO string, number, and Date inputs', () => {
    const iso = new Date(agoMs(5 * 60_000)).toISOString();
    expect(formatRelativeTime(iso, NOW)).toBe('5m ago');
    expect(formatRelativeTime(agoMs(5 * 60_000), NOW)).toBe('5m ago');
    expect(formatRelativeTime(new Date(agoMs(5 * 60_000)), NOW)).toBe('5m ago');
  });

  it('returns empty string for unparseable input', () => {
    expect(formatRelativeTime('not a date', NOW)).toBe('');
  });
});

describe('formatAbsoluteTooltip', () => {
  it('renders date, time, and timezone offset', () => {
    const result = formatAbsoluteTooltip('2026-05-06T12:24:08.000Z');
    // Date and time portions are locale-formatted; only assert structure.
    expect(result).toMatch(/\(UTC[+-]\d{2}:\d{2}\)$/);
    expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('returns empty string for unparseable input', () => {
    expect(formatAbsoluteTooltip('not a date')).toBe('');
  });
});

describe('formatClockTime', () => {
  it('renders 24h HH:MM:SS', () => {
    const result = formatClockTime('2026-05-06T12:24:08.000Z');
    // Locale/timezone shift the absolute hour, but the structure is fixed:
    // two-digit hour, minute, and second separated by colons, 24h (no AM/PM).
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    // The seconds component must survive — this is the whole point of the mode.
    expect(result.endsWith(':08')).toBe(true);
  });

  it('preserves second-level disambiguation for events in the same minute', () => {
    const a = formatClockTime('2026-05-06T12:24:01.000Z');
    const b = formatClockTime('2026-05-06T12:24:47.000Z');
    expect(a).not.toBe(b);
    expect(a.endsWith(':01')).toBe(true);
    expect(b.endsWith(':47')).toBe(true);
  });

  it('returns empty string for unparseable input', () => {
    expect(formatClockTime('not a date')).toBe('');
  });
});

describe('isOlderThanOneYear', () => {
  it('is false under 365 days', () => {
    expect(isOlderThanOneYear(agoMs(364 * 24 * 60 * 60_000), NOW)).toBe(false);
  });

  it('is true at exactly 365 days (long-form threshold)', () => {
    expect(isOlderThanOneYear(agoMs(365 * 24 * 60 * 60_000), NOW)).toBe(true);
  });

  it('is true well past a year', () => {
    expect(isOlderThanOneYear(agoMs(366 * 24 * 60 * 60_000), NOW)).toBe(true);
  });

  it('agrees with formatRelativeTime flipping to MMM D, YYYY', () => {
    // The threshold this helper guards must match the formatter's year cutover
    // so the case-header range presentation never disagrees with the label.
    const boundary = agoMs(365 * 24 * 60 * 60_000);
    expect(isOlderThanOneYear(boundary, NOW)).toBe(true);
    expect(formatRelativeTime(boundary, NOW)).toMatch(/\d{4}/);

    const justUnder = agoMs(364 * 24 * 60 * 60_000);
    expect(isOlderThanOneYear(justUnder, NOW)).toBe(false);
    expect(formatRelativeTime(justUnder, NOW)).not.toMatch(/\d{4}/);
  });

  it('is false for unparseable input', () => {
    expect(isOlderThanOneYear('not a date', NOW)).toBe(false);
  });
});

describe('formatAbsoluteDate', () => {
  it('renders long month, day, year', () => {
    const result = formatAbsoluteDate('2026-05-06T12:24:08.000Z');
    // Locale-dependent ordering; assert all three components are present.
    expect(result).toMatch(/2026/);
    expect(result).toMatch(/(May|Mai)/);
    expect(result).toMatch(/\b6\b/);
  });

  it('returns empty string for unparseable input', () => {
    expect(formatAbsoluteDate('not a date')).toBe('');
  });
});
