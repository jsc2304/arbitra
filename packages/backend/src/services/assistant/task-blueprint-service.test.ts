import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Case } from '@arbitra/shared';
import type { AssistantIntakeResult } from './assistant-intake-service.js';

/**
 * `TaskBlueprintService` (`docs/specs/clerk-config-scheduling-chat.md` Slice
 * B, #793 v1). Two tiny Firestore doubles: one flat map for `task_blueprints`
 * (CRUD, no transaction needed — every write here is a single doc), and a
 * filterable list for `cases` that models exactly the shape `runNow`'s
 * overlap query uses (`deleted_at`, `assistant_context.blueprint_id`,
 * `status not-in`). `AssistantIntakeService` itself is never exercised here —
 * it is injected as a plain mock — its own transactional/idempotency
 * guarantees are covered by `assistant-intake-service.test.ts`; this file
 * covers only what `TaskBlueprintService` adds on top of it.
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

class FakeBlueprintDocRef {
  constructor(readonly id: string) {}

  async get() {
    const data = blueprintStore.get(this.id);
    return { exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
  }

  async set(data: DocData): Promise<void> {
    blueprintStore.set(this.id, persistable(data));
  }

  async update(patch: DocData): Promise<void> {
    const current = blueprintStore.get(this.id) ?? {};
    blueprintStore.set(this.id, persistable({ ...current, ...patch }));
  }
}

class FakeBlueprintCollection {
  doc(id: string): FakeBlueprintDocRef {
    return new FakeBlueprintDocRef(id);
  }

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

const {
  TaskBlueprintService,
  TaskBlueprintArchivedError,
  TaskBlueprintOverlapError,
  buildBlueprintOccurrenceIdempotencyKey,
  findNonTerminalBlueprintCaseId,
} = await import('./task-blueprint-service.js');
const { clerkCoreIds } = await import('./clerk-core.js');

const OWNER = 'usr_owner';
const OTHER_USER = 'usr_other';
const FROZEN_NOW = '2026-08-06T09:00:00.000Z';

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

describe('TaskBlueprintService.create', () => {
  it('starts at version 1, defaults enabled to true, and derives project_id from the owner', async () => {
    const service = new TaskBlueprintService({ now: () => new Date(FROZEN_NOW) });

    const blueprint = await service.create(OWNER, {
      name: 'Daily digest',
      prompt_text: 'Summarise open cases.',
      cron_schedule: '0 8 * * *',
      timezone: 'UTC',
    });

    expect(blueprint.version).toBe(1);
    expect(blueprint.enabled).toBe(true);
    expect(blueprint.archived_at).toBeNull();
    expect(blueprint.owner_user_id).toBe(OWNER);
    expect(blueprint.project_id).toBe(clerkCoreIds(OWNER).projectId);
    expect(blueprint.overlap_policy).toBe('skip');
    expect(blueprint.missed_run_policy).toBe('skip');
    expect(blueprint.created_at).toBe(FROZEN_NOW);
  });
});

describe('TaskBlueprintService.get — ownership', () => {
  it('throws NotFoundError for a blueprint that does not exist', async () => {
    const service = new TaskBlueprintService();
    await expect(service.get('bp_missing', OWNER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws a 403 ForbiddenError — not a 404 — for a blueprint owned by someone else', async () => {
    const service = new TaskBlueprintService();
    const blueprint = await service.create(OWNER, {
      name: 'Mine',
      prompt_text: 'x',
      cron_schedule: '0 8 * * *',
      timezone: 'UTC',
    });

    await expect(service.get(blueprint.blueprint_id, OTHER_USER)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });
});

describe('TaskBlueprintService.update — version bump and ownership', () => {
  it('bumps version on any accepted change, including enabled alone', async () => {
    const service = new TaskBlueprintService();
    const created = await service.create(OWNER, {
      name: 'v1 name',
      prompt_text: 'v1 prompt',
      cron_schedule: '0 8 * * *',
      timezone: 'UTC',
    });

    const afterEnabledToggle = await service.update(created.blueprint_id, OWNER, { enabled: false });
    expect(afterEnabledToggle.version).toBe(2);
    expect(afterEnabledToggle.enabled).toBe(false);
    // Untouched fields survive the partial update.
    expect(afterEnabledToggle.name).toBe('v1 name');

    const afterPromptEdit = await service.update(created.blueprint_id, OWNER, {
      prompt_text: 'v3 prompt',
    });
    expect(afterPromptEdit.version).toBe(3);
    expect(afterPromptEdit.prompt_text).toBe('v3 prompt');
  });

  it('refuses to update a blueprint owned by someone else (403)', async () => {
    const service = new TaskBlueprintService();
    const created = await service.create(OWNER, {
      name: 'Mine',
      prompt_text: 'x',
      cron_schedule: '0 8 * * *',
      timezone: 'UTC',
    });

    await expect(
      service.update(created.blueprint_id, OTHER_USER, { name: 'Hijacked' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await service.get(created.blueprint_id, OWNER)).name).toBe('Mine');
  });

  it('refuses to update an archived blueprint', async () => {
    const service = new TaskBlueprintService();
    const created = await service.create(OWNER, {
      name: 'Mine',
      prompt_text: 'x',
      cron_schedule: '0 8 * * *',
      timezone: 'UTC',
    });
    await service.archive(created.blueprint_id, OWNER);

    await expect(
      service.update(created.blueprint_id, OWNER, { name: 'Resurrected' }),
    ).rejects.toBeInstanceOf(TaskBlueprintArchivedError);
  });
});

describe('TaskBlueprintService.archive', () => {
  it('sets archived_at, disables, and is idempotent', async () => {
    const service = new TaskBlueprintService({ now: () => new Date(FROZEN_NOW) });
    const created = await service.create(OWNER, {
      name: 'Mine',
      prompt_text: 'x',
      cron_schedule: '0 8 * * *',
      timezone: 'UTC',
    });

    const archived = await service.archive(created.blueprint_id, OWNER);
    expect(archived.archived_at).toBe(FROZEN_NOW);
    expect(archived.enabled).toBe(false);

    // Second call is a no-op — same result, not an error.
    const archivedAgain = await service.archive(created.blueprint_id, OWNER);
    expect(archivedAgain).toEqual(archived);
  });
});

describe('TaskBlueprintService.list', () => {
  it('only returns the caller\'s own blueprints, newest first', async () => {
    // A distinct, strictly increasing clock per call — two `create` calls in
    // the same test can otherwise land in the same millisecond under a real
    // clock, making `created_at` tie and the "newest first" ordering this
    // test checks unobservable.
    let tick = 0;
    const service = new TaskBlueprintService({
      now: () => new Date(Date.parse(FROZEN_NOW) + (tick += 1000)),
    });
    await service.create(OWNER, { name: 'first', prompt_text: 'x', cron_schedule: '0 8 * * *', timezone: 'UTC' });
    await service.create(OTHER_USER, { name: 'not mine', prompt_text: 'x', cron_schedule: '0 8 * * *', timezone: 'UTC' });
    await service.create(OWNER, { name: 'second', prompt_text: 'x', cron_schedule: '0 8 * * *', timezone: 'UTC' });

    const listed = await service.list(OWNER);

    expect(listed.map((b) => b.name)).toEqual(['second', 'first']);
  });
});

describe('TaskBlueprintService.runNow', () => {
  async function seedBlueprint(intake = vi.fn()) {
    const service = new TaskBlueprintService({
      now: () => new Date(FROZEN_NOW),
      intakeService: { intake },
    });
    const blueprint = await service.create(OWNER, {
      name: 'Digest',
      prompt_text: 'Summarise open cases.',
      cron_schedule: '0 8 * * *',
      timezone: 'UTC',
    });
    return { service, blueprint, intake };
  }

  it('creates exactly one occurrence via AssistantIntakeService.intake, keyed by blueprint/version/occurrence', async () => {
    const intake = vi.fn().mockResolvedValue(makeIntakeResult());
    const { service, blueprint } = await seedBlueprint(intake);

    const result = await service.runNow(blueprint.blueprint_id, OWNER);

    expect(intake).toHaveBeenCalledTimes(1);
    expect(intake).toHaveBeenCalledWith(
      {
        text: 'Summarise open cases.',
        channel: 'blueprint',
        idempotency_key: `blueprint:${blueprint.blueprint_id}:1:${FROZEN_NOW}`,
        blueprint: {
          blueprint_id: blueprint.blueprint_id,
          blueprint_version: 1,
          prompt_text: 'Summarise open cases.',
        },
      },
      OWNER,
    );
    expect(result.case.case_id).toBe('case_from_intake');
    expect(result.replayed).toBe(false);
  });

  it('computes the SAME idempotency key across two calls sharing a frozen clock — the replay surfaces as intake reports it', async () => {
    // `AssistantIntakeService` is mocked here — it is what actually enforces
    // "one key, one case" (proven transactionally in
    // `assistant-intake-service.test.ts`). This test isolates the one thing
    // `runNow` itself is responsible for: computing an IDENTICAL
    // `blueprint:{id}:{version}:{occurrence_iso}` key on both calls when the
    // clock is frozen, and correctly surfacing whatever `replayed` intake
    // reports back. The fake double never writes a case for a mocked intake
    // call, so the overlap-'skip' guard (covered separately below) finds
    // nothing to block on either call.
    const intake = vi
      .fn()
      .mockResolvedValueOnce(makeIntakeResult({ replayed: false }))
      .mockResolvedValueOnce(makeIntakeResult({ replayed: true, run: null }));
    const { service, blueprint } = await seedBlueprint(intake);

    await service.runNow(blueprint.blueprint_id, OWNER);
    const second = await service.runNow(blueprint.blueprint_id, OWNER);

    const [firstCallArgs, secondCallArgs] = intake.mock.calls;
    expect(firstCallArgs[0].idempotency_key).toBe(secondCallArgs[0].idempotency_key);
    expect(second.replayed).toBe(true);
  });

  it('403s for a non-owner and never calls intake', async () => {
    const intake = vi.fn();
    const { service, blueprint } = await seedBlueprint(intake);

    await expect(service.runNow(blueprint.blueprint_id, OTHER_USER)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
    expect(intake).not.toHaveBeenCalled();
  });

  it('409s when the blueprint is archived and never calls intake', async () => {
    const intake = vi.fn();
    const { service, blueprint } = await seedBlueprint(intake);
    await service.archive(blueprint.blueprint_id, OWNER);

    await expect(service.runNow(blueprint.blueprint_id, OWNER)).rejects.toBeInstanceOf(
      TaskBlueprintArchivedError,
    );
    expect(intake).not.toHaveBeenCalled();
  });

  it('409s with the existing case id when a prior occurrence is non-terminal, and never calls intake', async () => {
    const intake = vi.fn();
    const { service, blueprint } = await seedBlueprint(intake);
    seedCase({
      case_id: 'case_in_flight',
      status: 'in_build',
      assistant_context: { blueprint_id: blueprint.blueprint_id },
    } as unknown as Partial<Case> & { case_id: string });

    await expect(service.runNow(blueprint.blueprint_id, OWNER)).rejects.toMatchObject({
      code: 'TASK_BLUEPRINT_OVERLAP',
      statusCode: 409,
      details: { blueprint_id: blueprint.blueprint_id, case_id: 'case_in_flight' },
    });
    expect(intake).not.toHaveBeenCalled();
  });

  it('is unaffected by a TERMINAL prior case or by a non-terminal case for a DIFFERENT blueprint', async () => {
    const intake = vi.fn().mockResolvedValue(makeIntakeResult());
    const { service, blueprint } = await seedBlueprint(intake);
    seedCase({
      case_id: 'case_done',
      status: 'done',
      assistant_context: { blueprint_id: blueprint.blueprint_id },
    } as unknown as Partial<Case> & { case_id: string });
    seedCase({
      case_id: 'case_other_blueprint',
      status: 'in_build',
      assistant_context: { blueprint_id: 'bp_someone_else' },
    } as unknown as Partial<Case> & { case_id: string });

    await expect(service.runNow(blueprint.blueprint_id, OWNER)).resolves.toBeDefined();
    expect(intake).toHaveBeenCalledTimes(1);
  });
});

/**
 * Both exported standalone (not `TaskBlueprintService` methods, deliberately
 * — see the doc comments on the functions themselves) so the future B2 tick
 * service can reuse the exact same overlap query and key format `runNow`
 * uses, rather than redefining either and risking drift.
 */
describe('buildBlueprintOccurrenceIdempotencyKey', () => {
  it('formats blueprint:{id}:{version}:{occurrence_iso}, matching what runNow constructs', () => {
    expect(
      buildBlueprintOccurrenceIdempotencyKey('bp_digest', 3, '2026-08-06T08:00:00.000Z'),
    ).toBe('blueprint:bp_digest:3:2026-08-06T08:00:00.000Z');
  });
});

describe('findNonTerminalBlueprintCaseId', () => {
  it('returns the case id of a non-terminal case carrying the blueprint_id', async () => {
    seedCase({
      case_id: 'case_in_flight',
      status: 'open',
      assistant_context: { blueprint_id: 'bp_x' },
    } as unknown as Partial<Case> & { case_id: string });

    await expect(findNonTerminalBlueprintCaseId('bp_x')).resolves.toBe('case_in_flight');
  });

  it('returns null when there is no matching non-terminal case', async () => {
    seedCase({
      case_id: 'case_done',
      status: 'done',
      assistant_context: { blueprint_id: 'bp_x' },
    } as unknown as Partial<Case> & { case_id: string });

    await expect(findNonTerminalBlueprintCaseId('bp_x')).resolves.toBeNull();
    await expect(findNonTerminalBlueprintCaseId('bp_nonexistent')).resolves.toBeNull();
  });
});
