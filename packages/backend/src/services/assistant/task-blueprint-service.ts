import {
  ArbitraError,
  ForbiddenError,
  NotFoundError,
  TERMINAL_CASE_STATUSES,
  ValidationError,
  type Case,
  type CreateTaskBlueprintInput,
  type Run,
  type TaskBlueprint,
  type UpdateTaskBlueprintInput,
} from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';
import { generateId } from '../../lib/ids.js';
import { clerkCoreIds } from './clerk-core.js';
import { AssistantIntakeService } from './assistant-intake-service.js';

/**
 * Owner CRUD + run-now for `TaskBlueprint`
 * (`docs/specs/clerk-config-scheduling-chat.md` Slice B, #793 v1).
 *
 * Every method that takes a `callerId` enforces ownership HERE, not only in
 * the route: `get` is the single ownership gate every other method (update,
 * archive, runNow) routes its lookup through, so "owner-only, 403 on foreign
 * blueprint" cannot be forgotten on a future method that forgets to re-derive
 * it. There is no admin bypass in v1.
 */

export class TaskBlueprintArchivedError extends ArbitraError {
  constructor(blueprintId: string) {
    super(
      `Task blueprint '${blueprintId}' is archived and cannot be edited or run. Archiving is terminal in v1 — create a new blueprint instead.`,
      'TASK_BLUEPRINT_ARCHIVED',
      409,
      { blueprint_id: blueprintId },
    );
    this.name = 'TaskBlueprintArchivedError';
  }
}

/** Raised by `runNow` when overlap_policy 'skip' finds a non-terminal occurrence already in flight. */
export class TaskBlueprintOverlapError extends ArbitraError {
  constructor(blueprintId: string, existingCaseId: string) {
    super(
      `Task blueprint '${blueprintId}' already has a non-terminal case '${existingCaseId}'; overlap_policy 'skip' refuses a second occurrence until it finishes.`,
      'TASK_BLUEPRINT_OVERLAP',
      409,
      { blueprint_id: blueprintId, case_id: existingCaseId },
    );
    this.name = 'TaskBlueprintOverlapError';
  }
}

export interface TaskBlueprintRunNowResult {
  case: Case;
  /** The unclaimed run to dispatch. `null` on a replay — see `AssistantIntakeResult.run`. */
  run: Run | null;
  run_id: string;
  /** True when this call replayed a prior occurrence's receipt instead of creating one. */
  replayed: boolean;
}

/** Same shape as `TaskBlueprintRunNowResult` — kept as its own name because it is
 * produced by `createBlueprintOccurrence`, not only by `runNow`, once the B2 tick
 * service calls the shared function directly. */
export type BlueprintOccurrenceResult = TaskBlueprintRunNowResult;

/**
 * Outcome of `createBlueprintOccurrence`: either the occurrence went through
 * (created or replayed — `AssistantIntakeService` tells the two apart via
 * `occurrence.replayed`), or the shared function's own overlap re-check found
 * a non-terminal case and refused to call intake at all.
 */
export type BlueprintOccurrenceOutcome =
  | { skipped: false; occurrence: BlueprintOccurrenceResult }
  | { skipped: true; existingCaseId: string };

export interface TaskBlueprintServiceOptions {
  /** Injectable clock — lets a test freeze `occurrence_iso` across two `runNow` calls to prove they dedupe. */
  now?: () => Date;
  intakeService?: Pick<AssistantIntakeService, 'intake'>;
}

/**
 * `blueprint:{blueprint_id}:{version}:{occurrence_iso}` — the ONE key format
 * every entry point that can create a blueprint occurrence must agree on.
 * Exported (rather than kept private to `runNow`) so the future B2 tick
 * service computes the identical key for its own occurrences without
 * redefining the format — a second definition is exactly the kind of thing
 * that drifts silently.
 */
export function buildBlueprintOccurrenceIdempotencyKey(
  blueprintId: string,
  version: number,
  occurrenceIso: string,
): string {
  return `blueprint:${blueprintId}:${version}:${occurrenceIso}`;
}

/**
 * "A non-terminal case carrying this blueprint_id" — the overlap-'skip'
 * check `createBlueprintOccurrence` runs immediately before intake (both
 * `runNow` and `BlueprintTickService` reach it only through that shared
 * function — see its doc comment). Exported as a standalone function (not a
 * method) so callers that have no reason to construct an owner-scoped
 * `TaskBlueprintService` just to run this query can call it directly.
 * `activeCases()` already excludes soft-deleted docs; combined with the
 * equality filter on `assistant_context.blueprint_id` and the `not-in` on
 * `status`, this needs the composite index added to
 * `firestore.indexes.json` alongside this PR (`(deleted_at,
 * assistant_context.blueprint_id, status)` — same shape as the existing
 * per-user active-task-limit index, just on a different equality field).
 *
 * Not transactional: this is a plain read before `AssistantIntakeService`'s
 * own (separately transactional) commit, so two overlapping calls racing
 * within the query's own latency window can both observe "no overlap" and
 * both proceed. Acceptable for run-now — a manual, owner-only, one-click
 * action a single human is unlikely to double-fire within milliseconds —
 * but `BlueprintTickService`, which can retry or double-tick automatically,
 * must not treat this as the correctness guarantee; it still gets that
 * guarantee from `AssistantIntakeService`'s idempotency-key transaction
 * (real dedupe), same as run-now does. This check is purely the cheap,
 * best-effort "skip a second occurrence while one is still running" policy.
 */
export async function findNonTerminalBlueprintCaseId(blueprintId: string): Promise<string | null> {
  const snap = await collections
    .activeCases()
    .where('assistant_context.blueprint_id', '==', blueprintId)
    .where('status', 'not-in', [...TERMINAL_CASE_STATUSES])
    .limit(1)
    .get();
  const doc = snap.docs[0];
  return doc ? doc.data().case_id : null;
}

/**
 * The ONE place that turns a blueprint + a computed occurrence timestamp into
 * an actual `AssistantIntakeService.intake()` call. `runNow` and the B2
 * `BlueprintTickService` both route through this — never duplicate the body
 * of this function at either call site.
 *
 * Runs the overlap-'skip' check (`findNonTerminalBlueprintCaseId`) itself,
 * immediately before intake — this is the SOLE overlap check either call
 * site performs. (`runNow` used to run the same query a second time, inline,
 * before ever calling this function; that duplicate bought nothing — two
 * reads of the same query a moment apart — and was removed.) Not
 * transactional (see that function's own doc comment), so a tick and a
 * run-now landing in the same instant can still both observe "no overlap"
 * and both call intake. That residual race is closed by
 * `AssistantIntakeService`'s transactional idempotency-key dedupe on the
 * occurrence's receipt, not by this read: both call sites get that
 * guarantee regardless of what this check observes.
 */
export async function createBlueprintOccurrence(
  blueprint: TaskBlueprint,
  occurrenceIso: string,
  intakeService: Pick<AssistantIntakeService, 'intake'>,
): Promise<BlueprintOccurrenceOutcome> {
  const overlappingCaseId = await findNonTerminalBlueprintCaseId(blueprint.blueprint_id);
  if (overlappingCaseId) {
    return { skipped: true, existingCaseId: overlappingCaseId };
  }

  const idempotencyKey = buildBlueprintOccurrenceIdempotencyKey(
    blueprint.blueprint_id,
    blueprint.version,
    occurrenceIso,
  );

  const result = await intakeService.intake(
    {
      text: blueprint.prompt_text,
      channel: 'blueprint',
      idempotency_key: idempotencyKey,
      blueprint: {
        blueprint_id: blueprint.blueprint_id,
        blueprint_version: blueprint.version,
        prompt_text: blueprint.prompt_text,
      },
    },
    blueprint.owner_user_id,
  );

  return {
    skipped: false,
    occurrence: {
      case: result.case,
      run: result.run,
      run_id: result.run_id,
      replayed: result.replayed,
    },
  };
}

export class TaskBlueprintService {
  private readonly now: () => Date;
  private readonly intakeService: Pick<AssistantIntakeService, 'intake'>;

  constructor(options: TaskBlueprintServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.intakeService = options.intakeService ?? new AssistantIntakeService();
  }

  async create(ownerId: string, input: CreateTaskBlueprintInput): Promise<TaskBlueprint> {
    const now = this.now().toISOString();
    const blueprint: TaskBlueprint = {
      blueprint_id: generateId('taskBlueprint'),
      owner_user_id: ownerId,
      project_id: clerkCoreIds(ownerId).projectId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      prompt_text: input.prompt_text,
      cron_schedule: input.cron_schedule,
      timezone: input.timezone,
      enabled: input.enabled ?? true,
      archived_at: null,
      version: 1,
      overlap_policy: 'skip',
      missed_run_policy: 'skip',
      created_at: now,
      updated_at: now,
    };
    await collections.taskBlueprints().doc(blueprint.blueprint_id).set(blueprint);
    return blueprint;
  }

  /**
   * The single ownership gate. `NotFoundError` if the blueprint does not
   * exist; `ForbiddenError` (403 — the task explicitly wants this over a
   * leak-avoiding 404, mirroring `AssistantFollowUpService`'s cross-user
   * denial) if it exists but `callerId` is not `owner_user_id`.
   */
  async get(blueprintId: string, callerId: string): Promise<TaskBlueprint> {
    const snap = await collections.taskBlueprints().doc(blueprintId).get();
    if (!snap.exists) throw new NotFoundError('TaskBlueprint', blueprintId);
    const blueprint = snap.data()!;
    if (blueprint.owner_user_id !== callerId) {
      throw new ForbiddenError(
        `User '${callerId}' does not own task blueprint '${blueprintId}'.`,
        { blueprint_id: blueprintId },
      );
    }
    return blueprint;
  }

  /**
   * Every blueprint `ownerId` owns, most recently created first. Sorted in
   * JS rather than via `.orderBy()` — a per-user blueprint count is small, so
   * this avoids a composite index that a single-field equality query does
   * not otherwise need.
   */
  async list(ownerId: string): Promise<TaskBlueprint[]> {
    const snap = await collections.taskBlueprints().where('owner_user_id', '==', ownerId).get();
    return snap.docs
      .map((doc) => doc.data())
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }

  /**
   * Partial update. Bumps `version` on ANY accepted change — including
   * `enabled` alone — because a future occurrence's snapshot is taken from
   * whatever is current at intake time; there is no update that doesn't need
   * to be attributable to a version (see `UpdateTaskBlueprintInput`).
   * Blocked on an archived blueprint: archiving is terminal in v1.
   */
  async update(blueprintId: string, callerId: string, input: UpdateTaskBlueprintInput): Promise<TaskBlueprint> {
    const existing = await this.get(blueprintId, callerId);
    if (existing.archived_at) throw new TaskBlueprintArchivedError(blueprintId);

    const updates: Partial<TaskBlueprint> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.prompt_text !== undefined) updates.prompt_text = input.prompt_text;
    if (input.cron_schedule !== undefined) updates.cron_schedule = input.cron_schedule;
    if (input.timezone !== undefined) updates.timezone = input.timezone;
    if (input.enabled !== undefined) updates.enabled = input.enabled;

    if (Object.keys(updates).length === 0) {
      // The route's Zod schema already rejects an empty body; this is the
      // service-level backstop for any other caller of this method.
      throw new ValidationError('At least one field must be provided.', { blueprint_id: blueprintId });
    }

    updates.version = existing.version + 1;
    updates.updated_at = this.now().toISOString();

    // Single write, no post-read — merge locally from `existing` (same shape
    // as `KnowledgeService.updateAsset`).
    await collections.taskBlueprints().doc(blueprintId).update(updates);
    return { ...existing, ...updates };
  }

  /**
   * Terminal in v1 — no unarchive flow. Idempotent: archiving an
   * already-archived blueprint returns it unchanged rather than erroring or
   * bumping `version` again.
   */
  async archive(blueprintId: string, callerId: string): Promise<TaskBlueprint> {
    const existing = await this.get(blueprintId, callerId);
    if (existing.archived_at) return existing;

    const updates: Partial<TaskBlueprint> = {
      archived_at: this.now().toISOString(),
      // Belt-and-suspenders alongside `archived_at`: a future Scheduled tab
      // reading only `enabled` (without also checking `archived_at`) still
      // renders an archived blueprint as off.
      enabled: false,
      updated_at: this.now().toISOString(),
    };
    await collections.taskBlueprints().doc(blueprintId).update(updates);
    return { ...existing, ...updates };
  }

  /**
   * The run-now occurrence path (`docs/specs/clerk-config-scheduling-chat.md`
   * Slice B). Ownership is enforced by `get` — this is the ONLY place in the
   * codebase besides `BlueprintTickService` that can trigger a blueprint
   * occurrence, and unlike the tick service this one runs behind
   * `authenticate()`.
   *
   * Order matters: archived check, then straight into
   * `createBlueprintOccurrence`, which runs the overlap-'skip' query itself
   * immediately before intake — the single such check, shared with the tick
   * service (see that function's doc comment; an earlier duplicate check
   * inline here was removed as pure redundancy).
   */
  async runNow(blueprintId: string, callerId: string): Promise<TaskBlueprintRunNowResult> {
    const blueprint = await this.get(blueprintId, callerId);
    if (blueprint.archived_at) throw new TaskBlueprintArchivedError(blueprintId);

    // Computed once, so two calls sharing an injected clock (tests) or landing
    // in the same millisecond (production — vanishingly unlikely, but the
    // point of an idempotency key is to not depend on that) produce the SAME
    // key and therefore the same occurrence.
    const occurrenceIso = this.now().toISOString();
    const outcome = await createBlueprintOccurrence(blueprint, occurrenceIso, this.intakeService);

    if (outcome.skipped) {
      throw new TaskBlueprintOverlapError(blueprint.blueprint_id, outcome.existingCaseId);
    }

    return outcome.occurrence;
  }
}
