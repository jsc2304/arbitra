/**
 * `<ClerkScheduledEditor>`'s friendly schedule builder — pure logic (#793).
 * Pattern: a familiar schedule dialog (radio-group frequency picker, weekday
 * checkbox grid, hh:mm time field) — MINUS start-date/end-date fields, which
 * have no backend semantics here and are explicitly out of scope.
 *
 * This module owns exactly two directions of one mapping:
 *
 *  - `buildCron(state)` — a `ScheduleBuilderState` → the 5-field cron string
 *    `clerk-scheduled-panel.tsx` already sends as `cron_schedule`, unchanged
 *    on the wire (`taskBlueprintCronScheduleSchema` still validates it the
 *    same way; this module produces nothing that schema wouldn't already
 *    accept from the raw-text field it replaces as the PRIMARY control).
 *  - `cronToBuilderState(cron)` — the reverse. Recognizes exactly five
 *    families (daily, weekdays, weekly, monthly, interval) and populates the
 *    matching state; anything else — a foreign schedule authored outside
 *    this builder, a weekday name abbreviation, a constrained month, a
 *    malformed field count — opens in the `'advanced'` family with the raw
 *    string preserved verbatim in `advancedCron`. This is deliberately
 *    narrower than `describeCronSchedule` (which also renders every-N-minutes
 *    and every-N-hours-at-a-fixed-minute as prose): this builder's `interval`
 *    family covers every-N-minutes and every-N-hours, but every-N-hours here
 *    is fixed to minute 0 (`0 * /N * * *`) — no minute-offset control exists
 *    in the interval UI, so a cron with a NON-zero minute alongside an hourly
 *    step (e.g. `30 * /2 * * *`, which `describeCronSchedule` DOES render as
 *    prose: "Every 2 hours at minute 30") does not round-trip through this
 *    builder and correctly falls back to `'advanced'`.
 *
 * Cron's day-of-week field is 0–7 with BOTH 0 and 7 meaning Sunday. This
 * module only ever EMITS 0 for Sunday (1–6 for Mon–Sat, matching
 * `WEEKDAY_BUILDER_OPTIONS` below) — `buildCron` never produces a 7. Reverse
 * mapping is more permissive: a foreign cron using 7 for Sunday is still
 * recognized as the `'weekly'` family (normalized to 0), the same tolerance
 * `describeCronSchedule`'s `weekdayName` already has, so an existing
 * blueprint saved before this builder existed (or hand-edited via Advanced)
 * opens populated instead of dropping to Advanced over a spelling of Sunday
 * this module doesn't happen to produce itself.
 */

export type ScheduleFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'interval' | 'advanced';

export type ScheduleIntervalUnit = 'minutes' | 'hours';

export interface ScheduleBuilderState {
  frequency: ScheduleFrequency;
  /** `"HH:MM"`, 24-hour — the value shape a native `<input type="time">` reads and writes. Used by daily/weekdays/weekly/monthly. */
  time: string;
  /** Cron day-of-week values, 0 (Sunday)–6 (Saturday). Used by `'weekly'` only; ignored (but preserved) by every other family. */
  weekdays: number[];
  /** 1–28. Used by `'monthly'` only. Capped at 28 so no month is ever skipped — see `MAX_BUILDER_DAY_OF_MONTH`. */
  dayOfMonth: number;
  /** >= 1. Used by `'interval'` only. */
  intervalValue: number;
  /** Used by `'interval'` only. */
  intervalUnit: ScheduleIntervalUnit;
  /**
   * The raw cron text for the `'advanced'` family. Also doubles as "the last
   * cron this state produced before switching frequency AWAY from advanced"
   * is NOT stored here — that direction is the editor component's job (it
   * seeds `advancedCron` from `buildCron` on transition INTO advanced so the
   * text box never starts blank); this field itself is just data.
   */
  advancedCron: string;
}

/** Day-of-month choices this builder's monthly picker offers, in the UI's Mon-Sun-style ascending order. */
export const MAX_BUILDER_DAY_OF_MONTH = 28;

const DEFAULT_TIME = '09:00';
const DEFAULT_WEEKDAYS: readonly number[] = [1]; // Monday
const DEFAULT_DAY_OF_MONTH = 1;
const DEFAULT_INTERVAL_VALUE = 15;
const DEFAULT_INTERVAL_UNIT: ScheduleIntervalUnit = 'minutes';

/** A fresh builder state for a new blueprint — Daily at 09:00, everything else defaulted so switching frequency never starts from an empty sub-field. */
export function defaultScheduleBuilderState(): ScheduleBuilderState {
  return {
    frequency: 'daily',
    time: DEFAULT_TIME,
    weekdays: [...DEFAULT_WEEKDAYS],
    dayOfMonth: DEFAULT_DAY_OF_MONTH,
    intervalValue: DEFAULT_INTERVAL_VALUE,
    intervalUnit: DEFAULT_INTERVAL_UNIT,
    advancedCron: '',
  };
}

// ─── frequency / weekday option lists (for the radio-group and checkbox grid) ──

export const SCHEDULE_FREQUENCY_OPTIONS: ReadonlyArray<{ value: ScheduleFrequency; label: string }> = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays (Mon–Fri)' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'interval', label: 'Interval' },
  { value: 'advanced', label: 'Advanced (cron)' },
];

/**
 * Mon–Sun display order (a compact two-column layout reads naturally starting on Monday) over
 * cron's own Sunday-first numbering — `value` is the cron day-of-week number
 * that ships in the generated schedule, `label`/`short` are display-only.
 */
export const WEEKDAY_BUILDER_OPTIONS: ReadonlyArray<{ value: number; label: string; short: string }> = [
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
  { value: 0, label: 'Sunday', short: 'Sun' },
];

// ─── validation ─────────────────────────────────────────────────────────────

/**
 * Inline field errors for the builder itself — same `field → message` shape
 * as `blueprintFieldErrors` in `clerk-scheduled-panel.tsx`, so the section
 * component can render both through one code path. Today this only ever
 * populates `weekdays` (the one family, `'weekly'`, with a selection that can
 * be empty); every other family's inputs (time, day-of-month, interval count)
 * have their own native constraints (`required`, `min`) that keep them from
 * reaching this function in an invalid state.
 */
export function scheduleBuilderErrors(state: ScheduleBuilderState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (state.frequency === 'weekly' && state.weekdays.length === 0) {
    errors.weekdays = 'Pick at least one day.';
  }
  return errors;
}

export function isScheduleBuilderStateValid(state: ScheduleBuilderState): boolean {
  return Object.keys(scheduleBuilderErrors(state)).length === 0;
}

// ─── build (state → cron) ───────────────────────────────────────────────────

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/** `"HH:MM"` → `{ hour, minute }`, falling back to the same 09:00 default an empty/incomplete time input would leave uncommitted. */
function parseTimeField(time: string): { hour: number; minute: number } {
  const match = /^([0-9]{1,2}):([0-9]{2})$/.exec(time.trim());
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute) && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }
  return { hour: 9, minute: 0 };
}

function clampDayOfMonth(day: number): number {
  if (!Number.isInteger(day) || day < 1) return 1;
  return Math.min(day, MAX_BUILDER_DAY_OF_MONTH);
}

function positiveIntervalStep(value: number): number {
  if (!Number.isInteger(value) || value < 1) return 1;
  return value;
}

/**
 * `ScheduleBuilderState` → the 5-field cron string. Total: every branch
 * returns a syntactically valid cron string (or, for `'advanced'`, whatever
 * raw text the user has typed — validated the same way the old raw-cron
 * field always was, at the route). `'weekly'` with an empty `weekdays` still
 * returns a string (day-of-week `*`, i.e. "every day") rather than throwing —
 * the section component's own `scheduleBuilderErrors`/Save-disabled guard is
 * what keeps that combination from ever reaching a submit, not this function.
 */
export function buildCron(state: ScheduleBuilderState): string {
  switch (state.frequency) {
    case 'daily': {
      const { hour, minute } = parseTimeField(state.time);
      return `${minute} ${hour} * * *`;
    }
    case 'weekdays': {
      const { hour, minute } = parseTimeField(state.time);
      return `${minute} ${hour} * * 1-5`;
    }
    case 'weekly': {
      const { hour, minute } = parseTimeField(state.time);
      const days = [...new Set(state.weekdays)].sort((a, b) => a - b);
      const dayField = days.length > 0 ? days.join(',') : '*';
      return `${minute} ${hour} * * ${dayField}`;
    }
    case 'monthly': {
      const { hour, minute } = parseTimeField(state.time);
      return `${minute} ${hour} ${clampDayOfMonth(state.dayOfMonth)} * *`;
    }
    case 'interval': {
      const n = positiveIntervalStep(state.intervalValue);
      return state.intervalUnit === 'hours' ? `0 */${n} * * *` : `*/${n} * * * *`;
    }
    case 'advanced':
    default:
      return state.advancedCron;
  }
}

// ─── reverse mapping (cron → state) ─────────────────────────────────────────

function parsePlainInt(token: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(token)) return null;
  const n = Number(token);
  return n >= min && n <= max ? n : null;
}

/** A comma-separated list of cron day-of-week tokens (`0`–`7`, 0 and 7 both Sunday), or `null` if any token isn't a bare digit in that range. */
function parseWeekdayList(token: string): number[] | null {
  const days = new Set<number>();
  for (const part of token.split(',')) {
    if (!/^[0-7]$/.test(part)) return null;
    days.add(Number(part) % 7);
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

/** The cron step token `*` `/N` → `N` (N >= 1), or `null` — a step of `*` `/0` matches the shape but is not a real cron step, same guard `describeCronSchedule` applies. */
function parseIntervalStep(token: string): number | null {
  const match = /^\*\/(\d+)$/.exec(token);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function formatTime(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

/**
 * The reverse of `buildCron`. Recognizes exactly the five builder families;
 * anything else falls back to `{ frequency: 'advanced', advancedCron: raw }`
 * with every other field left at its ordinary default (so switching AWAY
 * from advanced afterwards starts from a sane, non-empty sub-state instead of
 * carrying over nothing).
 */
export function cronToBuilderState(cron: string): ScheduleBuilderState {
  const raw = cron.trim();
  const fallback: ScheduleBuilderState = { ...defaultScheduleBuilderState(), frequency: 'advanced', advancedCron: raw };

  const fields = raw.split(/\s+/);
  if (fields.length !== 5) return fallback;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];

  const minuteNum = parsePlainInt(minute, 0, 59);
  const hourNum = parsePlainInt(hour, 0, 23);
  const isWildcardDom = dayOfMonth === '*';
  const isWildcardMonth = month === '*';
  const isWildcardDow = dayOfWeek === '*';

  if (minuteNum !== null && hourNum !== null && isWildcardDom && isWildcardMonth && isWildcardDow) {
    return { ...fallback, frequency: 'daily', time: formatTime(hourNum, minuteNum) };
  }

  if (minuteNum !== null && hourNum !== null && isWildcardDom && isWildcardMonth && dayOfWeek === '1-5') {
    return { ...fallback, frequency: 'weekdays', time: formatTime(hourNum, minuteNum) };
  }

  if (minuteNum !== null && hourNum !== null && isWildcardDom && isWildcardMonth) {
    const days = parseWeekdayList(dayOfWeek);
    if (days !== null) {
      return { ...fallback, frequency: 'weekly', time: formatTime(hourNum, minuteNum), weekdays: days };
    }
  }

  if (minuteNum !== null && hourNum !== null && isWildcardMonth && isWildcardDow) {
    const day = parsePlainInt(dayOfMonth, 1, MAX_BUILDER_DAY_OF_MONTH);
    if (day !== null) {
      return { ...fallback, frequency: 'monthly', time: formatTime(hourNum, minuteNum), dayOfMonth: day };
    }
  }

  if (isWildcardDom && isWildcardMonth && isWildcardDow && hour === '*') {
    const n = parseIntervalStep(minute);
    if (n !== null) {
      return { ...fallback, frequency: 'interval', intervalValue: n, intervalUnit: 'minutes' };
    }
  }

  if (isWildcardDom && isWildcardMonth && isWildcardDow && minute === '0') {
    const n = parseIntervalStep(hour);
    if (n !== null) {
      return { ...fallback, frequency: 'interval', intervalValue: n, intervalUnit: 'hours' };
    }
  }

  return fallback;
}
