/**
 * @file `schedule-builder.ts` — the friendly schedule builder's pure logic
 * (#793). Node-only, no rendering: everything
 * here is a plain function over plain data.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_BUILDER_DAY_OF_MONTH,
  buildCron,
  cronToBuilderState,
  defaultScheduleBuilderState,
  isScheduleBuilderStateValid,
  scheduleBuilderErrors,
  type ScheduleBuilderState,
} from '../schedule-builder';

function state(over: Partial<ScheduleBuilderState> = {}): ScheduleBuilderState {
  return { ...defaultScheduleBuilderState(), ...over };
}

describe('buildCron', () => {
  it('builds Daily as a fixed time every day', () => {
    expect(buildCron(state({ frequency: 'daily', time: '09:05' }))).toBe('5 9 * * *');
  });

  it('builds Weekdays (Mon–Fri) as the literal 1-5 range, not an enumerated list', () => {
    expect(buildCron(state({ frequency: 'weekdays', time: '08:00' }))).toBe('0 8 * * 1-5');
  });

  it('builds Weekly for a single weekday', () => {
    expect(buildCron(state({ frequency: 'weekly', time: '14:30', weekdays: [3] }))).toBe('30 14 * * 3');
  });

  it('builds Weekly for Sunday as cron day-of-week 0, not 7', () => {
    // This builder must emit 0 for Sunday.
    expect(buildCron(state({ frequency: 'weekly', time: '09:00', weekdays: [0] }))).toBe('0 9 * * 0');
  });

  it('builds Weekly for multiple weekdays as an ascending, deduplicated comma list', () => {
    // Selection order (Friday clicked before Monday) must not leak into the
    // generated cron — the field is always canonicalized ascending.
    expect(buildCron(state({ frequency: 'weekly', time: '09:00', weekdays: [5, 1] }))).toBe('0 9 * * 1,5');
    expect(buildCron(state({ frequency: 'weekly', time: '09:00', weekdays: [1, 1, 5] }))).toBe('0 9 * * 1,5');
  });

  it('builds Monthly for a day within 1-28', () => {
    expect(buildCron(state({ frequency: 'monthly', time: '00:00', dayOfMonth: 1 }))).toBe('0 0 1 * *');
    expect(buildCron(state({ frequency: 'monthly', time: '00:00', dayOfMonth: 28 }))).toBe('0 0 28 * *');
  });

  it('clamps a Monthly day above the 28 ceiling rather than emitting 29-31', () => {
    // Defensive only — the day-of-month <select> never offers 29-31 in the
    // first place (`MAX_BUILDER_DAY_OF_MONTH`), so no month is ever skipped.
    expect(buildCron(state({ frequency: 'monthly', time: '00:00', dayOfMonth: 31 }))).toBe(
      `0 0 ${MAX_BUILDER_DAY_OF_MONTH} * *`,
    );
  });

  it('builds Interval in minutes', () => {
    expect(buildCron(state({ frequency: 'interval', intervalValue: 15, intervalUnit: 'minutes' }))).toBe(
      '*/15 * * * *',
    );
  });

  it('builds Interval in hours at minute 0', () => {
    expect(buildCron(state({ frequency: 'interval', intervalValue: 6, intervalUnit: 'hours' }))).toBe(
      '0 */6 * * *',
    );
  });

  it('clamps a non-positive interval value to 1 rather than emitting */0 or a negative step', () => {
    expect(buildCron(state({ frequency: 'interval', intervalValue: 0, intervalUnit: 'minutes' }))).toBe(
      '*/1 * * * *',
    );
    expect(buildCron(state({ frequency: 'interval', intervalValue: -3, intervalUnit: 'hours' }))).toBe(
      '0 */1 * * *',
    );
  });

  it('builds Advanced as the raw text, verbatim', () => {
    expect(buildCron(state({ frequency: 'advanced', advancedCron: '0 9 1 1 *' }))).toBe('0 9 1 1 *');
  });
});

describe('cronToBuilderState — round trip', () => {
  // A representative grid across every family, including the two explicit
  // call-outs (Sunday, and a multi-weekday selection). For each, building the
  // cron and reparsing it must reproduce the SAME family and field values —
  // this is the property the whole reverse-mapping design rests on.
  const grid: ScheduleBuilderState[] = [
    state({ frequency: 'daily', time: '00:00' }),
    state({ frequency: 'daily', time: '23:59' }),
    state({ frequency: 'weekdays', time: '08:00' }),
    state({ frequency: 'weekly', time: '09:00', weekdays: [1] }),
    state({ frequency: 'weekly', time: '09:00', weekdays: [0] }), // Sunday
    state({ frequency: 'weekly', time: '14:30', weekdays: [1, 3, 5] }), // multi-weekday
    state({ frequency: 'weekly', time: '06:15', weekdays: [0, 6] }), // Sunday + Saturday
    state({ frequency: 'monthly', time: '00:00', dayOfMonth: 1 }),
    state({ frequency: 'monthly', time: '12:00', dayOfMonth: 28 }),
    state({ frequency: 'interval', intervalValue: 1, intervalUnit: 'minutes' }),
    state({ frequency: 'interval', intervalValue: 15, intervalUnit: 'minutes' }),
    state({ frequency: 'interval', intervalValue: 6, intervalUnit: 'hours' }),
    state({ frequency: 'advanced', advancedCron: '0 9 1 1 *' }),
  ];

  it.each(grid.map((builderState) => [describeState(builderState), builderState] as const))(
    'reproduces %s after building and reparsing',
    (_label, builderState) => {
      const cron = buildCron(builderState);
      const roundTripped = cronToBuilderState(cron);
      expect(roundTripped.frequency).toBe(builderState.frequency);

      switch (builderState.frequency) {
        case 'daily':
        case 'weekdays':
          expect(roundTripped.time).toBe(builderState.time);
          break;
        case 'weekly':
          expect(roundTripped.time).toBe(builderState.time);
          expect([...roundTripped.weekdays].sort()).toEqual([...builderState.weekdays].sort());
          break;
        case 'monthly':
          expect(roundTripped.time).toBe(builderState.time);
          expect(roundTripped.dayOfMonth).toBe(builderState.dayOfMonth);
          break;
        case 'interval':
          expect(roundTripped.intervalValue).toBe(builderState.intervalValue);
          expect(roundTripped.intervalUnit).toBe(builderState.intervalUnit);
          break;
        case 'advanced':
          expect(roundTripped.advancedCron).toBe(builderState.advancedCron);
          break;
      }
    },
  );

  function describeState(builderState: ScheduleBuilderState): string {
    return `${builderState.frequency}(${JSON.stringify(builderState)})`;
  }
});

describe('cronToBuilderState — foreign-cron fallback to Advanced', () => {
  it('falls back for a constrained-month cron outside the five families', () => {
    const result = cronToBuilderState('0 9 1 1 *');
    expect(result.frequency).toBe('advanced');
    expect(result.advancedCron).toBe('0 9 1 1 *');
  });

  it('falls back for a 6-field cron', () => {
    const result = cronToBuilderState('* * * * * *');
    expect(result.frequency).toBe('advanced');
    expect(result.advancedCron).toBe('* * * * * *');
  });

  it('falls back for garbage input, preserving it verbatim', () => {
    const result = cronToBuilderState('not a cron at all');
    expect(result.frequency).toBe('advanced');
    expect(result.advancedCron).toBe('not a cron at all');
  });

  it('falls back for a weekday name abbreviation (this builder only ever emits numeric day-of-week)', () => {
    const result = cronToBuilderState('0 9 * * MON');
    expect(result.frequency).toBe('advanced');
    expect(result.advancedCron).toBe('0 9 * * MON');
  });

  it('falls back for a step of 0, rather than reporting Interval with an invalid step', () => {
    const result = cronToBuilderState('*/0 * * * *');
    expect(result.frequency).toBe('advanced');
  });

  it('recognizes an hourly interval only when the minute field is exactly 0', () => {
    // `describeCronSchedule` renders "30 */2 * * *" as prose ("Every 2 hours
    // at minute 30"), but this builder's Interval family has no minute
    // offset control, so a non-zero minute alongside an hourly step cannot
    // round-trip through it and must fall back to Advanced.
    const result = cronToBuilderState('30 */2 * * *');
    expect(result.frequency).toBe('advanced');
    expect(result.advancedCron).toBe('30 */2 * * *');
  });

  it('still opens populated for a foreign cron using 7 for Sunday, normalizing it to 0', () => {
    // More permissive than `buildCron`'s own output (which never emits 7) —
    // an existing blueprint saved before this builder existed should still
    // open populated rather than dropping to Advanced over a spelling of
    // Sunday this module doesn't happen to produce itself.
    const result = cronToBuilderState('0 9 * * 7');
    expect(result.frequency).toBe('weekly');
    expect(result.weekdays).toEqual([0]);
  });
});

describe('scheduleBuilderErrors / isScheduleBuilderStateValid — at-least-one-weekday validation', () => {
  it('requires at least one weekday for Weekly', () => {
    const empty = state({ frequency: 'weekly', weekdays: [] });
    expect(scheduleBuilderErrors(empty)).toEqual({ weekdays: 'Pick at least one day.' });
    expect(isScheduleBuilderStateValid(empty)).toBe(false);
  });

  it('is valid once at least one weekday is picked', () => {
    const oneDay = state({ frequency: 'weekly', weekdays: [2] });
    expect(scheduleBuilderErrors(oneDay)).toEqual({});
    expect(isScheduleBuilderStateValid(oneDay)).toBe(true);
  });

  it('never raises the weekdays error for a family other than Weekly, even with an empty array', () => {
    const daily = state({ frequency: 'daily', weekdays: [] });
    expect(scheduleBuilderErrors(daily)).toEqual({});
    expect(isScheduleBuilderStateValid(daily)).toBe(true);
  });
});
