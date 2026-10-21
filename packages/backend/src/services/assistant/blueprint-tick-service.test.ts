import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Case, TaskBlueprint } from '@arbitra/shared';
import type { AssistantIntakeResult } from './assistant-intake-service.js';

/**
 * `BlueprintTickService` (`docs/specs/clerk-config-scheduling-chat.md` Slice
 * B, #793 v2). Same two-fake-Firestore-double shape as
 * `task-blueprint-service.test.ts` (`task_blueprints` flat map, filterable
 * `cases` list for the overlap query `createBlueprintOccurrence` re-runs).
 * `AssistantIntakeService` is injected as a plain mock throughout — its own
 * transactional/idempotency guarantees are covered elsewhere
 * (`assistant-intake-service.test.ts`); this file covers only what the tick
 * service adds: window derivation, croner-driven due-time computation, and
 * per-blueprint error isolation.
 */

type DocData = Record<string, unknown>;

const blueprintStore = new Map<string, DocData>();
const caseStore = new Map<string, DocData>();

function persistable<T>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}

function fieldValue(doc: DocData, field: string): unknown {
  return field.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as DocData)[part];
  }, doc);
}

class FakeBlueprintCollection {
  where(field: string, op: '==', value: unknown) {
    if (op !== '==') throw new Error(`Unsupported fake op: ${op}`);
    return {
      async get() {
        const docs = [...blueprintStore.values()]
          .filter((doc) => doc[field] === value)
          .map((doc) => ({ data: () => ({ ...doc }) }));
        return { docs };
      },
    };
  }
}

interface CaseFilter {
  field: string;
  op: '==' | 'not-in';
  value: unknown;
}

class FakeCaseQuery {
  constructor(
    private readonly filters: CaseFilter[] = [],
    private readonly maxResults?: number,
  ) {}

  where(field: string, op: CaseFilter['op'], value: unknown): FakeCaseQuery {
    return new FakeCaseQuery([...this.filters, { field, op, value }], this.maxResults);
  }

  limit(maxResults: number): FakeCaseQuery {
    return new FakeCaseQuery(this.filters, maxResults);
  }

  async get() {
    const matched = [...caseStore.values()].filter((doc) =>
      this.filters.every(({ field, op, value }) => {
        const actual = fieldValue(doc, field) ?? null;
        if (op === '==') return actual === (value ?? null);
        // 'not-in' also excludes documents missing the field, mirroring real Firestore.
        return doc[field] !== undefined && !(value as unknown[]).includes(actual);
      }),
    );
    const docs = this.maxResults === undefined ? matched : matched.slice(0, this.maxResults);
    return { docs: docs.map((d) => ({ data: () => ({ ...d }) })) };
  }
}

const collections = {
  taskBlueprints: () => new FakeBlueprintCollection(),
  activeCases: () => new FakeCaseQuery().where('deleted_at', '==', null),
};

vi.mock('../../lib/firestore.js', () => ({ collections }));

const { BlueprintTickService, computeDueFireTimes } = await import('./blueprint-tick-service.js');

const OWNER = 'usr_owner';

function seedBlueprint(overrides: Partial<TaskBlueprint> & { blueprint_id: string }): void {
  const base: TaskBlueprint = {
    blueprint_id: overrides.blueprint_id,
    owner_user_id: OWNER,
    project_id: 'proj_owner',
    name: 'Digest',
    prompt_text: 'Summarise open cases.',
    // Fires exactly once a day (09:00 UTC) — deliberately NOT a `*/N`
    // pattern: with the safety-margin-widened lookback (window + margin =
    // 15 minutes), a `*/5` pattern would produce 3 fire times in most of
    // these tests' windows instead of 1, which is a fact about the margin,
    // not about what each test is actually checking. Tests that need
    // multiple, or specifically-placed, fire times override this.
    cron_schedule: '0 9 * * *',
    timezone: 'UTC',
    enabled: true,
    archived_at: null,
    version: 1,
    overlap_policy: 'skip',
    missed_run_policy: 'skip',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  blueprintStore.set(overrides.blueprint_id, persistable({ ...base, ...overrides }));
}

function seedCase(overrides: Partial<Case> & { case_id: string }): void {
  const base = {
    case_id: overrides.case_id,
    status: 'open',
    deleted_at: null,
    case_type: 'assistant_task',
  };
  caseStore.set(overrides.case_id, persistable({ ...base, ...overrides }));
}

function makeIntakeResult(overrides: Partial<AssistantIntakeResult> = {}): AssistantIntakeResult {
  return {
    case: { case_id: 'case_from_intake', status: 'open' } as unknown as Case,
    run: { run_id: 'run_from_intake' } as unknown as AssistantIntakeResult['run'],
    run_id: 'run_from_intake',
    event_id: 'evt_from_intake',
    replayed: false,
    ...overrides,
  };
}

beforeEach(() => {
  blueprintStore.clear();
  caseStore.clear();
});

describe('computeDueFireTimes — DST ground truth (Europe/Berlin)', () => {
  /**
   * Reverting `mode: '5-part'` to a naive fixed-UTC-offset calculation (or
   * dropping the `timezone` argument entirely) would keep the UTC-hour gap
   * between the two fires constant across the transition; DST-correctness
   * means it does NOT stay constant.
   */
  it('jumps past the nonexistent 02:00 local hour on the spring-forward day and shifts the UTC instant by one hour', () => {
    // 2026-03-29: Europe/Berlin springs forward from CET (UTC+1) to CEST
    // (UTC+2) at 02:00 local — local 02:00-03:00 does not exist that day.
    // A daily "0 2 * * *" (02:00 local) blueprint:
    //   2026-03-28 (still CET):    02:00 local == 2026-03-28T01:00:00.000Z
    //   2026-03-29 (the gap day):  jumps to the next existing local time
    //                              matching the pattern, 03:00 CEST ==
    //                              2026-03-29T01:00:00.000Z — the SAME UTC
    //                              hour as the day before, even though a
    //                              full local day plus the 1-hour DST jump
    //                              elapsed.
    const fireTimes = computeDueFireTimes(
      '0 2 * * *',
      'Europe/Berlin',
      new Date('2026-03-27T23:00:00.000Z'),
      new Date('2026-03-29T02:00:00.000Z'),
    );
    expect(fireTimes.map((d) => d.toISOString())).toEqual([
      '2026-03-28T01:00:00.000Z',
      '2026-03-29T01:00:00.000Z',
    ]);
  });

  it('resolves the doubled local hour on the fall-back day to its first (CEST) occurrence', () => {
    // 2026-10-25: clocks fall back from CEST to CET at 03:00 CEST local, so
    // local 02:00-03:00 occurs TWICE that day. A daily "30 2 * * *"
    // blueprint fires at the FIRST occurrence (still CEST, UTC+2), not the
    // second (CET, UTC+1) — ground truth from croner's DST tie-break.
    const fireTimes = computeDueFireTimes(
      '30 2 * * *',
      'Europe/Berlin',
      new Date('2026-10-23T22:00:00.000Z'),
      new Date('2026-10-25T00:31:00.000Z'),
    );
    expect(fireTimes.map((d) => d.toISOString())).toEqual([
      '2026-10-24T00:30:00.000Z',
      '2026-10-25T00:30:00.000Z',
    ]);
  });
});

describe('BlueprintTickService.tick', () => {
  const FROZEN_NOW = '2026-08-06T09:00:00.000Z'; // exact 5-minute boundary

  /** Reverting `occurrenceIso = fireTime.toISOString()` to `now.toISOString()` would break this: the two ticks' `now` differ but their aligned fire time does not. */
  it('a duplicated tick over an overlapping window computes the SAME idempotency key and the second call replays instead of creating a second case', async () => {
    seedBlueprint({ blueprint_id: 'bp_digest' });
    const intake = vi
      .fn()
      .mockResolvedValueOnce(makeIntakeResult({ replayed: false }))
      .mockResolvedValueOnce(makeIntakeResult({ replayed: true, run: null }));
    const service = new BlueprintTickService({ intakeService: { intake } });

    const first = await service.tick(new Date(FROZEN_NOW));
    const second = await service.tick(new Date(FROZEN_NOW));

    expect(intake).toHaveBeenCalledTimes(2);
    const [firstArgs, secondArgs] = intake.mock.calls;
    expect(firstArgs[0].idempotency_key).toBe(secondArgs[0].idempotency_key);
    expect(firstArgs[0].idempotency_key).toBe('blueprint:bp_digest:1:2026-08-06T09:00:00.000Z');
    expect(first).toMatchObject({ due: 1, created: 1, replayed: 0 });
    expect(second).toMatchObject({ due: 1, created: 0, replayed: 1 });
  });

  /**
   * Reverting `BLUEPRINT_TICK_SAFETY_MARGIN_MS` to `0` (i.e. lookback ==
   * `BLUEPRINT_TICK_WINDOW_MS` exactly, the pre-fix-up behavior) makes this
   * fail: a tick 7 minutes after the last on-time tick — 2 minutes beyond
   * the nominal 5-minute cadence — computes an un-margined window of
   * `(now-5min, now]`, which starts AFTER the 09:01 fire and silently drops
   * it: not fired, not counted in `due`, not in `errors[]`.
   */
  it('a tick delayed beyond the nominal cadence still fires everything since the last covered window — no silent gap', async () => {
    seedBlueprint({ blueprint_id: 'bp_digest', cron_schedule: '1 9 * * *' }); // fires once, at 09:01 UTC
    const intake = vi.fn().mockResolvedValue(makeIntakeResult());
    const service = new BlueprintTickService({ intakeService: { intake } });

    // The previous (on-time) tick would have run at 09:00 and covered
    // (08:55, 09:00] — after that, the 09:01 fire is due. This tick is
    // delayed and arrives at 09:07 (7 minutes later, 2 minutes beyond the
    // nominal 5-minute cadence). An un-margined window would be
    // (09:02, 09:07] — AFTER 09:01, so the fire would fall in the
    // uncovered gap (09:00, 09:02]. The margin-widened window,
    // (08:52, 09:07], still contains it.
    const summary = await service.tick(new Date('2026-08-06T09:07:00.000Z'));

    expect(summary).toMatchObject({ due: 1, created: 1, errors: [] });
    expect(intake).toHaveBeenCalledTimes(1);
    const idempotencyKey = intake.mock.calls[0]![0].idempotency_key as string;
    expect(idempotencyKey).toBe('blueprint:bp_digest:1:2026-08-06T09:01:00.000Z');
  });

  /**
   * Extends the duplicated-tick test above to two DIFFERENT `now` values
   * whose margin-widened windows merely overlap (rather than being
   * identical) — proving overlap-safety isn't limited to the exact-same-`now`
   * case the margin fix-up otherwise makes routine. If the shared
   * idempotency key ever stopped matching between the two calls (e.g.
   * `occurrence_iso` drifted to something call-specific instead of the
   * fire time), this test's failure mode is a SECOND case for the same
   * 09:01 fire on call 2, which `expect(second).toMatchObject({ created: 0,
   * replayed: 1 })` catches directly.
   */
  it('two ticks with different but overlapping margin-widened windows replay the same fire time instead of duplicating it', async () => {
    seedBlueprint({ blueprint_id: 'bp_digest', cron_schedule: '1 9 * * *' }); // fires once, at 09:01 UTC
    const intake = vi
      .fn()
      .mockResolvedValueOnce(makeIntakeResult({ replayed: false }))
      .mockResolvedValueOnce(makeIntakeResult({ replayed: true, run: null }));
    const service = new BlueprintTickService({ intakeService: { intake } });

    // Call 1 window: (08:47, 09:02] — contains 09:01.
    const first = await service.tick(new Date('2026-08-06T09:02:00.000Z'));
    // Call 2, 4 minutes later. Window: (08:51, 09:06] — DIFFERENT window,
    // but still contains the SAME 09:01 fire.
    const second = await service.tick(new Date('2026-08-06T09:06:00.000Z'));

    expect(intake).toHaveBeenCalledTimes(2);
    const [firstArgs, secondArgs] = intake.mock.calls;
    expect(firstArgs[0].idempotency_key).toBe(secondArgs[0].idempotency_key);
    expect(firstArgs[0].idempotency_key).toBe('blueprint:bp_digest:1:2026-08-06T09:01:00.000Z');
    expect(first).toMatchObject({ due: 1, created: 1, replayed: 0 });
    expect(second).toMatchObject({ due: 1, created: 0, replayed: 1 });
  });

  /** Reverting the window to `[now, now + WINDOW)` (i.e. arrival-anchored instead of trailing) would miss this fire entirely. */
  it('a delayed tick still fires at the aligned fire time inside its trailing window, not the tick arrival time', async () => {
    seedBlueprint({ blueprint_id: 'bp_digest' });
    const intake = vi.fn().mockResolvedValue(makeIntakeResult());
    const service = new BlueprintTickService({ intakeService: { intake } });

    // Tick "arrives" at 09:02 — two minutes after the aligned 09:00 fire,
    // but still inside the margin-widened trailing window (08:47, 09:02].
    const summary = await service.tick(new Date('2026-08-06T09:02:00.000Z'));

    expect(summary).toMatchObject({ due: 1, created: 1 });
    expect(intake).toHaveBeenCalledTimes(1);
    const idempotencyKey = intake.mock.calls[0]![0].idempotency_key as string;
    expect(idempotencyKey).toBe('blueprint:bp_digest:1:2026-08-06T09:00:00.000Z');
  });

  it('overlap policy skip: a non-terminal case for the blueprint blocks the occurrence, no intake attempted', async () => {
    seedBlueprint({ blueprint_id: 'bp_digest' });
    seedCase({
      case_id: 'case_in_flight',
      status: 'in_build',
      assistant_context: { blueprint_id: 'bp_digest' },
    } as unknown as Partial<Case> & { case_id: string });
    const intake = vi.fn();
    const service = new BlueprintTickService({ intakeService: { intake } });

    const summary = await service.tick(new Date(FROZEN_NOW));

    expect(summary).toMatchObject({ due: 1, created: 0, skipped_overlap: 1, replayed: 0 });
    expect(intake).not.toHaveBeenCalled();
  });

  it('an occurrence-creation failure for one blueprint does not stop another blueprint from ticking in the same pass', async () => {
    seedBlueprint({ blueprint_id: 'bp_broken' });
    seedBlueprint({ blueprint_id: 'bp_ok' });
    const intake = vi.fn().mockImplementation(async (request: { blueprint?: { blueprint_id: string } }) => {
      if (request.blueprint?.blueprint_id === 'bp_broken') {
        throw new Error('quota exceeded');
      }
      return makeIntakeResult();
    });
    const service = new BlueprintTickService({ intakeService: { intake } });

    const summary = await service.tick(new Date(FROZEN_NOW));

    expect(summary.due).toBe(2);
    expect(summary.created).toBe(1);
    expect(summary.errors).toEqual([
      { blueprint_id: 'bp_broken', occurrence_iso: FROZEN_NOW, message: 'quota exceeded' },
    ]);
    expect(intake).toHaveBeenCalledTimes(2);
  });

  it('a cron/timezone evaluation failure for one blueprint does not stop another blueprint from ticking', async () => {
    // A timezone that no longer resolves — never produced by the write-time
    // validator (`isSupportedTimeZone`), but exercised here as the shape of
    // stale/corrupted data the tick service must still isolate.
    seedBlueprint({ blueprint_id: 'bp_bad_tz', timezone: 'Not/AZone' });
    seedBlueprint({ blueprint_id: 'bp_ok' });
    const intake = vi.fn().mockResolvedValue(makeIntakeResult());
    const service = new BlueprintTickService({ intakeService: { intake } });

    const summary = await service.tick(new Date(FROZEN_NOW));

    expect(summary.due).toBe(1); // only bp_ok's fire time is ever counted
    expect(summary.created).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ blueprint_id: 'bp_bad_tz' });
    expect(summary.errors[0]!.occurrence_iso).toBeUndefined();
    expect(intake).toHaveBeenCalledTimes(1);
  });

  it('disabled and archived blueprints never fire — including a stale doc where enabled was left true after archiving', async () => {
    seedBlueprint({ blueprint_id: 'bp_disabled', enabled: false });
    seedBlueprint({ blueprint_id: 'bp_archived_but_enabled', enabled: true, archived_at: '2026-08-01T00:00:00.000Z' });
    const intake = vi.fn();
    const service = new BlueprintTickService({ intakeService: { intake } });

    const summary = await service.tick(new Date(FROZEN_NOW));

    expect(summary).toMatchObject({ due: 0, created: 0, skipped_overlap: 0, replayed: 0, errors: [] });
    expect(intake).not.toHaveBeenCalled();
  });
});
