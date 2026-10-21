import { Cron } from 'croner';
import type { Case, Run, TaskBlueprint } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';
import { AssistantIntakeService } from './assistant-intake-service.js';
import { createBlueprintOccurrence, type BlueprintOccurrenceResult } from './task-blueprint-service.js';

/**
 * The Cloud Scheduler cron tick for `TaskBlueprint` occurrences
 * (`docs/specs/clerk-config-scheduling-chat.md` Slice B, #793 v2: cron tick).
 * Route: `POST /api/blueprints/tick`, invoked every 5 minutes
 * (`scripts/setup-blueprint-scheduler.sh`), OIDC-authenticated (no user
 * token — see that route for the auth boundary).
 *
 * **Window design — stateless and deterministic, with a safety margin.**
 * This service keeps NO persisted "last tick" timestamp. Each call computes
 * its own window as `(now - (BLUEPRINT_TICK_WINDOW_MS +
 * BLUEPRINT_TICK_SAFETY_MARGIN_MS), now]`.
 *
 * The margin exists because Cloud Scheduler ticks are NOT exactly
 * `BLUEPRINT_TICK_WINDOW_MS` apart in practice — jitter, a retried attempt,
 * or a briefly slow instance all shift the actual arrival time. If the
 * lookback equaled the nominal cadence exactly, two ADJACENT ticks would
 * tile the timeline edge-to-edge only when both arrive exactly on schedule;
 * a tick arriving even slightly late opens a gap between where the previous
 * tick's window ended and where this tick's un-margined window would start —
 * any fire time landing in that gap is silently never observed, never
 * counted, and never in `errors[]` (caught nowhere, because nothing ever
 * looked for it). The margin over-covers on purpose so consecutive windows
 * always overlap rather than risk a gap.
 *
 * Overlapping windows are safe BY CONSTRUCTION, not by luck: three
 * consequences fall out of the design on purpose:
 *
 * 1. `occurrence_iso` is the COMPUTED FIRE TIME (what croner says the cron
 *    expression matched), never the tick's own arrival time (`now`). Two
 *    ticks whose windows both contain the same fire time compute the SAME
 *    `occurrence_iso` for it regardless of how far apart their `now` values
 *    are.
 * 2. The SAME `occurrence_iso` produces the SAME idempotency key
 *    (`buildBlueprintOccurrenceIdempotencyKey`) — so a duplicated tick
 *    (Cloud Scheduler's own retry) AND a merely-overlapping later tick that
 *    re-observes an already-fired occurrence both resolve to the same key.
 * 3. `AssistantIntakeService`'s receipt dedupe absorbs any of the above as a
 *    replay, never a second case — re-observing a fire time this tick
 *    already created an occurrence for is a no-op, not a bug.
 *
 * **Honest limit.** The margin covers scheduler jitter/retries/brief delays
 * up to `BLUEPRINT_TICK_SAFETY_MARGIN_MS` — it does not, and cannot, cover
 * an outage longer than `BLUEPRINT_TICK_WINDOW_MS + BLUEPRINT_TICK_SAFETY_MARGIN_MS`
 * (the service being down, or every tick in that span failing/being
 * skipped). Fire times older than that combined lookback are not looked for
 * and not backfilled — missed-run policy 'skip' (the only value in v1, see
 * `TaskBlueprintMissedRunPolicy`) is a deliberate v1 simplification (the
 * spec's non-goal list names "catch-up policies" as future work), not a
 * bug: implementing catch-up would require exactly the persisted last-tick
 * state this design avoids.
 *
 * **Occurrence creation.** Delegates to `createBlueprintOccurrence`
 * (`task-blueprint-service.ts`) — the one function `TaskBlueprintService.runNow`
 * also calls — so the overlap-'skip' re-check, the idempotency-key format,
 * and the exact `AssistantIntakeService.intake()` call shape can never drift
 * between the manual and scheduled entry points.
 *
 * **Per-blueprint isolation.** A cron-evaluation failure (e.g. a corrupted
 * `timezone` that no longer resolves — croner throws synchronously from its
 * constructor for an unrecognized IANA name) or an occurrence-creation
 * failure for one blueprint is caught, recorded in `errors`, and never stops
 * the tick from evaluating every other blueprint.
 */

// Tick cadence — must match the Cloud Scheduler job's every-5-minutes
// schedule (`scripts/setup-blueprint-scheduler.sh`).
export const BLUEPRINT_TICK_WINDOW_MS = 5 * 60 * 1000;

/**
 * Extra lookback added on top of `BLUEPRINT_TICK_WINDOW_MS` so that a tick
 * arriving late (Cloud Scheduler jitter, a retried attempt, a slow instance)
 * still re-covers whatever the previous, on-time tick's window already
 * ended at — see the class doc comment's "Window design" section for the
 * gap this closes. Deliberately generous (10 minutes — double the tick
 * cadence itself): the cost of a wider lookback is a few extra, harmless
 * re-observations of already-fired occurrences (absorbed as replays, see
 * above), while the cost of too little margin is a silently dropped
 * occurrence, which is the more expensive failure mode by far.
 */
export const BLUEPRINT_TICK_SAFETY_MARGIN_MS = 10 * 60 * 1000;

/**
 * Safety cap on fire times enumerated for a single blueprint in one tick.
 * With the 5-field cron shape `taskBlueprintCronScheduleSchema` enforces
 * (minute-level precision, no seconds field), the densest legitimate
 * schedule ("every minute") produces at most one fire time per minute of
 * lookback — comfortably under this cap even with the safety margin added.
 * This cap is pure defense against a future looser cron mode or a croner
 * bug returning a same/earlier timestamp and looping forever, not a limit
 * any real blueprint should ever approach.
 */
const MAX_FIRE_TIMES_PER_BLUEPRINT_PER_TICK = 50;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * All fire times of `cronSchedule` (evaluated in `timezone`) strictly after
 * `windowStartExclusive` and up to and including `windowEndInclusive` —
 * i.e. the half-open interval `(windowStartExclusive, windowEndInclusive]`.
 *
 * `mode: '5-part'` pins croner to the same 5-field (minute hour
 * day-of-month month day-of-week) shape `taskBlueprintCronScheduleSchema`
 * already enforces syntactically at write time — this function is the first
 * place that ever SEMANTICALLY evaluates `cron_schedule` (`TaskBlueprint`'s
 * own doc comment: "this field is inert data until that tick service
 * exists"). Pinning the mode explicitly (rather than `'auto'`) means a
 * 5-field string is never re-interpreted as anything else.
 *
 * `Cron.nextRun(prev)` returns the next fire time STRICTLY AFTER `prev`
 * (verified empirically — `nextRun` never re-returns `prev` itself even when
 * `prev` exactly matches the pattern), which is exactly the exclusive lower
 * bound this function needs: seeding the loop with `windowStartExclusive`
 * as the first `prev` cannot itself become a spurious result.
 */
export function computeDueFireTimes(
  cronSchedule: string,
  timezone: string,
  windowStartExclusive: Date,
  windowEndInclusive: Date,
): Date[] {
  const job = new Cron(cronSchedule, { timezone, mode: '5-part' });
  const fireTimes: Date[] = [];
  let cursor: Date = windowStartExclusive;
  for (let i = 0; i < MAX_FIRE_TIMES_PER_BLUEPRINT_PER_TICK; i += 1) {
    const next = job.nextRun(cursor);
    if (!next || next.getTime() > windowEndInclusive.getTime()) break;
    fireTimes.push(next);
    cursor = next;
  }
  return fireTimes;
}

/**
 * Enabled, non-archived blueprints — the tick's only candidate set.
 *
 * Filters on `enabled == true` at the query (archiving always flips
 * `enabled` to `false` in the same write — see `TaskBlueprintService.archive`),
 * then re-checks `!archived_at` in memory as a belt-and-suspenders guard
 * against exactly the drift that method's own comment warns about: a reader
 * that trusted `enabled` alone would still be correct today, but this tick
 * service is the one place a bug here would silently reanimate an archived
 * blueprint, so it checks both fields itself rather than trusting the
 * invariant to hold forever.
 */
async function listDueCandidateBlueprints(): Promise<TaskBlueprint[]> {
  const snap = await collections.taskBlueprints().where('enabled', '==', true).get();
  return snap.docs.map((doc) => doc.data()).filter((blueprint) => !blueprint.archived_at);
}

export interface BlueprintTickDispatch {
  case: Case;
  run: Run;
}

export interface BlueprintTickError {
  blueprint_id: string;
  /** Absent when the failure happened computing fire times, before any occurrence existed to name. */
  occurrence_iso?: string;
  message: string;
}

export interface BlueprintTickSummary {
  /** Total fire times found due across every evaluated blueprint, before any overlap/replay disposition. */
  due: number;
  /** Occurrences that created a new case (intake reported `replayed: false`). */
  created: number;
  /** Occurrences skipped because `overlap_policy: 'skip'` found a non-terminal prior case — no intake attempted. */
  skipped_overlap: number;
  /** Occurrences whose idempotency key already had a receipt — intake replayed the prior case rather than creating one. */
  replayed: number;
  errors: BlueprintTickError[];
  /**
   * Case+run pairs the route must fire-and-forget dispatch, mirroring
   * `TaskBlueprintService.runNow`'s route. Kept OFF the JSON the route
   * actually returns (the route destructures the counters above) — a full
   * `Case`/`Run` payload has no business leaving this process in a
   * scheduler's response body.
   */
  dispatches: BlueprintTickDispatch[];
}

export interface BlueprintTickServiceOptions {
  intakeService?: Pick<AssistantIntakeService, 'intake'>;
}

export class BlueprintTickService {
  private readonly intakeService: Pick<AssistantIntakeService, 'intake'>;

  constructor(options: BlueprintTickServiceOptions = {}) {
    this.intakeService = options.intakeService ?? new AssistantIntakeService();
  }

  /**
   * One tick. `now` is the caller's wall clock (the route passes `new
   * Date()`) — see the class doc comment for the (margin-widened) window
   * this derives from it and why that derivation needs no stored state.
   */
  async tick(now: Date): Promise<BlueprintTickSummary> {
    const windowStartExclusive = new Date(
      now.getTime() - (BLUEPRINT_TICK_WINDOW_MS + BLUEPRINT_TICK_SAFETY_MARGIN_MS),
    );
    const windowEndInclusive = now;

    const summary: BlueprintTickSummary = {
      due: 0,
      created: 0,
      skipped_overlap: 0,
      replayed: 0,
      errors: [],
      dispatches: [],
    };

    const blueprints = await listDueCandidateBlueprints();

    for (const blueprint of blueprints) {
      let fireTimes: Date[];
      try {
        fireTimes = computeDueFireTimes(
          blueprint.cron_schedule,
          blueprint.timezone,
          windowStartExclusive,
          windowEndInclusive,
        );
      } catch (err) {
        // Cron/timezone evaluation itself failed for this blueprint (e.g. a
        // timezone that no longer resolves) — nothing to attribute an
        // `occurrence_iso` to yet. Record and move to the next blueprint.
        summary.errors.push({ blueprint_id: blueprint.blueprint_id, message: errorMessage(err) });
        continue;
      }

      summary.due += fireTimes.length;

      for (const fireTime of fireTimes) {
        const occurrenceIso = fireTime.toISOString();
        try {
          this.recordOutcome(
            summary,
            await createBlueprintOccurrence(blueprint, occurrenceIso, this.intakeService),
          );
        } catch (err) {
          // A failure creating THIS occurrence (quota, transient Firestore
          // error, etc.) must not stop later fire times for this blueprint
          // or any other blueprint in the same tick.
          summary.errors.push({
            blueprint_id: blueprint.blueprint_id,
            occurrence_iso: occurrenceIso,
            message: errorMessage(err),
          });
        }
      }
    }

    return summary;
  }

  private recordOutcome(
    summary: BlueprintTickSummary,
    outcome: Awaited<ReturnType<typeof createBlueprintOccurrence>>,
  ): void {
    if (outcome.skipped) {
      summary.skipped_overlap += 1;
      return;
    }
    this.recordOccurrence(summary, outcome.occurrence);
  }

  private recordOccurrence(summary: BlueprintTickSummary, occurrence: BlueprintOccurrenceResult): void {
    if (occurrence.replayed) {
      summary.replayed += 1;
      return;
    }
    summary.created += 1;
    if (occurrence.run) {
      summary.dispatches.push({ case: occurrence.case, run: occurrence.run });
    }
  }
}
