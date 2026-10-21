import { describe, expect, it } from 'vitest';
import {
  createTaskBlueprintSchema,
  isSupportedTimeZone,
  updateTaskBlueprintSchema,
  TASK_BLUEPRINT_CRON_SCHEDULE_PATTERN,
} from './task-blueprint-validators.js';

const VALID_BODY = {
  name: 'Daily project-health digest',
  prompt_text: 'Summarise open cases needing a decision.',
  cron_schedule: '0 8 * * *',
  timezone: 'Europe/Berlin',
};

describe('createTaskBlueprintSchema', () => {
  it('accepts a valid body and defaults enabled to true', () => {
    const parsed = createTaskBlueprintSchema.parse(VALID_BODY);
    expect(parsed).toEqual({ ...VALID_BODY, enabled: true });
  });

  it('accepts an explicit enabled and an optional description', () => {
    const parsed = createTaskBlueprintSchema.parse({
      ...VALID_BODY,
      description: 'Runs every morning.',
      enabled: false,
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.description).toBe('Runs every morning.');
  });

  it('rejects an unknown key (e.g. a smuggled owner_user_id or version) — the .strict() identity rule', () => {
    expect(() =>
      createTaskBlueprintSchema.parse({ ...VALID_BODY, owner_user_id: 'usr_forged' }),
    ).toThrow();
    expect(() => createTaskBlueprintSchema.parse({ ...VALID_BODY, version: 99 })).toThrow();
  });

  it('rejects a cron_schedule with the wrong field count', () => {
    expect(() =>
      createTaskBlueprintSchema.parse({ ...VALID_BODY, cron_schedule: '0 8 * *' }),
    ).toThrow();
    expect(() =>
      createTaskBlueprintSchema.parse({ ...VALID_BODY, cron_schedule: '0 8 * * * *' }),
    ).toThrow();
  });

  it('rejects a cron_schedule with a stray character outside the cron charset', () => {
    expect(() =>
      createTaskBlueprintSchema.parse({ ...VALID_BODY, cron_schedule: '0 8 * * mon;drop' }),
    ).toThrow();
  });

  it('accepts the usual cron shorthand shapes syntactically, deferring range/step semantics to B2', () => {
    // These pass the SYNTACTIC check even though `99` and `32` are not
    // semantically valid — the comment on `TASK_BLUEPRINT_CRON_SCHEDULE_PATTERN`
    // documents this is deliberate; `croner` (slice B2) is what will actually
    // reject them.
    expect(TASK_BLUEPRINT_CRON_SCHEDULE_PATTERN.test('*/10 * * * *')).toBe(true);
    expect(TASK_BLUEPRINT_CRON_SCHEDULE_PATTERN.test('0 99 32 * *')).toBe(true);
  });

  it('rejects an unrecognized timezone name', () => {
    expect(() =>
      createTaskBlueprintSchema.parse({ ...VALID_BODY, timezone: 'Not/AZone' }),
    ).toThrow();
  });

  it('accepts a real IANA timezone and UTC', () => {
    expect(createTaskBlueprintSchema.parse({ ...VALID_BODY, timezone: 'UTC' }).timezone).toBe('UTC');
    expect(
      createTaskBlueprintSchema.parse({ ...VALID_BODY, timezone: 'America/New_York' }).timezone,
    ).toBe('America/New_York');
  });

  it('rejects an empty prompt_text or name', () => {
    expect(() => createTaskBlueprintSchema.parse({ ...VALID_BODY, prompt_text: '   ' })).toThrow();
    expect(() => createTaskBlueprintSchema.parse({ ...VALID_BODY, name: '' })).toThrow();
  });
});

describe('updateTaskBlueprintSchema', () => {
  it('accepts a single-field partial update', () => {
    expect(updateTaskBlueprintSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(updateTaskBlueprintSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });

  it('rejects an empty body — nothing for a version bump to be attributed to', () => {
    expect(() => updateTaskBlueprintSchema.parse({})).toThrow();
  });

  it('rejects an unknown key', () => {
    expect(() => updateTaskBlueprintSchema.parse({ version: 5 })).toThrow();
  });

  it('re-validates cron_schedule and timezone on a partial update', () => {
    expect(() => updateTaskBlueprintSchema.parse({ cron_schedule: 'not a cron' })).toThrow();
    expect(() => updateTaskBlueprintSchema.parse({ timezone: 'Nowhere/Land' })).toThrow();
  });
});

describe('isSupportedTimeZone', () => {
  it('recognizes UTC and a common IANA zone, and rejects garbage', () => {
    expect(isSupportedTimeZone('UTC')).toBe(true);
    expect(isSupportedTimeZone('Europe/Berlin')).toBe(true);
    expect(isSupportedTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});
