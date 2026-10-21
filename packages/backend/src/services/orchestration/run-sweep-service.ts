import { isAssistantRunType, type Run } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';
import { FirestorePipelineAdapter } from './firestore-pipeline-adapter.js';
import type { PipelineAdapter } from './pipeline-adapter.js';
import { RunCompletionHandler, type AssistantTerminalFailureRepair } from './pipeline.js';
import { RunExecutor } from './run-executor.js';
import {
  acquireRunSweepLock,
  ASSISTANT_SWEEP_LOCK_DOC_ID,
  RunSweepLockHeldError,
  RUN_SWEEP_LOCK_TTL_MS,
} from './run-sweep-lock.js';
import { newWorkerId } from './run-worker-id.js';
import { classifyRunFailure } from './run-retry-policy.js';
import { AssistantCancellationService } from '../assistant/assistant-cancellation-service.js';

const SWEEPABLE_STATUSES: ReadonlyArray<Run['status']> = ['pending', 'running'];

/**
 * How long a `pending`/`running` run with NO `lease_expires_at` is allowed
 * to sit before the sweep treats it as stale (the "legacy" policy — see the
 * class doc below for why this cohort is very much still alive, not just a
 * pre-lease historical shim). Default 30 minutes: comfortably above any normal
 * review/rule run duration, but short enough that a genuinely stuck run gets
 * caught in tens of minutes instead of lingering for days.
 */
const LEGACY_RUN_MAX_AGE_MS = parseInt(
  process.env['ARBITRA_RUN_LEGACY_MAX_AGE_MS'] ?? '1800000',
  10,
);

/**
 * How long an assistant run may sit unclaimed (`awaiting_claim`, no lease)
 * before the assistant sub-sweep claims and dispatches it itself. Default 60
 * seconds: long enough that the creator's own in-process dispatch normally
 * wins the claim, short enough that a creator which died between writing the
 * run doc and dispatching it costs one sweep interval, not 30 minutes.
 */
const ASSISTANT_CLAIM_GRACE_MS = parseInt(
  process.env['ARBITRA_ASSISTANT_CLAIM_GRACE_MS'] ?? '60000',
  10,
);

/**
 * Max TOTAL attempts (not retries) for one assistant run chain. Deliberately
 * separate from the global `MAX_RUN_RETRIES`: an expired assistant lease is
 * recovered by starting a fresh attempt from the sub-sweep, which never goes
 * through `handleRunFailure`'s transient/permanent classification, so it needs
 * its own bound. Default 3.
 */
const ASSISTANT_MAX_ATTEMPTS = parseInt(
  process.env['ARBITRA_ASSISTANT_MAX_ATTEMPTS'] ?? '3',
  10,
);

/**
 * How long a permanently failed assistant run may carry an outstanding
 * terminal-failure repair marker before this sweep re-drives the repair itself.
 * Default 60 seconds, for the same reason as `ASSISTANT_CLAIM_GRACE_MS`: the
 * in-process repair normally lands within milliseconds, so anything still
 * marked after a minute did not land.
 */
const ASSISTANT_FAILURE_REPAIR_GRACE_MS = parseInt(
  process.env['ARBITRA_ASSISTANT_REPAIR_GRACE_MS'] ?? '60000',
  10,
);

/**
 * Bounded look-back for permanently failed assistant Runs whose repair marker
 * write itself failed. The normal marker query remains the primary path; this
 * cohort exists solely so one Firestore write failure cannot make the backstop
 * blind forever. Default seven days, capped again by query limit below.
 */
const ASSISTANT_FAILURE_REPAIR_RETENTION_MS = parseInt(
  process.env['ARBITRA_ASSISTANT_REPAIR_RETENTION_MS'] ?? '604800000',
  10,
);
const ASSISTANT_FAILURE_REPAIR_SAFETY_LIMIT = 100;

/** Grace for the owning executor to persist its cancelled trace before the sweep says unavailable. */
const ASSISTANT_CANCEL_RECONCILE_GRACE_MS = parseInt(
  process.env['ARBITRA_ASSISTANT_CANCEL_RECONCILE_GRACE_MS'] ?? '60000',
  10,
);

export type StaleRunReason = 'lease_expired' | 'legacy_no_lease_stale';

export interface StaleRunEntry {
  run: Run;
  reason: StaleRunReason;
}

export interface SweptRunSummary {
  run_id: string;
  case_id: string;
  run_type: string;
  reason: StaleRunReason;
}

export interface DispatchedRetrySummary {
  run_id: string;
  case_id: string;
  run_type: string;
}

/** An assistant run this sweep claimed and dispatched because nobody else did. */
export interface AssistantClaimSummary {
  run_id: string;
  case_id: string;
  run_type: string;
  attempt: number;
}

/** An expired assistant lease this sweep replaced with a fresh attempt. */
export interface AssistantReattemptSummary {
  /** The run whose lease expired — now `failed`. */
  run_id: string;
  case_id: string;
  run_type: string;
  /** Attempt number of the failed run. */
  attempt: number;
  /** The freshly created replacement run. */
  next_run_id: string;
  next_attempt: number;
  /** False if the replacement was created but this sweep could not claim/dispatch it (a later pass will). */
  dispatched: boolean;
}

/**
 * A permanently failed assistant run whose case-side repair this sweep
 * re-drove because the in-process attempt did not finish it.
 */
export interface AssistantFailureRepairSummary {
  run_id: string;
  case_id: string;
  run_type: string;
  attempt: number;
}

export interface AssistantCancellationReconcileSummary {
  run_id: string;
  case_id: string;
  run_type: string;
  attempt: number;
}

/** An expired assistant lease that exhausted the assistant attempt cap. */
export interface AssistantExhaustedSummary {
  run_id: string;
  case_id: string;
  run_type: string;
  attempt: number;
  max_attempts: number;
}

/**
 * Counters for the assistant sub-sweep, reported separately from the stale-run
 * counters because the two passes hold different locks and can succeed or be
 * locked out independently.
 */
export interface AssistantSweepResult {
  /** Unclaimed assistant runs this sweep claimed and dispatched. */
  claimed: AssistantClaimSummary[];
  /** Expired assistant leases replaced by a fresh attempt (cap still allowed one). */
  reattempted: AssistantReattemptSummary[];
  /** Expired assistant leases that hit the assistant attempt cap — terminal. */
  exhausted: AssistantExhaustedSummary[];
  /**
   * Permanently failed assistant runs whose case-side repair this sweep
   * re-drove to completion: the case is now terminal and the marker is gone.
   */
  failures_repaired: AssistantFailureRepairSummary[];
  /**
   * Selected runs whose repair did NOT land — the write failed, or the case is
   * still non-terminal after the re-evaluation. Their markers stay set, so the
   * next pass retries them. Reported separately because a backstop that keeps
   * failing must not read as a successful repair on every pass; this is the
   * operator-visible signal that a case is stuck.
   */
  failures_outstanding: AssistantFailureRepairSummary[];
  /** Cancelled Runs whose orphaned trace marker was settled as unavailable. */
  cancellations_reconciled: AssistantCancellationReconcileSummary[];
  /** Selected cancellation markers whose reconciliation write failed. */
  cancellations_outstanding: AssistantCancellationReconcileSummary[];
  /**
   * Unclaimed runs this sweep did NOT dispatch: another worker won the claim
   * first (the normal case — the creator's own dispatch got there), or the
   * dispatch attempt itself errored. Not an error; an observability counter.
   */
  skipped_claimed: number;
  /**
   * Expired-lease runs that had already legitimately resolved by the time the
   * transactional fail call re-read them — same race guard, and same meaning,
   * as `RunSweepResult.skipped_completed`.
   */
  skipped_completed: number;
  /** True when another assistant sub-sweep held the assistant lock — this pass no-op'd cleanly. */
  skipped_locked: boolean;
}

export interface RunSweepResult {
  swept: SweptRunSummary[];
  /**
   * Count of runs the sweep's QUERY flagged as stale but which had already
   * legitimately completed/failed by the time the transactional fail call
   * ran — the race `failRunIfStillStale` exists to close (PR #742).
   * Not an error; just an observability counter.
   */
  skipped_completed: number;
  /** Durable-retry backstop: overdue persisted retries this sweep dispatched. */
  retries_dispatched: DispatchedRetrySummary[];
  /** True when another sweep already held the single-flight lock — this call no-op'd cleanly. */
  skipped_locked: boolean;
  /**
   * Assistant sub-sweep counters. Its own critical section under its own lock
   * key, so it still runs when the stale-run pass above was locked out (and
   * vice versa) — see `sweepAssistantRuns`.
   */
  assistant: AssistantSweepResult;
}

/**
 * Adapter shape `RunSweepService` actually requires — narrows the two
 * transactional operations used by assistant/stale recovery to mandatory so
 * a caller can't silently fall back to racy unconditional writes.
 */
export type RunSweepAdapter = PipelineAdapter & Required<Pick<
  PipelineAdapter,
  'cancelUnclaimedAssistantReattempt' | 'failRunIfStillStale'
>>;

/**
 * Finds and fails `pending`/`running` runs that have gone orphaned — the
 * worker that was supposed to be executing them died mid-flight (deploy
 * rollout, scale-to-zero, OOM) and nothing will ever mark them
 * `completed`/`failed` on its own. Two independent stale cohorts:
 *
 * 1. **Lease-expired** — the run has a `lease_expires_at` (stamped by
 *    `FirestorePipelineAdapter.createRun`, refreshed by `RunExecutor`'s
 *    heartbeat) and it's in the past. Definitive: nobody is renewing it.
 *
 * 2. **Legacy / no lease** — the run has NO `lease_expires_at` at all. This
 *    is NOT just a pre-lease historical shim: `ReviewService.runReview` writes
 *    its run doc directly (`collections.runs().doc(runId).set(...)`,
 *    bypassing `FirestorePipelineAdapter.createRun`) and does not stamp a
 *    lease, so **every review_run falls in this cohort**. Since
 *    review runs are exactly the type that can leave a case sitting in
 *    `in_review` (issue #710), this fallback policy is the PRIMARY detector
 *    for the motivating failure, not a legacy corner case.
 *    Policy: stale once `started_at` (falling back to `created_at`) is older
 *    than `ARBITRA_RUN_LEGACY_MAX_AGE_MS` (default 30 min).
 *
 * Firestore can't query "field does not exist" directly, so cohort 2 is
 * found by fetching the (small, bounded-by-concurrency) set of all
 * `pending`/`running` runs and filtering client-side for the ones with no
 * `lease_expires_at` — cohort 1 uses an indexed server-side range query
 * (`firestore.indexes.json`: `runs` by `status` + `lease_expires_at`) since
 * that's the hot, frequently-hit path.
 *
 * A run flagged stale by the query above is NOT unconditionally failed
 * (PR #742): between the query snapshot and the
 * fail call, the run can legitimately complete (a 30-minute cohort-2 review
 * can still be mid-flight; a merely-starved — not dead — heartbeat can let
 * cohort-1's lease check fire on a live run). `failRunIfStillStale` re-reads
 * the run inside a transaction and only writes `failed` if the staleness
 * condition STILL holds; otherwise this sweep counts it under
 * `skipped_completed` and leaves it alone.
 *
 * Each run this sweep actually fails gets an explicit `run_failed` event (so
 * the sweep is visible in the case timeline), is handed to
 * `RunCompletionHandler.handleRunFailure` (retry decision), and then
 * triggers `onRunCompleted` so the pipeline re-evaluates the case. The sweep
 * ALSO dispatches overdue durable retries — see
 * `findOverdueRetries`. Both passes run inside a single-flight Firestore
 * lock (`run-sweep-lock.ts`) so overlapping Cloud Scheduler retries can't
 * double-sweep.
 *
 * **Assistant sub-sweep.** Assistant runs (`assistant_task_run`,
 * `assistant_action_run`) are recovered by a separate pass, `sweepAssistantRuns`,
 * reached from the same `sweep()` entrypoint — i.e. the same
 * `/api/runs/sweep` route on the same schedule, no second Scheduler job. It is
 * separate rather than folded into the cohorts above because its recovery
 * verdict is different in both directions:
 *
 * - an UNCLAIMED assistant run (`awaiting_claim`, no lease — created via
 *   `createUnclaimedRun`) must be CLAIMED AND DISPATCHED, not failed. It is
 *   explicitly excluded from cohort 2, which would otherwise fail it after 30
 *   minutes purely for having no lease;
 * - an EXPIRED assistant lease starts a FRESH ATTEMPT while
 *   `ARBITRA_ASSISTANT_MAX_ATTEMPTS` allows, and only becomes terminal once
 *   that cap is spent. Assistant runs are therefore excluded from cohort 1
 *   too — otherwise both passes would race for the same run and this one's
 *   unconditional terminal fail would win.
 *
 * Neither exclusion changes anything for the six pre-existing run types: no
 * run created via `createRun` ever carries `awaiting_claim`, and assistant runs
 * had no reachable executor before this workstream, so no such run has ever
 * been swept. The assistant pass holds its OWN lock key
 * (`ASSISTANT_SWEEP_LOCK_DOC_ID`) so a long stale-run sweep cannot starve
 * assistant recovery.
 */
export class RunSweepService {
  constructor(
    private readonly adapter: RunSweepAdapter = new FirestorePipelineAdapter(),
    private readonly pipeline: RunCompletionHandler = new RunCompletionHandler(adapter),
    private readonly executor: RunExecutor = new RunExecutor(adapter, pipeline),
    private readonly cancellationService: Pick<AssistantCancellationService, 'reconcile'> =
      new AssistantCancellationService(),
  ) {}

  /**
   * Run both sweeps. They are independent critical sections under separate
   * lock keys, so one being locked out (or finding nothing) never suppresses
   * the other; `skipped_locked` is reported per pass.
   */
  async sweep(now: Date = new Date()): Promise<RunSweepResult> {
    const staleRuns = await this.sweepStaleRuns(now);
    const assistant = await this.sweepAssistantRuns(now);
    return { ...staleRuns, assistant };
  }

  /** The original stale-run + overdue-retry sweep. Behaviour unchanged. */
  private async sweepStaleRuns(now: Date): Promise<Omit<RunSweepResult, 'assistant'>> {
    let lock;
    try {
      lock = await acquireRunSweepLock(now);
    } catch (err) {
      if (err instanceof RunSweepLockHeldError) {
        return { swept: [], skipped_completed: 0, retries_dispatched: [], skipped_locked: true };
      }
      throw err;
    }

    try {
      const stale = await this.findStaleRuns(now);
      const swept: SweptRunSummary[] = [];
      let skippedCompleted = 0;
      for (const { run, reason } of stale) {
        const outcome = await this.sweepOne(run, reason, now);
        if (outcome === 'swept') {
          swept.push({ run_id: run.run_id, case_id: run.case_id, run_type: run.run_type, reason });
        } else {
          skippedCompleted++;
        }
      }

      const overdueRetries = await this.findOverdueRetries(now);
      const retriesDispatched: DispatchedRetrySummary[] = [];
      for (const run of overdueRetries) {
        const outcome = await this.pipeline.dispatchScheduledRetry(run).catch((err) => {
          console.error(`[RunSweepService] dispatchScheduledRetry failed for run ${run.run_id}:`, err);
          return 'already_claimed' as const;
        });
        if (outcome === 'dispatched') {
          retriesDispatched.push({ run_id: run.run_id, case_id: run.case_id, run_type: run.run_type });
        }
      }

      return {
        swept,
        skipped_completed: skippedCompleted,
        retries_dispatched: retriesDispatched,
        skipped_locked: false,
      };
    } finally {
      await lock.release().catch((err) => {
        console.warn('[RunSweepService] Failed to release sweep lock:', err);
      });
    }
  }

  /**
   * Exposed for unit testing the selection logic in isolation from the
   * lock/sweep-execution machinery.
   */
  async findStaleRuns(now: Date = new Date()): Promise<StaleRunEntry[]> {
    const nowIso = now.toISOString();
    const byRunId = new Map<string, StaleRunEntry>();

    // Cohort 1: has a lease, and it's expired. Indexed composite query.
    const leaseExpiredSnap = await collections
      .runs()
      .where('status', 'in', SWEEPABLE_STATUSES)
      .where('lease_expires_at', '<', nowIso)
      .get();
    for (const doc of leaseExpiredSnap.docs) {
      const run = doc.data();
      // Assistant runs are recovered by `sweepAssistantRuns` instead, which
      // starts a fresh attempt under the assistant cap rather than failing the
      // run outright. Leaving them here as well would let this pass's terminal
      // fail win the race against that recovery.
      if (isAssistantRunType(run.run_type)) continue;
      byRunId.set(run.run_id, { run, reason: 'lease_expired' });
    }

    // Cohort 2: no lease at all — Firestore has no "field missing" query, so
    // fetch the (bounded) active set and filter client-side.
    const legacyThresholdIso = new Date(now.getTime() - LEGACY_RUN_MAX_AGE_MS).toISOString();
    const activeSnap = await collections
      .runs()
      .where('status', 'in', SWEEPABLE_STATUSES)
      .get();
    for (const doc of activeSnap.docs) {
      const run = doc.data();
      if (byRunId.has(run.run_id)) continue; // already captured by cohort 1
      // Lease-less BY DESIGN, not by omission: `createUnclaimedRun` writes the
      // run doc with no lease on purpose and stamps `awaiting_claim` to say so,
      // because ownership is assigned later by `claimRun`. This cohort's whole
      // premise — "no lease means nobody is renewing one, so nothing will ever
      // finish this run" — is false for those runs; `sweepAssistantRuns` claims
      // and dispatches them instead. Runs created via `createRun` never carry
      // the flag, so the legacy policy below is unchanged for every other type.
      if (run.awaiting_claim) continue;
      if (run.lease_expires_at) continue; // has a (not-yet-expired) lease — not stale
      const referenceTime = run.started_at ?? run.created_at;
      if (referenceTime && referenceTime < legacyThresholdIso) {
        byRunId.set(run.run_id, { run, reason: 'legacy_no_lease_stale' });
      }
    }

    return [...byRunId.values()];
  }

  /**
   * Durable-retry backstop: `failed` runs with a persisted
   * `retry_at` in the past that nobody has dispatched yet (`retry_dispatched`
   * unset) — the in-process `setTimeout` that was supposed to fire it never
   * did, most likely because the instance that scheduled it died first.
   * Exposed for unit testing in isolation.
   */
  async findOverdueRetries(now: Date = new Date()): Promise<Run[]> {
    const nowIso = now.toISOString();
    const snap = await collections
      .runs()
      .where('status', '==', 'failed')
      .where('retry_at', '<=', nowIso)
      .get();
    return snap.docs.map((d) => d.data()).filter((run) => !run.retry_dispatched);
  }

  /**
   * Assistant runs still waiting for an owner: `awaiting_claim` set, no lease,
   * no `worker_id`, and created more than `ARBITRA_ASSISTANT_CLAIM_GRACE_MS`
   * ago. The grace period is what keeps this pass from stealing runs out from
   * under a creator that is about to dispatch them itself.
   *
   * A single equality filter carries the query: `awaiting_claim` exists only
   * while a run waits to be claimed (`claimRun` deletes it), so the result set
   * is small and no composite index is needed. Status/type/lease are filtered
   * client-side. Exposed for unit testing the selection logic in isolation.
   */
  async findUnclaimedAssistantRuns(now: Date = new Date()): Promise<Run[]> {
    const graceThresholdIso = new Date(now.getTime() - ASSISTANT_CLAIM_GRACE_MS).toISOString();
    const snap = await collections.runs().where('awaiting_claim', '==', true).get();
    return snap.docs
      .map((d) => d.data())
      .filter(
        (run) =>
          run.status === 'pending'
          && isAssistantRunType(run.run_type)
          // Belt and braces: a run carrying BOTH the flag and an owner is
          // malformed, and claiming it would be exactly the double-execution
          // this pass exists to avoid.
          && !run.lease_expires_at
          && !run.worker_id
          // An unclaimed run has no `started_at` — `claimRun` stamps that at
          // claim time — so its age is measured from creation.
          && run.created_at <= graceThresholdIso,
      );
  }

  /**
   * Permanently failed assistant runs still carrying
   * `assistant_failure_repair_pending` — the in-process repair in
   * `RunCompletionHandler.documentAssistantTerminalFailure` either threw
   * (it is best-effort by contract) or the instance died mid-repair, and the
   * case is sitting in `open`/`in_build` with no reachable transition.
   *
   * The marker equality query is the primary path. A second, bounded cohort
   * covers the one failure the marker alone cannot represent: the marker write
   * itself failed after the Run was already durably failed. It looks back over
   * recent failed Runs only, excludes a durable settled tombstone, accepts only
   * assistant Runs with a permanent classification, and is capped at 100.
   *
   * The grace period keeps this pass from racing the in-process repair, which
   * normally completes within milliseconds of the marker being written. Age is
   * measured from `finished_at` (when the run was failed) so a marker whose
   * repair keeps failing is retried on every subsequent pass rather than once.
   *
   * Deliberately queries RUNS, not cases: a case-side query for "assistant
   * cases with no way forward" has no single-field shape and would need a new
   * composite index plus a status/type/context predicate the sweeper has no
   * business owning.
   */
  async findAssistantFailureRepairs(now: Date = new Date()): Promise<Run[]> {
    const graceThresholdIso = new Date(
      now.getTime() - ASSISTANT_FAILURE_REPAIR_GRACE_MS,
    ).toISOString();
    const retentionThresholdIso = new Date(
      now.getTime() - ASSISTANT_FAILURE_REPAIR_RETENTION_MS,
    ).toISOString();
    const [markedSnap, safetyNetSnap] = await Promise.all([
      collections.runs().where('assistant_failure_repair_pending', '==', true).get(),
      collections
        .runs()
        .where('status', '==', 'failed')
        .where('finished_at', '>=', retentionThresholdIso)
        .where('finished_at', '<=', graceThresholdIso)
        .orderBy('finished_at', 'desc')
        .limit(ASSISTANT_FAILURE_REPAIR_SAFETY_LIMIT)
        .get(),
    ]);

    const candidates = new Map<string, Run>();
    for (const doc of [...markedSnap.docs, ...safetyNetSnap.docs]) {
      const run = doc.data();
      candidates.set(run.run_id, run);
    }
    return [...candidates.values()].filter((run) => {
      if (
        run.status !== 'failed'
        || !isAssistantRunType(run.run_type)
        || (run.finished_at ?? run.updated_at ?? run.created_at) > graceThresholdIso
      ) {
        return false;
      }
      if (run.assistant_failure_repair_pending === true) return true;
      return !run.assistant_failure_repair_settled_at
        && classifyRunFailure(run.error_message) === 'permanent';
    });
  }

  /**
   * Cancelled attempts whose owning process never attached its in-memory trace.
   * After the grace period the only honest durable statement is unavailable;
   * the marker remains until that receipt and its event commit together.
   */
  async findAssistantCancellationRepairs(now: Date = new Date()): Promise<Run[]> {
    const graceThresholdIso = new Date(
      now.getTime() - ASSISTANT_CANCEL_RECONCILE_GRACE_MS,
    ).toISOString();
    const snap = await collections
      .runs()
      .where('assistant_cancel_reconcile_pending', '==', true)
      .get();
    return snap.docs
      .map((doc) => doc.data())
      .filter(
        (run) =>
          run.status === 'cancelled'
          && run.run_type === 'assistant_task_run'
          && run.assistant_cancel_intent !== undefined
          && (run.finished_at ?? run.updated_at ?? run.created_at) <= graceThresholdIso,
      );
  }

  /**
   * Assistant runs whose lease has lapsed. Same indexed query as cohort 1 of
   * `findStaleRuns`, filtered to the run types that cohort deliberately skips.
   * Exposed for unit testing the selection logic in isolation.
   */
  async findExpiredAssistantLeases(now: Date = new Date()): Promise<Run[]> {
    const nowIso = now.toISOString();
    const snap = await collections
      .runs()
      .where('status', 'in', SWEEPABLE_STATUSES)
      .where('lease_expires_at', '<', nowIso)
      .get();
    return snap.docs.map((d) => d.data()).filter((run) => isAssistantRunType(run.run_type));
  }

  /**
   * Recover assistant runs. Own critical section under
   * `ASSISTANT_SWEEP_LOCK_DOC_ID`, so a stale-run sweep holding `run:sweep` for
   * its full TTL cannot starve this pass (and vice versa).
   *
   * Four passes, all additive to anything the stale-run sweep does:
   *
   * 1. **Unclaimed** — claim and dispatch runs nobody picked up (see
   *    `findUnclaimedAssistantRuns`). The claim is what makes this safe to run
   *    concurrently with the creator's own dispatch: only one side can win.
   * 2. **Expired lease** — fail the lapsed attempt and start a fresh one while
   *    `ASSISTANT_MAX_ATTEMPTS` allows, otherwise emit `run_retries_exhausted`
   *    and let the pipeline re-evaluate the case (which is what moves an
   *    `assistant_task` case to its documented-hold status).
   * 3. **Outstanding terminal-failure repair** — re-drive the case-side
   *    documentation for a permanently failed run that still carries
   *    `assistant_failure_repair_pending` (see `findAssistantFailureRepairs`).
   *    The in-process repair is best-effort by contract, and a case whose repair
   *    was swallowed has no reachable transition at all.
   * 4. **Outstanding cancellation reconciliation** — after the owning executor's
   *    grace period, settle a durable cancellation marker with an honest
   *    unavailable trace/usage receipt. This closes the audit handshake after an
   *    instance dies without weakening the already-committed cancellation fence.
   *
   * Deliberately does NOT route these failures through
   * `RunCompletionHandler.handleRunFailure`. That path would classify "lease
   * expired" as transient and schedule its own retry under the GLOBAL
   * `MAX_RUN_RETRIES` — on top of the fresh attempt started here, i.e. two
   * live workers for one lapsed run, and a bound that is not the assistant cap.
   * The assistant cap owns this decision end to end; global retry behaviour is
   * untouched.
   */
  private async sweepAssistantRuns(now: Date): Promise<AssistantSweepResult> {
    const empty: AssistantSweepResult = {
      claimed: [],
      reattempted: [],
      exhausted: [],
      failures_repaired: [],
      failures_outstanding: [],
      cancellations_reconciled: [],
      cancellations_outstanding: [],
      skipped_claimed: 0,
      skipped_completed: 0,
      skipped_locked: false,
    };

    // No silent degradation to a non-atomic claim: without both methods the
    // only safe action is none at all, and an operator needs to see why.
    if (!this.adapter.claimRun || !this.adapter.createUnclaimedRun) {
      console.warn(
        '[RunSweepService] Adapter implements neither claimRun nor createUnclaimedRun — assistant recovery skipped.',
      );
      return empty;
    }

    let lock;
    try {
      lock = await acquireRunSweepLock(now, RUN_SWEEP_LOCK_TTL_MS, ASSISTANT_SWEEP_LOCK_DOC_ID);
    } catch (err) {
      if (err instanceof RunSweepLockHeldError) {
        return { ...empty, skipped_locked: true };
      }
      throw err;
    }

    try {
      const claimed: AssistantClaimSummary[] = [];
      let skippedClaimed = 0;

      for (const run of await this.findUnclaimedAssistantRuns(now)) {
        try {
          const dispatched = await this.claimAndDispatch(run);
          if (dispatched) {
            claimed.push({
              run_id: dispatched.run_id,
              case_id: dispatched.case_id,
              run_type: dispatched.run_type,
              attempt: dispatched.attempt ?? 1,
            });
          } else {
            skippedClaimed++;
          }
        } catch (err) {
          console.error(`[RunSweepService] Failed to claim/dispatch assistant run ${run.run_id}:`, err);
          skippedClaimed++;
        }
      }

      const reattempted: AssistantReattemptSummary[] = [];
      const exhausted: AssistantExhaustedSummary[] = [];
      let skippedCompleted = 0;

      for (const run of await this.findExpiredAssistantLeases(now)) {
        const outcome = await this.recoverExpiredAssistantLease(run, now);
        if (outcome.kind === 'reattempted') reattempted.push(outcome.summary);
        else if (outcome.kind === 'exhausted') exhausted.push(outcome.summary);
        else skippedCompleted++;
      }

      const failuresRepaired: AssistantFailureRepairSummary[] = [];
      const failuresOutstanding: AssistantFailureRepairSummary[] = [];
      for (const run of await this.findAssistantFailureRepairs(now)) {
        const outcome = await this.repairAssistantTerminalFailure(run);
        if (outcome === 'abandoned') continue;
        const summary: AssistantFailureRepairSummary = {
          run_id: run.run_id,
          case_id: run.case_id,
          run_type: run.run_type,
          attempt: run.attempt ?? 1,
        };
        if (outcome === 'repaired') failuresRepaired.push(summary);
        else failuresOutstanding.push(summary);
      }

      const cancellationsReconciled: AssistantCancellationReconcileSummary[] = [];
      const cancellationsOutstanding: AssistantCancellationReconcileSummary[] = [];
      for (const run of await this.findAssistantCancellationRepairs(now)) {
        const summary: AssistantCancellationReconcileSummary = {
          run_id: run.run_id,
          case_id: run.case_id,
          run_type: run.run_type,
          attempt: run.attempt ?? 1,
        };
        try {
          await this.cancellationService.reconcile({
            runId: run.run_id,
            reconciledBy: 'assistant_sweeper',
            usageStatus: 'unavailable',
            traceStatus: 'unavailable',
          });
          cancellationsReconciled.push(summary);
        } catch (err) {
          console.error(
            `[RunSweepService] Failed to reconcile cancelled assistant run ${run.run_id}:`,
            err,
          );
          cancellationsOutstanding.push(summary);
        }
      }

      return {
        claimed,
        reattempted,
        exhausted,
        failures_repaired: failuresRepaired,
        failures_outstanding: failuresOutstanding,
        cancellations_reconciled: cancellationsReconciled,
        cancellations_outstanding: cancellationsOutstanding,
        skipped_claimed: skippedClaimed,
        skipped_completed: skippedCompleted,
        skipped_locked: false,
      };
    } finally {
      await lock.release().catch((err) => {
        console.warn('[RunSweepService] Failed to release assistant sweep lock:', err);
      });
    }
  }

  /**
   * Win the claim on an unclaimed run and hand it to the executor. Returns the
   * post-claim run doc, or `null` when another worker got there first — the
   * normal, expected outcome whenever the creator's own dispatch is racing this
   * sweep, and not an error.
   *
   * The dispatched doc is the one `claimRun` returned, never the pre-claim doc
   * this was called with, so the executor's heartbeat has the `worker_id` that
   * actually holds the lease.
   */
  private async claimAndDispatch(run: Run): Promise<Run | null> {
    const { claimed, run: claimedRun } = await this.adapter.claimRun!(run.run_id, newWorkerId());
    if (!claimed || !claimedRun) {
      console.info(
        `[RunSweepService] Assistant run ${run.run_id} (case ${run.case_id}) was claimed by another worker — skipping.`,
      );
      return null;
    }
    const case_ = await this.adapter.getCase(run.case_id);
    this.executor.dispatch(claimedRun, case_);
    return claimedRun;
  }

  /**
   * Re-drive the case-side documentation of a permanently failed assistant run
   * and let the pipeline act on it.
   *
   * The documentation is idempotent (a case that already carries both halves of
   * this verdict is left alone), so running it again after a partially applied
   * repair is safe. `onRunCompleted` follows because the repair's whole purpose
   * is to make a transition available, and unlike the in-process path there is
   * no executor here to call it afterwards.
   *
   * The verdict is only reported as `repaired` when the case is actually
   * terminal afterwards — the same observation that discharges the run's marker.
   * `documentAssistantTerminalFailure` is best-effort by contract and returns
   * rather than throws on a failed write, so "did not throw" would report a
   * permanently failing backstop as a success on every pass.
   */
  private async repairAssistantTerminalFailure(
    run: Run,
  ): Promise<'repaired' | 'abandoned' | 'outstanding'> {
    let outcome: AssistantTerminalFailureRepair;
    try {
      outcome = await this.pipeline.documentAssistantTerminalFailure(run);
    } catch (err) {
      console.error(
        `[RunSweepService] Failed to re-drive the terminal-failure repair for assistant run ${run.run_id}:`,
        err,
      );
      return 'outstanding';
    }

    // The case is gone — nothing to repair, and nothing to keep selecting.
    if (outcome === 'abandoned') return 'abandoned';
    // Already terminal: the failure produced its outcome, the marker is gone.
    if (outcome === 'settled') return 'repaired';
    if (outcome === 'failed') {
      console.error(
        `[RunSweepService] Terminal-failure repair for assistant run ${run.run_id} (case ${run.case_id}) did not land — its marker stays set for the next pass.`,
      );
      return 'outstanding';
    }

    await this.pipeline.onRunCompleted(run.case_id).catch((err) => {
      console.error(
        `[RunSweepService] onRunCompleted failed for case ${run.case_id} after repairing assistant run ${run.run_id}:`,
        err,
      );
    });

    const settled = await this.pipeline
      .settleAssistantFailureRepair(run)
      .catch((err) => {
        console.error(
          `[RunSweepService] Failed to settle the terminal-failure repair for assistant run ${run.run_id}:`,
          err,
        );
        return false;
      });
    if (!settled) {
      console.error(
        `[RunSweepService] Case ${run.case_id} is still non-terminal after re-driving the terminal-failure repair for assistant run ${run.run_id} — its marker stays set for the next pass.`,
      );
    }
    return settled ? 'repaired' : 'outstanding';
  }

  /**
   * Fail one lapsed assistant attempt and decide what follows: a fresh attempt
   * while the assistant cap allows, otherwise a terminal outcome.
   *
   * The lapsed attempt is failed through `failRunIfStillStale`, so a run whose
   * heartbeat was merely starved (and which completed between the query and
   * this call) is left alone instead of being clobbered — the same race guard
   * the stale-run sweep uses, for the same reason.
   */
  private async recoverExpiredAssistantLease(
    run: Run,
    now: Date,
  ): Promise<
    | { kind: 'reattempted'; summary: AssistantReattemptSummary }
    | { kind: 'exhausted'; summary: AssistantExhaustedSummary }
    | { kind: 'skipped_completed' }
  > {
    const attempt = run.attempt ?? 1;
    const nextAttempt = attempt + 1;
    const capAllows = nextAttempt <= ASSISTANT_MAX_ATTEMPTS;
    const message = capAllows
      ? `Assistant run lease expired (worker likely terminated mid-execution) — starting attempt ${nextAttempt} of ${ASSISTANT_MAX_ATTEMPTS} (assistant sub-sweep)`
      : `Assistant run lease expired after attempt ${attempt} of ${ASSISTANT_MAX_ATTEMPTS} allowed attempts — no further attempts (assistant sub-sweep)`;

    // Create the replacement BEFORE making the expired run invisible to the
    // pending/running queries. If creation throws, the old run remains stale
    // and a later sweep retries it. If this process dies after creation, the
    // unclaimed replacement is already durable and the claim sweep recovers
    // it; the adapter's deterministic attempt key makes a re-drive return that
    // same replacement rather than creating a duplicate.
    let replacement = capAllows && this.adapter.prepareAssistantReattempt
      ? await this.adapter.prepareAssistantReattempt(
          run.case_id,
          run.run_type,
          run.trigger_source,
          nextAttempt,
        )
      : null;

    const { failed, run: freshRun } = await this.adapter.failRunIfStillStale(
      run.run_id,
      run.case_id,
      message,
      this.buildStillStaleCheck('lease_expired', now),
    );
    if (!failed) {
      let replacementNote = '';
      if (replacement) {
        const cancellation = await this.adapter.cancelUnclaimedAssistantReattempt(
          replacement.run_id,
          `Cancelled unused assistant attempt ${nextAttempt}: predecessor ${run.run_id} resolved before lease recovery completed`,
        );
        if (cancellation.cancelled) {
          replacementNote = `, replacement=${replacement.run_id} cancelled before claim`;
        } else {
          const current = cancellation.run;
          const claimed = current?.status === 'running' || !!current?.worker_id || !!current?.lease_expires_at;
          replacementNote = claimed
            ? `, replacement=${replacement.run_id} was already claimed concurrently and was left alone (status=${current?.status ?? 'unknown'}, worker=${current?.worker_id ?? 'unknown'})`
            : `, replacement=${replacement.run_id} could not be cancelled and was left alone (status=${current?.status ?? 'missing'})`;
        }
      }
      console.info(
        `[RunSweepService] Assistant run ${run.run_id} (case ${run.case_id}) resolved on its own before the assistant sub-sweep could fail it — skipping (status=${freshRun?.status ?? 'unknown'}${replacementNote}).`,
      );
      return { kind: 'skipped_completed' };
    }

    await this.adapter
      .emitEvent(
        run.case_id,
        'run_failed',
        {
          run_id: run.run_id,
          run_type: run.run_type,
          error: message,
          swept: true,
          sweep_reason: 'assistant_lease_expired',
          attempt,
          max_attempts: ASSISTANT_MAX_ATTEMPTS,
        },
        'system:assistant-sweeper',
      )
      .catch((err) => {
        console.error(`[RunSweepService] Failed to emit run_failed for assistant run ${run.run_id}:`, err);
      });

    if (!capAllows) {
      // Terminal. Clerk has no clarification/resume channel: an exhausted
      // ladder is documented through the same durable repair marker and
      // `failed_permanently` verdict as every other final assistant failure.
      // That makes `rejected` the one honest, slot-releasing outcome.
      const failedRun = freshRun ?? {
        ...run,
        status: 'failed' as const,
        error_message: message,
      };
      await this.pipeline.documentAssistantTerminalFailure(failedRun, 'retry_exhausted');

      await this.pipeline.onRunCompleted(run.case_id).catch((err) => {
        console.error(
          `[RunSweepService] onRunCompleted failed for case ${run.case_id} after exhausting assistant run ${run.run_id}:`,
          err,
        );
      });
      await this.pipeline.settleAssistantFailureRepair(failedRun).catch((err) => {
        console.error(
          `[RunSweepService] Failed to settle terminal-failure repair for exhausted assistant run ${run.run_id}:`,
          err,
        );
      });

      return {
        kind: 'exhausted',
        summary: {
          run_id: run.run_id,
          case_id: run.case_id,
          run_type: run.run_type,
          attempt,
          max_attempts: ASSISTANT_MAX_ATTEMPTS,
        },
      };
    }

    // Compatibility fallback for adapters that predate the durable ordering.
    // The production Firestore adapter always prepared the replacement above.
    replacement ??= await this.adapter.createUnclaimedRun!(
      run.case_id,
      run.run_type,
      run.trigger_source,
      nextAttempt,
    );

    // Fresh attempt. In production it was created UNCLAIMED before the old
    // attempt was failed, so every crash point leaves a sweep-visible run.
    const dispatched = await this.claimAndDispatch(replacement).catch((err) => {
      console.error(
        `[RunSweepService] Created replacement assistant run ${replacement.run_id} but could not dispatch it:`,
        err,
      );
      return null;
    });

    // No `onRunCompleted` here: a fresh attempt is already active, so a
    // re-evaluation would only hit the pipeline's `alreadyRunning` guard.
    return {
      kind: 'reattempted',
      summary: {
        run_id: run.run_id,
        case_id: run.case_id,
        run_type: run.run_type,
        attempt,
        next_run_id: replacement.run_id,
        next_attempt: nextAttempt,
        dispatched: dispatched !== null,
      },
    };
  }

  /**
   * Build the staleness re-check passed into `failRunIfStillStale`. Always
   * evaluated against a FRESH read of the run doc at transaction-commit
   * time, so a lease refreshed (or a run completed) between the query
   * snapshot and this call is correctly detected as no-longer-stale.
   */
  private buildStillStaleCheck(reason: StaleRunReason, now: Date): (run: Run) => boolean {
    const nowIso = now.toISOString();
    if (reason === 'lease_expired') {
      return (run: Run): boolean => !!run.lease_expires_at && run.lease_expires_at < nowIso;
    }
    const legacyThresholdIso = new Date(now.getTime() - LEGACY_RUN_MAX_AGE_MS).toISOString();
    return (run: Run): boolean => {
      if (run.lease_expires_at) return false; // gained a lease somehow — no longer this cohort
      // Same exclusion as the cohort-2 query, re-checked against the fresh read:
      // an intentionally-unclaimed run is never legacy-stale.
      if (run.awaiting_claim) return false;
      const referenceTime = run.started_at ?? run.created_at;
      return !!referenceTime && referenceTime < legacyThresholdIso;
    };
  }

  private async sweepOne(run: Run, reason: StaleRunReason, now: Date): Promise<'swept' | 'skipped_completed'> {
    const message =
      reason === 'lease_expired'
        ? `Run lease expired (worker likely terminated mid-execution) — swept by stale-run sweeper`
        : `Run has no lease and exceeded the legacy max age (${LEGACY_RUN_MAX_AGE_MS}ms since started) — swept by stale-run sweeper`;

    const isStillStale = this.buildStillStaleCheck(reason, now);
    const { failed, run: freshRun } = await this.adapter.failRunIfStillStale(
      run.run_id,
      run.case_id,
      message,
      isStillStale,
    );

    if (!failed) {
      console.info(
        `[RunSweepService] Run ${run.run_id} (case ${run.case_id}) resolved on its own before the sweep could fail it — skipping (status=${freshRun?.status ?? 'unknown'}).`,
      );
      return 'skipped_completed';
    }

    const failedRun: Run = freshRun ?? { ...run, status: 'failed', error_message: message };

    await this.adapter
      .emitEvent(
        run.case_id,
        'run_failed',
        {
          run_id: run.run_id,
          run_type: run.run_type,
          error: message,
          swept: true,
          sweep_reason: reason,
        },
        'system:run-sweeper',
      )
      .catch((err) => {
        console.error(`[RunSweepService] Failed to emit run_failed for run ${run.run_id}:`, err);
      });

    // Decide whether this failure retries (lease-expiry/legacy-stale is
    // conservatively transient) or is exhausted/notified.
    await this.pipeline.handleRunFailure(failedRun).catch((err) => {
      console.error(`[RunSweepService] handleRunFailure failed for run ${run.run_id}:`, err);
    });

    // Re-evaluate the pipeline now that the run is no longer active — the
    // case may fall through to a human-decision status, or a retry lands
    // shortly via handleRunFailure above.
    await this.pipeline.onRunCompleted(run.case_id).catch((err) => {
      console.error(
        `[RunSweepService] onRunCompleted failed for case ${run.case_id} after sweeping run ${run.run_id}:`,
        err,
      );
    });

    return 'swept';
  }
}
