import type { Case, CaseStatus, Run, RunType, Decision, EventType, LifecycleProfile } from '@arbitra/shared';
import type { PreconditionContext } from './preconditions.js';
import type { AssistantHoldWrite } from './assistant-hold-writer.js';

/**
 * Re-checked against a FRESH read of the run doc, inside the transaction
 * `failRunIfStillStale` runs — lets the caller re-verify "is this run STILL
 * stale" at commit time (not just at query/snapshot time), closing the race
 * where the run legitimately completes between the sweep's query and its
 * fail call (PR #742).
 */
export type RunStalenessCheck = (run: Run) => boolean;

export interface FailRunIfStillStaleResult {
  /** True if this call actually transitioned the run to `failed`. */
  failed: boolean;
  /** Freshest known run doc (read inside the transaction), or null if the doc no longer exists. */
  run: Run | null;
}

/**
 * Why `resolveAndRunReview` no longer resolves to a bare `Run | null` (issue
 * #1054). A caller that gets `null` learns nothing about WHY no review ran —
 * `POST /api/runs` (`packages/frontend/src/app/api/runs/route.ts`) used to
 * collapse "this case has no PR/branch reference at all" and "the diff
 * fetch from GitHub failed (auth, rate limit, 404, wrong default branch)"
 * into the identical `NO_DIFF_SOURCE` 400, sending an operator chasing a
 * missing PR ref when the real problem was a bad token. `failureReason`
 * lets a caller that cares (the route) tell them apart; a caller that
 * doesn't (the pipeline's own retry loop) can keep checking `.run` exactly
 * as it checked the old bare value.
 */
export type ResolveAndRunReviewFailureReason = 'no_diff_source' | 'diff_fetch_failed';

export interface ResolveAndRunReviewResult {
  /** The created review run, or null if none could be started. */
  run: Run | null;
  /** Present only when `run` is null — why no review could be started. */
  failureReason?: ResolveAndRunReviewFailureReason;
}

export interface RunClaimResult {
  /** True only if THIS call won the claim and is now the run's sole owner. */
  claimed: boolean;
  /**
   * Freshest known run doc read inside the claim transaction. On a win it is
   * the post-claim doc (`running`, lease + `worker_id` stamped) — the caller
   * must dispatch THIS doc, not the pre-claim one it passed in, so the
   * executor's heartbeat has a `worker_id` to refresh. On a loss it is the doc
   * as the winner left it (useful for logging), or `null` if it is gone.
   */
  run: Run | null;
}

export interface CancelUnclaimedAssistantReattemptResult {
  /** True only if this call transitioned the still-unclaimed replacement to `cancelled`. */
  cancelled: boolean;
  /** Freshest known run doc, including the post-cancellation doc on success. */
  run: Run | null;
}

/**
 * Abstraction layer for pipeline storage operations.
 * Allows the same RunCompletionHandler to work in both
 * demo mode (in-memory) and production (Firestore).
 */
export interface PipelineAdapter {
  getCase(caseId: string): Promise<Case>;
  /**
   * `extraUpdates` exists so a caller can write fields that MUST land in the
   * same document update as the status — today the approval pin (issue
   * #1045), which would otherwise be a second write that could fail or be
   * skipped independently of the status it certifies. Optional, so existing
   * two-argument implementations still satisfy this interface.
   */
  updateCaseStatus(caseId: string, status: CaseStatus, extraUpdates?: Partial<Case>): Promise<Case>;
  updateCase(caseId: string, updates: Partial<Case>): Promise<Case>;
  loadPreconditionContext(case_: Case): Promise<PreconditionContext>;
  /**
   * `attempt` (default 1 in implementations) lets retry callers
   * (`RunCompletionHandler.retryRun`) stamp the correct retry count on the
   * freshly created run instead of always resetting to 1.
   */
  createRun(caseId: string, runType: RunType, triggerSource: string, attempt?: number): Promise<Run>;
  completeRun(runId: string, caseId: string, summary: string): Promise<Run>;
  failRun(runId: string, caseId: string, error: string): Promise<Run>;

  /**
   * Create a `pending` run with NO `lease_expires_at` and NO `worker_id` —
   * ownership is decided later, by whichever worker wins `claimRun`. Used by
   * the assistant lifecycle, where the run doc must exist (and be visible to
   * the case's precondition evaluation) before any worker commits to executing
   * it; `createRun` instead stamps a lease at creation time and therefore
   * implicitly assigns the run to its creator.
   *
   * The run is stamped `awaiting_claim: true` so the stale-run sweep can tell
   * this intended lease-less state apart from its "legacy / no lease" cohort
   * (see `Run.awaiting_claim`).
   *
   * Optional: only the Firestore adapter implements it. Demo/in-memory
   * adapters and the six pre-existing run types never go through this path,
   * so nothing outside the assistant lifecycle is affected.
   */
  createUnclaimedRun?(
    caseId: string,
    runType: RunType,
    triggerSource: string,
    attempt?: number,
  ): Promise<Run>;

  /**
   * Persist an unclaimed assistant replacement before its expired predecessor
   * is marked failed. The Firestore adapter implements this durable ordering;
   * if creation fails, the predecessor remains visible to the next sweep.
   * Optional so older adapters keep their existing stale-race behavior.
   */
  prepareAssistantReattempt?(
    caseId: string,
    runType: RunType,
    triggerSource: string,
    attempt: number,
  ): Promise<Run>;

  /**
   * Cancel a prepared assistant replacement that became unnecessary because
   * its predecessor resolved before the sweep could fail it. The read and
   * conditional write must be atomic: cancellation is allowed only while the
   * replacement is still `pending`, explicitly `awaiting_claim`, and has no
   * worker or lease. A concurrent claim must win cleanly and leave the now-
   * owned run untouched.
   *
   * Optional on the broad adapter interface because only the Firestore
   * assistant-sweep path prepares replacements. `RunSweepAdapter` requires it.
   */
  cancelUnclaimedAssistantReattempt?(
    runId: string,
    reason: string,
  ): Promise<CancelUnclaimedAssistantReattemptResult>;

  /**
   * Atomically take ownership of an unclaimed run: transition it to `running`
   * and stamp a fresh lease, `worker_id` and `started_at` — but ONLY if the
   * run is still `pending` AND has no lease holder at all (no
   * `lease_expires_at`, no `worker_id`). Read-inside-transaction, then write
   * conditionally: exactly one of N concurrent callers can win, so a run
   * dispatched twice (in-process dispatch racing the sweep's recovery
   * dispatch) is executed exactly once.
   *
   * The predicate deliberately treats an EXPIRED lease as "held", not as
   * "free": a heartbeat that was merely starved rather than dead would
   * otherwise let a second worker join a live execution. Recovering an expired
   * assistant lease is done by starting a NEW attempt (a new run doc), never
   * by re-claiming the old one — see `RunSweepService`'s assistant sub-sweep.
   *
   * Optional for the same reason as `createUnclaimedRun`.
   */
  claimRun?(runId: string, workerId: string): Promise<RunClaimResult>;

  /**
   * Atomically document an assistant hold: persist the case's
   * `assistant_context` hold fields and the event that documents them in ONE
   * transaction. The hold preconditions require both halves, so exposing them
   * as one durable operation prevents pipeline re-evaluation from observing
   * only half of a hold.
   *
   * The live assistant lifecycle writes only terminal failure
   * (`failed_permanently` + `assistant_task_abandoned`), including retry
   * exhaustion. Callers go through `writeAssistantHold`, which falls back to a
   * sequential write for test doubles and non-Firestore adapters. Legacy
   * `retry_exhausted` documents remain readable but are never written.
   *
   * Optional because only the Firestore assistant-run path uses it.
   */
  documentAssistantHold?(
    caseId: string,
    hold: AssistantHoldWrite,
    event: { type: EventType; payload: Record<string, unknown> },
    actorId: string,
  ): Promise<void>;

  /**
   * Set / clear `Run.assistant_failure_repair_pending` — the marker that lets
   * the assistant sub-sweep re-drive a terminal-failure repair that the
   * in-process (best-effort) attempt did not finish. Written before the case
   * side of the repair and cleared after it lands.
   *
   * Clearing also writes `assistant_failure_repair_settled_at`, which is the
   * durable tombstone used by the bounded marker-loss safety-net. Optional for
   * non-Firestore adapters; production repair does not claim success when a
   * supported marker write or clear fails.
   */
  markAssistantFailureRepairPending?(runId: string): Promise<void>;
  clearAssistantFailureRepairPending?(runId: string): Promise<void>;

  /**
   * Transactional variant of `failRun` for the stale-run sweeper only
   * (PR #742): re-reads the run INSIDE a
   * transaction and only transitions it to `failed` if `status` is still
   * `pending`/`running` AND `isStillStale` accepts the fresh doc. Otherwise
   * a no-op — the run legitimately completed/failed on its own between the
   * sweep's query snapshot and this call (a real risk for cohort-2's
   * age-based legacy sweep, and for cohort-1 if a heartbeat was merely
   * starved rather than dead). `failRun`'s semantics are UNCHANGED for every
   * other caller (RunExecutor, ReviewService, the manual fail route) —
   * this is a NEW, additive method, not a behavior change to the existing one.
   * Optional: only `RunSweepService` requires it (enforced via a narrower
   * adapter type there, see `run-sweep-service.ts`).
   */
  failRunIfStillStale?(
    runId: string,
    caseId: string,
    error: string,
    isStillStale: RunStalenessCheck,
  ): Promise<FailRunIfStillStaleResult>;

  emitEvent(caseId: string, type: EventType, payload: Record<string, unknown>, actorId: string): Promise<void>;
  getActiveRuns(caseId: string): Promise<Run[]>;
  createAutoApproveDecision(caseId: string): Promise<Decision>;

  /**
   * Administratively close any `waiver_proposed` finding still outstanding when
   * a case reaches `done` (issue #751) — see
   * `closeOutstandingWaiverProposalsOnCompletion`. Called by the pipeline right
   * after the status write; by contract it never throws, so a failure cannot
   * roll back a completed case. REQUIRED (not optional): a case that completes
   * without this cleanup leaves a human decision in the audit trail that no
   * surface can act on, so no adapter may silently skip it.
   */
  closeOutstandingWaiverProposals(caseId: string): Promise<{ closed: number }>;

  /**
   * Durable retry backstop (PR #742). Persists the
   * retry intent (`retry_at`) on a `failed` run so it survives an instance
   * dying before the in-process `setTimeout` in
   * `RunCompletionHandler.handleRunFailure` fires — the stale-run sweep
   * queries `failed` runs with an overdue `retry_at` and dispatches them
   * through the same claim path (see `claimRunRetryDispatch`). REQUIRED
   * (not optional): without a durable persist, retry is only best-effort
   * in-process, which is exactly the gap this fixes.
   */
  scheduleRunRetry(runId: string, retryAt: string): Promise<void>;

  /**
   * Idempotently claim the right to dispatch a previously-scheduled retry
   * (see `scheduleRunRetry`). Both the in-process timer AND the stale-run
   * sweep's overdue-retry pass call this before actually creating a new run
   * — whichever gets there first flips `retry_dispatched` inside a
   * transaction and gets the fresh run doc back; the other observes the
   * flag already set and receives `null` (must no-op). Returns `null` also
   * when the run doc is gone or its status is no longer `failed`.
   */
  claimRunRetryDispatch(runId: string): Promise<Run | null>;

  /**
   * Extend a run's lease TTL while a worker is actively executing it (run
   * durability). Optional: only the Firestore adapter implements this;
   * demo/in-memory adapters and test doubles may omit it and the executor's
   * heartbeat becomes a no-op.
   */
  refreshRunLease?(runId: string, workerId: string): Promise<void>;

  /**
   * Persist a system-actor `merge_not_applicable` decision for a case whose
   * implementation lives outside any repository (no PR ref, no branch — see
   * issue #687). Attached by the pipeline before evaluating the
   * `approved → done` merge-skip transition so the audit trail records WHY
   * the merge gate was skipped.
   */
  createMergeNotApplicableDecision(caseId: string): Promise<Decision>;

  /** Load the lifecycle profile for a project. Returns undefined if no profile is set. */
  getProjectLifecycleProfile(projectId: string): Promise<LifecycleProfile | undefined>;

  /**
   * Resolve the diff for a case (via GitHub API) and run an LLM review.
   * Creates a review_run, fetches the diff, invokes ReviewService, and
   * triggers onRunCompleted when done. Returns `{ run: null }` if no diff
   * could be resolved — `failureReason` says why (see
   * `ResolveAndRunReviewResult`'s doc comment, issue #1054).
   *
   * `attempt` (default 1): retry count to stamp on the review run doc — see
   * `createRun`'s `attempt` param. Forwarded to `ReviewService.runReview`.
   *
   * `triggerSource` (default `'system:pipeline'`): stamped on the run doc's
   * `trigger_source` — override it when a human, not the autonomous
   * pipeline, is the one asking for this review (issue #1047 door 2:
   * `POST /api/runs` resolves the diff itself now instead of trusting a
   * caller-supplied one, and passes the caller's `auth.userId` here so the
   * audit trail still records who actually asked for the review).
   */
  resolveAndRunReview?(caseId: string, attempt?: number, triggerSource?: string): Promise<ResolveAndRunReviewResult>;

  /**
   * Idempotently claim the "run is taking too long" timeout-notification
   * slot for `runId` (replaces the old in-memory `timeoutNotified`
   * Set so the de-dupe survives an instance restart). Returns `true` if the
   * slot was ALREADY claimed (caller should skip notifying), `false` if this
   * call just claimed it (caller should proceed to notify). Optional: only
   * the Firestore adapter implements this; a test double that omits it makes
   * `scheduleRunTimeoutCheck` always notify (best-effort, matches the old
   * in-memory-Set-per-instance behavior).
   */
  markRunTimeoutNotified?(runId: string): Promise<boolean>;
}
