'use client';

/**
 * `<ClerkScheduledPanel>` — the Scheduled tab on `/clerk` (#793 slice B3).
 *
 * Owner CRUD + run-now UI for `TaskBlueprint`s
 * (`docs/specs/clerk-config-scheduling-chat.md`, slice B). Every blueprint
 * this panel lists is the owner's own — the underlying routes
 * (`/api/assistant/blueprints[/id[/run]]`) fix that the same way slice A's
 * context routes fix scope to the caller's own Clerk project, so there is no
 * owner picker here either. Chrome and the create/edit/delete-vs-archive
 * shape mirror `ClerkContextPanel` deliberately (list-plus-editor,
 * deps-injected pure list-mutation functions, an `editorKey`-style remount
 * guard) — see that file's header comment for the regression the remount
 * guard fixes; the same bug class applies here (editing blueprint A, then
 * clicking Edit on B while A's form is still open, must not let a save PATCH
 * A's text onto B).
 *
 * Archiving (`DELETE`) is soft: `TaskBlueprintService.list` returns every
 * blueprint the owner has, archived or not (no `archived_at` filter), so
 * archived rows are ONLY hidden here, client-side (`visibleBlueprints`) —
 * archiving is terminal in v1 (no unarchive flow), and a hidden row is the
 * correct UI for "terminal, nothing more to do with it."
 *
 * **Occurrence history (#858).** `GET /api/assistant/tasks` exposes
 * `blueprint_id` (`assistant_context.blueprint_id`) and `blueprint_version`
 * on every row it returns, so this panel groups that same list by blueprint
 * — see `groupAssistantTasksByBlueprint` — instead of tracking runs itself.
 * The request asks for the newest `OCCURRENCE_TASK_LIST_LIMIT` (50) of the
 * caller's Clerk cases; a blueprint whose last real occurrence has aged out
 * of that window shows none. That is a stated limitation (see the panel's
 * own description text below), not a bug: recent history, not complete
 * history.
 *
 * A Run-now call from THIS panel still records into `BlueprintLastRunMap`
 * (`lastRun` state) immediately, because the freshly created case is not
 * reliably in the next task-list read yet (SWR has not revalidated; a write
 * an instant ago is not guaranteed queryable). That overlay is only ever a
 * bridge to the next revalidation, not a permanent second source of truth:
 * `handleRunNow` calls `mutateTasks()` right after recording it, and
 * `refreshInterval: 15_000` (matching `ClerkAskPanel`) keeps polling
 * afterwards, so once the real task list contains that `case_id`,
 * `occurrencesForBlueprint` drops the overlay row in favor of the real one —
 * which is also the only one that can carry `reads_withheld`, stamped by
 * `AssistantTaskExecutor` once the run finishes, never known at creation.
 */

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import type { CreateTaskBlueprintInput, TaskBlueprint, UpdateTaskBlueprintInput } from '@arbitra/shared';
import { api, ApiError, type AssistantTaskCreated, type AssistantTaskSummary } from '../../lib/api-client';
import { assistantTasksSwrKey } from './clerk-ask-panel';
import { useAuth } from '../../providers/auth-provider';
import { useToast } from '../../providers/toast-provider';
import { ConfirmDialog } from '../shared/confirm-dialog';
import { Badge } from '../shared/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import Card from '../shared/card';
import SectionHeader from '../shared/section-header';
import { SchedulerPausedBanner } from '../shared/scheduler-paused-banner';
import {
  MAX_BUILDER_DAY_OF_MONTH,
  SCHEDULE_FREQUENCY_OPTIONS,
  WEEKDAY_BUILDER_OPTIONS,
  buildCron,
  cronToBuilderState,
  defaultScheduleBuilderState,
  isScheduleBuilderStateValid,
  scheduleBuilderErrors,
  type ScheduleBuilderState,
  type ScheduleFrequency,
  type ScheduleIntervalUnit,
} from './schedule-builder';

/**
 * SWR key for the signed-in user's own blueprints, scoped by uid for the
 * same reason `contextEntriesSwrKey` is: sign-out neither reloads the app
 * nor clears SWR's cache, so an unscoped key would hand one account's
 * blueprints to the next account signed in the same tab.
 */
export function blueprintsSwrKey(uid: string | undefined): [string, string] | null {
  return uid ? ['clerk-blueprints', uid] : null;
}

// ─── describeCronSchedule ────────────────────────────────────────────────

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const WEEKDAY_ABBREVIATIONS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function weekdayName(token: string): string | null {
  const trimmed = token.trim().toLowerCase();
  if (/^[0-7]$/.test(trimmed)) {
    // Cron's day-of-week is 0-7 with BOTH 0 and 7 meaning Sunday.
    return WEEKDAY_NAMES[Number(trimmed) % 7] ?? null;
  }
  const index = WEEKDAY_ABBREVIATIONS[trimmed];
  return index !== undefined ? WEEKDAY_NAMES[index] ?? null : null;
}

function isPlainInteger(token: string): boolean {
  return /^\d+$/.test(token);
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/** `['Monday']` → "Monday"; `['Monday','Wednesday']` → "Monday and Wednesday"; 3+ → Oxford-comma list. */
function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * A 5-field cron expression (`minute hour day-of-month month day-of-week`,
 * the shape `taskBlueprintCronScheduleSchema` validates syntactically) as a
 * human sentence. Covers the shapes a schedule made through this editor is
 * overwhelmingly likely to be — every-N-minutes, every-N-hours, a fixed
 * daily time, a fixed time on one or more named weekdays, a fixed time on
 * one day of the month — and falls back to the RAW cron string, unchanged,
 * for anything else (a comma/range list outside those shapes, a constrained
 * month field, or a malformed field count that should never reach here past
 * route-level validation). The raw string is always shown alongside this
 * result too (see `ScheduleSummary`), so the fallback never leaves the user
 * with nothing — it just means "no plain-English translation for this one."
 */
export function describeCronSchedule(cronSchedule: string): string {
  const raw = cronSchedule.trim();
  const fields = raw.split(/\s+/);
  if (fields.length !== 5) return raw;
  // Non-null assertions are safe here: the length check just above pins
  // every one of these five indices to a real element.
  const minute = fields[0]!;
  const hour = fields[1]!;
  const dayOfMonth = fields[2]!;
  const month = fields[3]!;
  const dayOfWeek = fields[4]!;

  if (minute === '*' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every minute';
  }

  const everyNMinutes = minute.match(/^\*\/(\d+)$/);
  if (everyNMinutes && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const n = Number(everyNMinutes[1]);
    // `*/0` matches the regex (one-or-more digits) but is not a real step —
    // cron has no "every 0 minutes". Falling through to the raw string is
    // the honest answer; a step of 0 must never render as "Every 0 minutes".
    if (!Number.isInteger(n) || n < 1) return raw;
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  const everyNHours = hour.match(/^\*\/(\d+)$/);
  if (everyNHours && isPlainInteger(minute) && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const n = Number(everyNHours[1]);
    // Same "*/0 is not a real step" guard as the minutes branch above.
    if (!Number.isInteger(n) || n < 1) return raw;
    const minuteValue = Number(minute);
    const suffix = minuteValue === 0 ? '' : ` at minute ${pad2(minuteValue)}`;
    return n === 1 ? `Every hour${suffix}` : `Every ${n} hours${suffix}`;
  }

  // Every remaining covered shape needs a fixed time of day and an
  // unconstrained month — anything else is outside what this function
  // translates.
  if (!isPlainInteger(minute) || !isPlainInteger(hour) || month !== '*') return raw;
  const time = `${pad2(Number(hour))}:${pad2(Number(minute))}`;

  if (dayOfMonth === '*' && dayOfWeek === '*') {
    return `Every day at ${time}`;
  }

  if (dayOfMonth === '*' && dayOfWeek !== '*') {
    const names = dayOfWeek.split(',').map(weekdayName);
    if (names.some((name) => name === null)) return raw;
    return `Every ${joinWithAnd(names as string[])} at ${time}`;
  }

  if (dayOfWeek === '*' && dayOfMonth !== '*' && isPlainInteger(dayOfMonth)) {
    return `On day ${Number(dayOfMonth)} of the month at ${time}`;
  }

  return raw;
}

// ─── timezone options ────────────────────────────────────────────────────

let cachedTimeZoneOptions: string[] | null = null;

/**
 * `'UTC'` is prepended even though `Intl.supportedValuesOf('timeZone')`
 * omits it from the canonical IANA list it returns — same runtime quirk
 * `isSupportedTimeZone` (`task-blueprint-validators.ts`) already works
 * around on the write path. Cached for the same reason that function caches:
 * `supportedValuesOf` reallocates its array on every call.
 */
function listTimeZoneOptions(): string[] {
  if (!cachedTimeZoneOptions) {
    const zones = typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [];
    cachedTimeZoneOptions = ['UTC', ...zones];
  }
  return cachedTimeZoneOptions;
}

/** The browser's own IANA zone, falling back to UTC if the runtime cannot resolve one. */
export function defaultBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ─── occurrence outcome ──────────────────────────────────────────────────

export type BlueprintOccurrenceOutcome = 'done' | 'reads_withheld' | 'failed' | 'pending';

export interface BlueprintOccurrenceOutcomeInput {
  /** A `CaseStatus` string, or the synthetic `'overlap_pending'` `recordBlueprintOverlap` stamps. */
  status: string;
  /** Only known once the task-result artifact has been read — absent means "not known here". */
  readsWithheld?: boolean;
}

export interface BlueprintOccurrenceBadge {
  outcome: BlueprintOccurrenceOutcome;
  label: string;
  colorClassName: string;
}

// Colour tokens follow `severity-badge.tsx`'s existing low/critical mapping
// (corp-green for the good outcome, corp-red for the bad one) so this badge
// reads consistently with the rest of the app rather than inventing a new
// palette for one component. `reads_withheld` is deliberately NOT in that
// severity mapping: the locked "Withheld reads" rule bans
// an amber warning (or any severity color) for this flag — it is a fact
// about the Run, not a lifecycle judgement — so its badge shares the same
// neutral grey as the `pending` bucket instead of a warning color.
const DONE_BADGE_CLASS =
  'bg-corp-green/15 text-corp-dark ring-corp-green/40 dark:bg-corp-green/20 dark:text-corp-green dark:ring-transparent';
const READS_WITHHELD_BADGE_CLASS =
  'bg-gray-100 text-gray-600 ring-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-700';
const FAILED_BADGE_CLASS =
  'bg-corp-red/15 text-corp-dark ring-corp-red/40 dark:bg-corp-red/20 dark:text-corp-red dark:ring-transparent';
const PENDING_BADGE_CLASS =
  'bg-gray-100 text-gray-500 ring-gray-300 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-700';

/**
 * Maps a case's terminal status (plus, where available, the task result's
 * `reads_withheld` flag) to one of the badge's three named outcomes, or a
 * fourth `pending` bucket for a non-terminal case — the spec's badge only
 * names done/reads-withheld/failed, but a freshly started occurrence is
 * neither of those yet, and rendering nothing would look like a stuck panel.
 *
 * `readsWithheld` is optional because it is only known once the run has
 * finished and `AssistantTaskExecutor` has stamped it onto the case's
 * `assistant_context` (see that method's `extraCaseUpdates`) — a Run-now
 * response carries only the case's status at CREATION time, before the run
 * has executed, so the session-local overlay (`occurrencesForBlueprint`)
 * always calls this with the field omitted. The real task list
 * (`GET /api/assistant/tasks`) supplies it once the run is done.
 */
export function describeBlueprintOccurrenceOutcome(
  input: BlueprintOccurrenceOutcomeInput,
): BlueprintOccurrenceBadge {
  if (input.status === 'rejected') {
    return { outcome: 'failed', label: 'Failed', colorClassName: FAILED_BADGE_CLASS };
  }
  if (input.status === 'done') {
    return input.readsWithheld
      ? { outcome: 'reads_withheld', label: 'Reads withheld', colorClassName: READS_WITHHELD_BADGE_CLASS }
      : { outcome: 'done', label: 'Done', colorClassName: DONE_BADGE_CLASS };
  }
  return { outcome: 'pending', label: 'Running', colorClassName: PENDING_BADGE_CLASS };
}

// ─── session-local last-run tracking ─────────────────────────────────────

export interface BlueprintLastRun {
  case_id: string;
  /** A `CaseStatus` string as it stood right after intake, or `'overlap_pending'` — see `recordBlueprintOverlap`. */
  status: string;
  replayed: boolean;
}

export type BlueprintLastRunMap = Record<string, BlueprintLastRun>;

/** Records a Run-now (or replayed Run-now) result against its blueprint, leaving every other entry untouched. */
export function recordBlueprintRunResult(
  current: BlueprintLastRunMap,
  blueprintId: string,
  result: Pick<AssistantTaskCreated, 'case_id' | 'status' | 'replayed'>,
): BlueprintLastRunMap {
  return {
    ...current,
    [blueprintId]: { case_id: result.case_id, status: result.status, replayed: result.replayed },
  };
}

/**
 * Records that Run-now found a non-terminal occurrence already in flight
 * (`TASK_BLUEPRINT_OVERLAP`, 409). `'overlap_pending'` is not a real
 * `CaseStatus` — it only has to satisfy `describeBlueprintOccurrenceOutcome`'s
 * "anything but done/rejected is pending" fallback, which it does.
 */
export function recordBlueprintOverlap(
  current: BlueprintLastRunMap,
  blueprintId: string,
  existingCaseId: string,
): BlueprintLastRunMap {
  return {
    ...current,
    [blueprintId]: { case_id: existingCaseId, status: 'overlap_pending', replayed: false },
  };
}

// ─── real occurrence history (from GET /api/assistant/tasks) ────────────

/** How many of the caller's newest Clerk cases the occurrence list is built from — see this file's header comment on why this makes history recent, not complete. */
export const OCCURRENCE_TASK_LIST_LIMIT = 50;

/** How many of a blueprint's occurrences this panel renders per row. */
const MAX_OCCURRENCES_PER_BLUEPRINT = 3;

/**
 * Groups a task list by `blueprint_id`, dropping tasks that have none (not
 * created from a blueprint — the great majority of `/clerk`'s Ask-tab
 * traffic). The input list is already newest-first (`GET /api/assistant/tasks`
 * orders by `updated_at desc`), and grouping by key preserves each task's
 * relative order within its group, so every group here is newest-first too
 * without a re-sort.
 */
export function groupAssistantTasksByBlueprint(
  tasks: readonly AssistantTaskSummary[],
): Record<string, AssistantTaskSummary[]> {
  const byBlueprint: Record<string, AssistantTaskSummary[]> = {};
  for (const task of tasks) {
    if (!task.blueprint_id) continue;
    (byBlueprint[task.blueprint_id] ??= []).push(task);
  }
  return byBlueprint;
}

export interface BlueprintOccurrenceRow {
  case_id: string;
  outcome: BlueprintOccurrenceBadge;
  /**
   * True only for the session-local Run-now echo (`BlueprintLastRunMap`)
   * while its case has not yet appeared in a real task-list read. Not
   * rendered any differently today — the field exists so a future caller (or
   * test) can tell "confirmed by the server" from "just fired" without
   * re-deriving it.
   */
  optimistic: boolean;
}

/**
 * One blueprint's rows for `BlueprintRow`, newest first, capped at
 * `MAX_OCCURRENCES_PER_BLUEPRINT`. The session-local Run-now echo
 * (`lastRun[blueprintId]`) is prepended ONLY when its case is not already
 * among the real rows — once a revalidation of the task list picks it up,
 * this stops prepending it and the real row (with accurate `reads_withheld`)
 * takes over instead, which is what makes the overlay temporary rather than
 * a permanent second source of truth.
 */
export function occurrencesForBlueprint(
  tasksByBlueprint: Record<string, AssistantTaskSummary[]>,
  lastRun: BlueprintLastRunMap,
  blueprintId: string,
): BlueprintOccurrenceRow[] {
  const real = tasksByBlueprint[blueprintId] ?? [];
  const overlay = lastRun[blueprintId];
  const overlayIsReal = overlay ? real.some((task) => task.case_id === overlay.case_id) : true;

  const rows: BlueprintOccurrenceRow[] = [];
  if (overlay && !overlayIsReal) {
    rows.push({
      case_id: overlay.case_id,
      outcome: describeBlueprintOccurrenceOutcome({ status: overlay.status }),
      optimistic: true,
    });
  }
  for (const task of real) {
    rows.push({
      case_id: task.case_id,
      outcome: describeBlueprintOccurrenceOutcome({ status: task.status, readsWithheld: task.reads_withheld }),
      optimistic: false,
    });
  }
  return rows.slice(0, MAX_OCCURRENCES_PER_BLUEPRINT);
}

// ─── list mutation (pure, deps-injected — same shape as clerk-context-panel.tsx) ──

export interface BlueprintActionDeps {
  create(input: CreateTaskBlueprintInput): Promise<{ blueprint: TaskBlueprint }>;
  update(blueprintId: string, input: UpdateTaskBlueprintInput): Promise<{ blueprint: TaskBlueprint }>;
  archive(blueprintId: string): Promise<{ blueprint: TaskBlueprint }>;
}

/** Create one blueprint and return the list with it prepended (the service itself sorts newest-created first). */
export async function createBlueprint(
  deps: Pick<BlueprintActionDeps, 'create'>,
  blueprints: TaskBlueprint[],
  input: CreateTaskBlueprintInput,
): Promise<TaskBlueprint[]> {
  const { blueprint } = await deps.create(input);
  return [blueprint, ...blueprints];
}

/** Update one blueprint in place; the rest of the list is untouched. */
export async function updateBlueprint(
  deps: Pick<BlueprintActionDeps, 'update'>,
  blueprints: TaskBlueprint[],
  blueprintId: string,
  input: UpdateTaskBlueprintInput,
): Promise<TaskBlueprint[]> {
  const { blueprint } = await deps.update(blueprintId, input);
  return blueprints.map((existing) =>
    existing.blueprint_id === blueprint.blueprint_id ? blueprint : existing);
}

/** Archive one blueprint in place (soft — see this file's header comment); the rest of the list is untouched. */
export async function archiveBlueprint(
  deps: Pick<BlueprintActionDeps, 'archive'>,
  blueprints: TaskBlueprint[],
  blueprintId: string,
): Promise<TaskBlueprint[]> {
  const { blueprint } = await deps.archive(blueprintId);
  return blueprints.map((existing) =>
    existing.blueprint_id === blueprint.blueprint_id ? blueprint : existing);
}

// ─── run-now (pure, deps-injected) ───────────────────────────────────────

export type BlueprintRunNowResult =
  | { kind: 'started'; lastRun: BlueprintLastRunMap }
  | { kind: 'replayed'; lastRun: BlueprintLastRunMap }
  | { kind: 'overlap'; lastRun: BlueprintLastRunMap; existingCaseId: string | null }
  | { kind: 'error'; message: string };

/**
 * Run-now, exercised as a standalone async function (not inline in an event
 * handler) so its three outcomes — started, replayed, overlap — are directly
 * testable against a mocked `runNow`, the same way `createContextEntry` et
 * al. are in `clerk-context-panel.tsx`.
 */
export async function runBlueprintNow(
  deps: Pick<typeof api.assistant.blueprints, 'runNow'>,
  lastRun: BlueprintLastRunMap,
  blueprintId: string,
): Promise<BlueprintRunNowResult> {
  try {
    const result = await deps.runNow(blueprintId);
    return {
      kind: result.replayed ? 'replayed' : 'started',
      lastRun: recordBlueprintRunResult(lastRun, blueprintId, result),
    };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'TASK_BLUEPRINT_OVERLAP') {
      const existingCaseId = typeof error.details?.case_id === 'string' ? error.details.case_id : null;
      return {
        kind: 'overlap',
        lastRun: existingCaseId
          ? recordBlueprintOverlap(lastRun, blueprintId, existingCaseId)
          : lastRun,
        existingCaseId,
      };
    }
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : 'Run now failed.',
    };
  }
}

// ─── validation-error mapping ────────────────────────────────────────────

/**
 * Field-level messages out of a 400 `VALIDATION_ERROR` response — e.g. the
 * exact "cron_schedule must be 5 whitespace-separated fields..." or
 * "timezone must be a recognized IANA time zone name" the route's own Zod
 * schema raises (`task-blueprint-validators.ts`), keyed by the field they're
 * about so the editor can show each one inline rather than as one opaque
 * banner. Only the FIRST issue per field is kept — plenty for a form this
 * small, and it keeps the mapping a straight `path[0] → message` lookup.
 */
export function blueprintFieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_ERROR') return {};
  const issues = error.details?.issues;
  if (!Array.isArray(issues)) return {};
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    if (typeof issue !== 'object' || issue === null) continue;
    const path = (issue as { path?: unknown }).path;
    const message = (issue as { message?: unknown }).message;
    const key = Array.isArray(path) && typeof path[0] === 'string' ? path[0] : '_root';
    if (typeof message === 'string' && fieldErrors[key] === undefined) {
      fieldErrors[key] = message;
    }
  }
  return fieldErrors;
}

// ─── editor ───────────────────────────────────────────────────────────────

export interface BlueprintFormValues {
  name: string;
  prompt_text: string;
  cron_schedule: string;
  timezone: string;
  enabled: boolean;
}

/**
 * The name/prompt/cron/timezone/enabled form, shared by create and edit.
 * Exported for the same reason `ClerkContextEditor` is: its rendering
 * contract (pre-filled values, the disabled-Save guard, inline field
 * errors) is directly testable without going through the click that opens
 * it.
 */
/**
 * The friendly builder that replaces the raw cron `<Input>` as the primary
 * schedule control (#793; the pattern is a familiar schedule dialog — radio-group
 * frequency, weekday checkbox grid, hh:mm time field — MINUS start-date/
 * end-date fields, which have no equivalent in `TaskBlueprint` and are
 * explicitly out of scope). All the state-shape and cron-mapping logic lives in
 * `schedule-builder.ts`; this component is purely the five families' form
 * fields, the live preview, and the Advanced fallback (the pre-existing raw
 * `<Input>`, unchanged).
 *
 * `cronFieldError` (the route's own `cron_schedule` validation message) is
 * rendered in TWO places depending on `state.frequency`: inside the raw
 * Advanced `<Input>` itself when that's the active family (same as before
 * this builder existed), or as a standalone line next to the live preview
 * otherwise — a builder-generated cron is syntactically valid by
 * construction, so that second path is a defensive fallback, not the
 * expected case, but it keeps the message reachable no matter which family
 * is selected rather than silently dropping it.
 */
function ScheduleBuilderSection({
  state,
  onChange,
  cronFieldError,
}: {
  state: ScheduleBuilderState;
  onChange: (next: ScheduleBuilderState) => void;
  cronFieldError?: string;
}) {
  const cronSchedule = useMemo(() => buildCron(state), [state]);
  const errors = scheduleBuilderErrors(state);

  function setFrequency(frequency: ScheduleFrequency): void {
    if (frequency === state.frequency) return;
    // Switching INTO Advanced seeds its text box with the cron the OUTGOING
    // family was already producing, so the box never starts blank — the
    // outgoing family's own sub-fields (time, weekdays, …) are left
    // untouched in state, so switching back out of Advanced later restores
    // them rather than resetting to defaults.
    if (frequency === 'advanced') {
      onChange({ ...state, frequency, advancedCron: cronSchedule });
      return;
    }
    onChange({ ...state, frequency });
  }

  return (
    <div className="space-y-3" data-testid="schedule-builder">
      <div>
        <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
          Schedule
        </span>
        <div
          role="radiogroup"
          aria-label="Schedule frequency"
          className="flex flex-wrap gap-x-4 gap-y-1.5"
        >
          {SCHEDULE_FREQUENCY_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer"
            >
              <input
                type="radio"
                name="schedule-frequency"
                checked={state.frequency === option.value}
                onChange={() => setFrequency(option.value)}
                className="h-3.5 w-3.5 border-gray-300 text-accent focus:ring-accent"
              />
              {option.label}
            </label>
          ))}
        </div>
      </div>

      {state.frequency === 'weekly' && (
        <div>
          <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
            Days
          </span>
          <div className="grid grid-cols-2 gap-1 max-w-[12rem]" data-testid="schedule-weekday-grid">
            {WEEKDAY_BUILDER_OPTIONS.map((day) => (
              <label
                key={day.value}
                className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={state.weekdays.includes(day.value)}
                  onChange={() => {
                    const weekdays = state.weekdays.includes(day.value)
                      ? state.weekdays.filter((value) => value !== day.value)
                      : [...state.weekdays, day.value];
                    onChange({ ...state, weekdays });
                  }}
                  className="rounded border-gray-300 dark:border-gray-600 text-accent focus:ring-accent"
                />
                {day.label}
              </label>
            ))}
          </div>
          {errors.weekdays && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400" data-testid="schedule-weekday-error">
              {errors.weekdays}
            </p>
          )}
        </div>
      )}

      {state.frequency === 'monthly' && (
        <Input
          as="select"
          label="Day of month"
          value={state.dayOfMonth}
          onChange={(event) => onChange({ ...state, dayOfMonth: Number(event.target.value) })}
          hint="Only days 1–28 are offered, so every month has this day — no month is ever skipped."
        >
          {Array.from({ length: MAX_BUILDER_DAY_OF_MONTH }, (_, index) => index + 1).map((day) => (
            <option key={day} value={day}>
              {day}
            </option>
          ))}
        </Input>
      )}

      {(state.frequency === 'daily' ||
        state.frequency === 'weekdays' ||
        state.frequency === 'weekly' ||
        state.frequency === 'monthly') && (
        <Input
          type="time"
          label="Time"
          value={state.time}
          onChange={(event) => onChange({ ...state, time: event.target.value })}
        />
      )}

      {state.frequency === 'interval' && (
        <div className="flex items-end gap-2">
          <Input
            type="number"
            min={1}
            label="Every"
            wrapperClassName="w-24"
            value={state.intervalValue}
            onChange={(event) =>
              onChange({ ...state, intervalValue: Math.max(1, Number(event.target.value) || 1) })
            }
          />
          <Input
            as="select"
            label="Unit"
            wrapperClassName="w-32"
            value={state.intervalUnit}
            onChange={(event) =>
              onChange({ ...state, intervalUnit: event.target.value as ScheduleIntervalUnit })
            }
          >
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
          </Input>
        </div>
      )}

      {state.frequency === 'advanced' && (
        <Input
          label="Cron schedule"
          value={state.advancedCron}
          onChange={(event) => onChange({ ...state, advancedCron: event.target.value })}
          placeholder="0 9 * * 1"
          hint="minute hour day-of-month month day-of-week"
          error={cronFieldError}
        />
      )}

      <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="schedule-preview">
        {describeCronSchedule(cronSchedule)}
        {' — '}
        <code className="font-mono text-gray-500 dark:text-gray-500">{cronSchedule}</code>
      </p>
      {cronFieldError && state.frequency !== 'advanced' && (
        <p className="text-xs text-red-600 dark:text-red-400" data-testid="schedule-cron-error">
          {cronFieldError}
        </p>
      )}
    </div>
  );
}

export function ClerkScheduledEditor({
  initial,
  saving,
  error,
  fieldErrors,
  onSave,
  onCancel,
}: {
  /** Omit for a new blueprint; pass current values to edit one in place. */
  initial?: BlueprintFormValues;
  saving: boolean;
  /** A non-field-specific error (network failure, an archived-blueprint 409, …). */
  error: string | null;
  /** Per-field messages from the route's own 400 response — see `blueprintFieldErrors`. */
  fieldErrors: Record<string, string>;
  onSave: (values: BlueprintFormValues) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [promptText, setPromptText] = useState(initial?.prompt_text ?? '');
  // Seeded via `cronToBuilderState` when editing (opens populated for any of
  // the five recognized families, or in Advanced with the raw string intact
  // for a foreign cron), or a fresh Daily-at-09:00 default for a new
  // blueprint — see `schedule-builder.ts`'s header comment for the mapping.
  const [builderState, setBuilderState] = useState<ScheduleBuilderState>(() =>
    initial ? cronToBuilderState(initial.cron_schedule) : defaultScheduleBuilderState(),
  );
  const [timezone, setTimezone] = useState(initial?.timezone ?? defaultBrowserTimeZone());
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const isEditing = initial !== undefined;
  const timeZoneOptions = listTimeZoneOptions();
  const cronSchedule = useMemo(() => buildCron(builderState), [builderState]);
  const scheduleValid = isScheduleBuilderStateValid(builderState);

  return (
    <Card as="section" padding="none" data-testid="scheduled-editor">
      <form
        className="p-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmedName = name.trim();
          const trimmedPrompt = promptText.trim();
          const trimmedCron = cronSchedule.trim();
          if (!trimmedName || !trimmedPrompt || !trimmedCron || !timezone || !scheduleValid) return;
          onSave({
            name: trimmedName,
            prompt_text: trimmedPrompt,
            cron_schedule: trimmedCron,
            timezone,
            enabled,
          });
        }}
      >
        <Input
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Weekly team case review"
          error={fieldErrors.name}
        />
        <Input
          as="textarea"
          label="Prompt"
          rows={5}
          value={promptText}
          onChange={(event) => setPromptText(event.target.value)}
          placeholder="e.g. Every Monday at 9, summarize my team's open cases"
          error={fieldErrors.prompt_text}
        />
        <ScheduleBuilderSection
          state={builderState}
          onChange={setBuilderState}
          cronFieldError={fieldErrors.cron_schedule}
        />
        <Input
          as="select"
          label="Timezone"
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          error={fieldErrors.timezone}
        >
          {timeZoneOptions.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </Input>
        <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="rounded border-gray-300 dark:border-gray-600 text-accent focus:ring-accent"
          />
          Enabled
        </label>
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400" data-testid="editor-error">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={saving || !name.trim() || !promptText.trim() || !cronSchedule.trim() || !scheduleValid}
          >
            {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Create blueprint'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ─── row ──────────────────────────────────────────────────────────────────

/** One blueprint's archive affordance: a button plus its own confirm dialog. */
function ArchiveBlueprintControl({
  blueprintName,
  disabled,
  onConfirm,
}: {
  blueprintName: string;
  disabled: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const handleConfirm = async (): Promise<void> => {
    setArchiving(true);
    try {
      await onConfirm();
    } finally {
      setArchiving(false);
      setOpen(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
      >
        Archive
      </Button>
      <ConfirmDialog
        open={open}
        title="Archive blueprint"
        message={`Archive "${blueprintName}"? Clerk stops running it on schedule immediately. Archiving is terminal — there is no unarchive in this version.`}
        confirmLabel="Archive"
        variant="danger"
        loading={archiving}
        onConfirm={() => void handleConfirm()}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

/**
 * One blueprint's row. `editingLocked` disables every action button on every
 * row — including this one — while any row's editor is open elsewhere, for
 * the exact reason `ContextEntryRow`'s `editingLocked` does (see that
 * component's doc comment): exactly one edit target can exist at a time, and
 * letting Run-now/Archive/the Enabled toggle fire on a DIFFERENT row while
 * one is mid-edit is no safer here than letting Edit fire would be.
 */
export function BlueprintRow({
  blueprint,
  occurrences,
  editingLocked,
  running,
  toggling,
  onEdit,
  onArchive,
  onToggleEnabled,
  onRunNow,
}: {
  blueprint: TaskBlueprint;
  /** Newest first, already capped — see `occurrencesForBlueprint`. */
  occurrences: BlueprintOccurrenceRow[];
  editingLocked: boolean;
  running: boolean;
  toggling: boolean;
  onEdit: () => void;
  onArchive: () => Promise<void>;
  onToggleEnabled: () => void;
  onRunNow: () => void;
}) {
  return (
    <li className="px-4 py-3 space-y-2" data-testid="blueprint-row">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{blueprint.name}</p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            <code className="font-mono">{blueprint.cron_schedule}</code>
            {' — '}
            {describeCronSchedule(blueprint.cron_schedule)}
            {' · '}
            {blueprint.timezone}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={blueprint.enabled}
              disabled={editingLocked || toggling}
              onChange={onToggleEnabled}
              aria-label={blueprint.enabled ? 'Disable schedule' : 'Enable schedule'}
              className="rounded border-gray-300 dark:border-gray-600 text-accent focus:ring-accent"
            />
            {blueprint.enabled ? 'Enabled' : 'Disabled'}
          </label>
          <Button
            variant="secondary"
            size="xs"
            disabled={editingLocked || running}
            onClick={onRunNow}
          >
            {running ? 'Running…' : 'Run now'}
          </Button>
          <Button variant="secondary" size="xs" disabled={editingLocked} onClick={onEdit}>
            Edit
          </Button>
          <ArchiveBlueprintControl
            blueprintName={blueprint.name}
            disabled={editingLocked}
            onConfirm={onArchive}
          />
        </div>
      </div>
      {occurrences.length > 0 && (
        <ul className="space-y-1" data-testid="blueprint-occurrences">
          {occurrences.map((occurrence) => (
            <li key={occurrence.case_id} className="text-xs flex items-center gap-1.5">
              <Badge size="xs" colorClassName={occurrence.outcome.colorClassName}>
                {occurrence.outcome.label}
              </Badge>
              <Link
                href={`/cases/${occurrence.case_id}`}
                className="font-medium text-accent-700 dark:text-accent-300 hover:underline"
              >
                {occurrence.case_id}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ─── panel ────────────────────────────────────────────────────────────────

type EditorState = { mode: 'create' } | { mode: 'edit'; blueprint: TaskBlueprint } | null;

/** Same target-scoped remount guard as `editorKey` in `clerk-context-panel.tsx` — see that function's doc comment for the regression it fixes. */
export function scheduledEditorKey(state: EditorState): string {
  return state?.mode === 'edit' ? `edit-${state.blueprint.blueprint_id}` : 'create';
}

export function ClerkScheduledPanel() {
  const { user } = useAuth();
  const { addToast } = useToast();
  const { data, mutate } = useSWR(
    blueprintsSwrKey(user?.uid),
    () => api.assistant.blueprints.list(),
  );
  // `?? []` is wrapped in its own `useMemo` (rather than inlined at the call
  // site below) so it is a STABLE reference across renders when `data` is
  // unchanged — otherwise the fallback array literal would be a new
  // reference every render, defeating `visibleBlueprints`'s own memoization.
  const blueprints = useMemo(() => data?.blueprints ?? [], [data?.blueprints]);
  // Archived blueprints stay in the route's response forever (no
  // `archived_at` filter server-side — see this file's header comment) so
  // hiding them is entirely this filter's job.
  const visibleBlueprints = useMemo(
    () => blueprints.filter((blueprint) => !blueprint.archived_at),
    [blueprints],
  );

  // Occurrence history — the same task list `ClerkAskPanel` reads, at a
  // higher limit so a blueprint's occurrences are actually findable in it
  // (see `OCCURRENCE_TASK_LIST_LIMIT`'s doc comment). The limit MUST be part
  // of the SWR key (`assistantTasksSwrKey`'s second argument) — see that
  // function's doc comment on why a shared 2-tuple key across two different
  // limits is cache bleed, not dedup, between this tab and the Ask tab.
  // `refreshInterval: 15_000` matches `ClerkAskPanel` — nothing else polls
  // this list while the Scheduled tab is open, so without it the optimistic
  // Run-now overlay below would never be superseded by the real outcome.
  const { data: tasksData, mutate: mutateTasks } = useSWR(
    assistantTasksSwrKey(user?.uid, OCCURRENCE_TASK_LIST_LIMIT),
    () => api.assistant.listTasks(OCCURRENCE_TASK_LIST_LIMIT),
    { refreshInterval: 15_000 },
  );
  const tasksByBlueprint = useMemo(
    () => groupAssistantTasksByBlueprint(tasksData?.tasks ?? []),
    [tasksData?.tasks],
  );

  const [editorState, setEditorState] = useState<EditorState>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [runningId, setRunningId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // Optimistic overlay only — a bridge to the next task-list revalidation,
  // not a permanent source of truth. See `occurrencesForBlueprint`.
  const [lastRun, setLastRun] = useState<BlueprintLastRunMap>({});

  const deps: BlueprintActionDeps = {
    create: api.assistant.blueprints.create,
    update: api.assistant.blueprints.update,
    archive: api.assistant.blueprints.archive,
  };

  async function handleSave(values: BlueprintFormValues): Promise<void> {
    setSaving(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const updated = editorState?.mode === 'edit'
        ? await updateBlueprint(deps, blueprints, editorState.blueprint.blueprint_id, values)
        : await createBlueprint(deps, blueprints, values);
      await mutate({ blueprints: updated }, { revalidate: false });
      addToast('success', editorState?.mode === 'edit' ? 'Blueprint updated' : 'Blueprint created');
      setEditorState(null);
    } catch (err) {
      setFieldErrors(blueprintFieldErrors(err));
      setFormError(err instanceof Error ? err.message : 'This blueprint could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive(blueprint: TaskBlueprint): Promise<void> {
    try {
      const updated = await archiveBlueprint(deps, blueprints, blueprint.blueprint_id);
      await mutate({ blueprints: updated }, { revalidate: false });
      addToast('success', 'Blueprint archived');
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'This blueprint could not be archived.');
    }
  }

  async function handleToggleEnabled(blueprint: TaskBlueprint): Promise<void> {
    setTogglingId(blueprint.blueprint_id);
    try {
      const updated = await updateBlueprint(deps, blueprints, blueprint.blueprint_id, {
        enabled: !blueprint.enabled,
      });
      await mutate({ blueprints: updated }, { revalidate: false });
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'This schedule could not be updated.');
    } finally {
      setTogglingId(null);
    }
  }

  async function handleRunNow(blueprint: TaskBlueprint): Promise<void> {
    setRunningId(blueprint.blueprint_id);
    const result = await runBlueprintNow(
      { runNow: api.assistant.blueprints.runNow },
      lastRun,
      blueprint.blueprint_id,
    );
    setRunningId(null);

    if (result.kind === 'error') {
      addToast('error', result.message);
      return;
    }

    setLastRun(result.lastRun);
    // Nudge the real task list to pick up the new occurrence — a freshly
    // created case is not guaranteed to appear on the very next read, so
    // this is a best-effort head start on top of `refreshInterval`, not a
    // replacement for it; the overlay set above covers the gap either way.
    void mutateTasks();
    if (result.kind === 'started') {
      addToast('success', 'Run started.');
    } else if (result.kind === 'replayed') {
      addToast('success', 'A run was already in progress for this blueprint — showing it.');
    } else {
      addToast(
        'error',
        'This blueprint already has a run in progress.',
        result.existingCaseId ? `Case ${result.existingCaseId}` : undefined,
      );
    }
  }

  return (
    <div data-testid="clerk-scheduled-panel">
      <SchedulerPausedBanner feature="blueprint_tick" className="mb-4" />
      <SectionHeader
        eyebrow
        title="Scheduled"
        description="Clerk checks each enabled blueprint on its own cron schedule. Occurrence history covers your newest 50 Clerk cases — recent, not complete."
        className="mb-4"
        actions={
          editorState === null && (
            <Button variant="primary" size="sm" onClick={() => setEditorState({ mode: 'create' })}>
              New blueprint
            </Button>
          )
        }
      />

      {editorState !== null && (
        <div className="mb-4">
          <ClerkScheduledEditor
            key={scheduledEditorKey(editorState)}
            initial={editorState.mode === 'edit'
              ? {
                name: editorState.blueprint.name,
                prompt_text: editorState.blueprint.prompt_text,
                cron_schedule: editorState.blueprint.cron_schedule,
                timezone: editorState.blueprint.timezone,
                enabled: editorState.blueprint.enabled,
              }
              : undefined}
            saving={saving}
            error={formError}
            fieldErrors={fieldErrors}
            onSave={(values) => void handleSave(values)}
            onCancel={() => {
              setEditorState(null);
              setFormError(null);
              setFieldErrors({});
            }}
          />
        </div>
      )}

      {visibleBlueprints.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="no-blueprints">
          Nothing yet. Schedule something Clerk should check on its own — for example,
          &ldquo;Every Monday at 9, summarize my team&apos;s open cases&rdquo;.
        </p>
      ) : (
        <Card as="section" padding="none" data-testid="blueprint-list">
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {visibleBlueprints.map((blueprint) => (
              <BlueprintRow
                key={blueprint.blueprint_id}
                blueprint={blueprint}
                occurrences={occurrencesForBlueprint(tasksByBlueprint, lastRun, blueprint.blueprint_id)}
                editingLocked={editorState !== null}
                running={runningId === blueprint.blueprint_id}
                toggling={togglingId === blueprint.blueprint_id}
                onEdit={() => setEditorState({ mode: 'edit', blueprint })}
                onArchive={() => handleArchive(blueprint)}
                onToggleEnabled={() => void handleToggleEnabled(blueprint)}
                onRunNow={() => void handleRunNow(blueprint)}
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
