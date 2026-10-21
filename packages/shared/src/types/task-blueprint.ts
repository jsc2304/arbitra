/**
 * A versioned, user-owned definition for recurring Clerk work
 * (`docs/specs/clerk-config-scheduling-chat.md`, Slice B — #793 v1: schedule +
 * run-now). Every occurrence a blueprint produces is one ordinary
 * `assistant_task` Case + Run, governed by the exact same access and
 * lifecycle rules as a manually started Clerk task — a blueprint is a
 * template for intake, never a second execution path.
 *
 * **Version immutability is by snapshot, not history.** Neither
 * `KnowledgeAsset` nor `EvidencePolicy` keeps old versions — both mutate in
 * place — and this type does the same: `version` is bumped on every edit, and
 * the CURRENT row is the only one ever stored. What makes an old occurrence's
 * prompt reproducible is that `AssistantIntakeService` stamps
 * `blueprint_context: {blueprint_id, blueprint_version, prompt_text}` onto the
 * generated Case's `assistant_context` AT INTAKE TIME (see
 * `AssistantContext` in `./case.js`) — the Case, not this row, is the
 * historical record. Editing a blueprint therefore never rewrites a prior
 * occurrence's snapshot.
 *
 * v1 scope (slice B1, this file): the domain object, owner CRUD, and the
 * run-now occurrence path. The cron tick service, the `croner` dependency,
 * and the `/clerk` Scheduled tab are later slices (B2/B3) and read this same
 * shape without changing it.
 */
export interface TaskBlueprint {
  blueprint_id: string;
  owner_user_id: string;
  /** `clerkCoreIds(owner_user_id).projectId` in v1 — every blueprint lives in its owner's private Clerk project. */
  project_id: string;
  name: string;
  description?: string;
  /**
   * Rendered verbatim into intake as the occurrence's `text` — no parameter
   * substitution in v1 (see the issue's "parameter typing beyond plain
   * strings" non-goal).
   */
  prompt_text: string;
  /**
   * Syntactically a 5-field cron expression (validated at the route boundary
   * by `taskBlueprintCronScheduleSchema` — see
   * `packages/shared/src/validation/task-blueprint-validators.ts`). Semantic
   * evaluation (next-run computation, DST correctness) arrives with `croner`
   * in slice B2; this field is inert data until that tick service exists.
   */
  cron_schedule: string;
  /** IANA time zone name the cron expression is evaluated in (by the B2 tick service). */
  timezone: string;
  /**
   * Owner-controlled pause switch. Distinct from `archived_at`: a disabled
   * blueprint still exists and can still be run manually (run-now bypasses
   * the schedule entirely) — it only stops the B2 tick service from firing
   * it. Only `archived_at` is terminal.
   */
  enabled: boolean;
  /** Set once the blueprint is archived (terminal — no unarchive flow in v1). `null`/absent while live. */
  archived_at?: string | null;
  /** Bumped on every edit. Never decremented, never reset. */
  version: number;
  /** v1 constant — exactly one active (non-terminal) occurrence per blueprint at a time. */
  overlap_policy: TaskBlueprintOverlapPolicy;
  /** v1 constant — a missed tick window is simply skipped, no catch-up run. */
  missed_run_policy: TaskBlueprintMissedRunPolicy;
  created_at: string;
  updated_at: string;
}

/**
 * v1 ships exactly one value. Kept as its own named type (rather than
 * inlining the literal on `TaskBlueprint`) so a later slice widening this to
 * `'skip' | 'queue_one' | ...` (per the #793 issue body) touches one
 * declaration instead of every call site.
 */
export type TaskBlueprintOverlapPolicy = 'skip';

/** v1 ships exactly one value — see `TaskBlueprintOverlapPolicy`. */
export type TaskBlueprintMissedRunPolicy = 'skip';

export interface CreateTaskBlueprintInput {
  name: string;
  description?: string;
  prompt_text: string;
  cron_schedule: string;
  timezone: string;
  /** Defaults to `true` when omitted. */
  enabled?: boolean;
}

/**
 * Partial update payload. Any successful update bumps `version` — even a
 * change to `enabled` alone — because the blueprint's effective content at
 * the moment of edit is what future occurrences snapshot; there is no
 * "trivial" edit that doesn't need to be attributable to a version.
 */
export interface UpdateTaskBlueprintInput {
  name?: string;
  description?: string;
  prompt_text?: string;
  cron_schedule?: string;
  timezone?: string;
  enabled?: boolean;
}
