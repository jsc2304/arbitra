import type { CaseStatus, RunType, Run, Case, GateId, PreconditionId } from '@arbitra/shared';
import {
  getAutoTransitionsFrom,
  findTransition,
  findGateId,
  isAssistantRunType,
  resolveGateBehavior,
  NotFoundError,
  ArbitraError,
  GATE_TRANSITION_MAP,
  TERMINAL_CASE_STATUSES,
  type TransitionDefinition,
} from '@arbitra/shared';
import {
  createPreconditionEvaluator,
  loopbackScopedDecisions,
  type PreconditionResult,
} from './preconditions.js';
import { approvalPinPatch } from '../case/approval-pin.js';
import { StateMachine } from './state-machine.js';
import { writeAssistantHold } from './assistant-hold-writer.js';
import type { PipelineAdapter } from './pipeline-adapter.js';
import { NotificationService } from '../notification/notification-service.js';
import { NotificationDispatcher } from '../notification/notification-dispatcher.js';
import {
  acquireCasePipelineLock,
  CasePipelineLockHeldError,
  type CasePipelineLockHandle,
} from './case-pipeline-lock.js';
// Value import (not type-only): retries dispatch a fresh execution via
// RunExecutor for run types that don't have a dedicated re-entry point
// (review_run instead goes through `adapter.resolveAndRunReview`). See the
// `import type` note in run-executor.ts for why this doesn't create a
// runtime circular-import cycle.
import { RunExecutor } from './run-executor.js';
import { MAX_RUN_RETRIES, classifyRunFailure, retryBackoffMs } from './run-retry-policy.js';

const MAX_CHAIN_DEPTH = 5;
const SYSTEM_ACTOR = 'system:pipeline';
const RUN_TIMEOUT_MS = parseInt(process.env['ARBITRA_RUN_TIMEOUT_MS'] ?? '90000', 10);

/** Source statuses whose auto-close-on-merge transition is gated by the feature flag. */
const AUTO_CLOSE_ON_MERGE_SOURCES: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  'in_build',
  'in_validation',
  'in_review',
  'approved',
]);

/**
 * Is this prepared assistant replacement still free for THIS caller to
 * dispatch? True only for the shape `prepareAssistantReattempt`/
 * `createUnclaimedRun` write for a brand-new replacement: pending, no worker,
 * no lease, and no bound policy. Anything else means someone else — the
 * assistant claim sweep, or an earlier re-drive of this same retry — already
 * owns the attempt, and a second `RunExecutor.dispatch` would race it.
 */
function isClaimableAssistantReattempt(run: Run): boolean {
  return run.status === 'pending'
    && !run.worker_id
    && !run.lease_expires_at
    && run.assistant_policy_state !== 'bound';
}

function isAutoCloseOnMergeFlagEnabled(): boolean {
  const raw = process.env['ARBITRA_AUTO_CLOSE_ON_MERGE'];
  if (raw === undefined) return true;
  return raw.toLowerCase() !== 'false';
}

// ── Public types ─────────────────────────────────────────────────────

export type NextAction =
  | { type: 'start_run'; run_type: RunType; reason: string }
  | { type: 'await_human'; reason: string }
  | { type: 'await_ci'; reason: string }
  | { type: 'transition_ready'; target: CaseStatus }
  | { type: 'case_complete' };

export interface PipelineResult {
  transitions: Array<{ from: CaseStatus; to: CaseStatus }>;
  scheduled_runs: Array<{ run_id: string; run_type: RunType }>;
  final_status: CaseStatus;
  next_actions: NextAction[];
}

/**
 * What one pass of `documentAssistantTerminalFailure` achieved.
 *
 * - `settled` — no case-side repair remains: the case is terminal, or it is in
 *   a status where a terminal-failure verdict does not apply. The marker was
 *   successfully discharged.
 * - `abandoned` — the case no longer exists. It can never transition, so there
 *   is nothing to repair and nothing to keep re-driving; the marker is dropped.
 * - `documented` — the hold is on the case, but the transition it enables has
 *   NOT been driven yet, so the marker deliberately stays set (see
 *   `settleAssistantFailureRepair`).
 * - `failed` — the write did not land. Marker retained for the next sweep pass.
 */
export type AssistantTerminalFailureRepair = 'settled' | 'abandoned' | 'documented' | 'failed';

/**
 * A `getCase` rejection that means the case is GONE (deleted, or never
 * existed), as opposed to a read that failed and could succeed next time.
 * `CaseRepository.getById` throws `NotFoundError` for a soft-deleted case; the
 * name check covers an equivalent error crossing a module boundary that broke
 * `instanceof`.
 */
function isMissingCaseError(err: unknown): boolean {
  return err instanceof NotFoundError || (err instanceof Error && err.name === 'NotFoundError');
}

// ── Run schedule: which runs to start when entering a status ─────────

const STATUS_RUN_SCHEDULE: Partial<Record<CaseStatus, RunType[]>> = {
  in_validation: ['rule_run'],
  in_review: ['review_run'],
};

// ── RunCompletionHandler ─────────────────────────────────────────────

export type RunScheduledCallback = (run: Run, case_: Case) => void;

/** Back-off for a held case pipeline lock; evaluations normally finish well within it. */
const PIPELINE_LOCK_RETRY_DELAYS_MS = [200, 400, 800, 1600];

async function acquireCasePipelineLockWithRetry(caseId: string): Promise<CasePipelineLockHandle> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await acquireCasePipelineLock(caseId);
    } catch (err) {
      const delay = PIPELINE_LOCK_RETRY_DELAYS_MS[attempt];
      if (!(err instanceof CasePipelineLockHeldError) || delay === undefined) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export class RunCompletionHandler {
  private onRunScheduled?: RunScheduledCallback;
  private readonly notificationService = new NotificationService();
  private readonly dispatcher = new NotificationDispatcher();
  // Pure/stateless — no Firestore dependency of its own, so it is safe to
  // reuse here for the SAME (matrix edge + precondition evaluation) check
  // `applyTransitionInTransaction` performs on the transactional write path.
  // `executeGateConfirmation` uses it to re-validate a gate at confirm time.
  private readonly stateMachine = new StateMachine();

  constructor(private readonly adapter: PipelineAdapter) {}

  /** Register a callback to dispatch scheduled runs (e.g., to a RunExecutor) */
  setRunScheduledCallback(cb: RunScheduledCallback): void {
    this.onRunScheduled = cb;
  }

  /**
   * Preview-evaluate a single precondition for a case WITHOUT executing any
   * transition or mutating anything. Issue #1000: the webhook service needs
   * to know, before it writes an audit trail claiming a case auto-closed,
   * whether the transition-matrix precondition that shortcut actually
   * depends on would allow it — otherwise a blocked case can end up with a
   * comment on its timeline asserting an outcome that didn't happen. Reuses
   * the exact same context-loading and evaluator the real auto-transition
   * fanout (`tryAutoTransition`, below) uses, so this can never drift from
   * what the pipeline would actually decide.
   */
  async evaluatePrecondition(case_: Case, id: PreconditionId): Promise<PreconditionResult> {
    const ctx = await this.adapter.loadPreconditionContext(case_);
    return createPreconditionEvaluator(ctx).evaluate(id);
  }

  /**
   * Called when a run completes, evidence arrives, or any event that
   * might enable a new auto-transition. Evaluates preconditions and
   * chains auto-transitions up to MAX_CHAIN_DEPTH.
   *
   * Concurrency: this method is triggered from ~15 call sites, mostly
   * fire-and-forget (webhooks, evidence/review/decision services,
   * run-executor). Two near-simultaneous completions for the SAME case would
   * otherwise both read-evaluate-write with no coordination — a classic
   * TOCTOU that can double-attach an `auto_approve` decision or race the
   * case's `status` field. A per-case Firestore lock (`case-pipeline-lock.ts`,
   * same TTL-reclaim pattern as `intelligence-lock.ts`) serializes the whole
   * read-evaluate-write cycle below. A caller that loses the race waits
   * briefly and evaluates again from fresh state, because the winner may have
   * read the case before this caller's change (a completed run) landed; only
   * if the lock stays held for ~3 s does it no-op.
   *
   * Locking is best-effort: only a genuine `LOCK_HELD` (someone else is
   * actively evaluating this case) short-circuits to a no-op. Any other
   * failure to acquire/release the lock (Firestore unreachable, a test
   * double that doesn't stub the lock's transaction surface, etc.) is
   * logged and the evaluation proceeds unlocked — auxiliary locking infra
   * must never become a new way for the pipeline to stop advancing a case.
   */
  async onRunCompleted(caseId: string): Promise<PipelineResult> {
    let lock: CasePipelineLockHandle | null = null;
    try {
      lock = await acquireCasePipelineLockWithRetry(caseId);
    } catch (err) {
      if (err instanceof CasePipelineLockHeldError) {
        // Another evaluation has held the lock through every retry; leave
        // the case to it (and to the run sweeper) rather than racing it.
        const case_ = await this.adapter.getCase(caseId);
        return {
          transitions: [],
          scheduled_runs: [],
          final_status: case_.status,
          next_actions: this.computeNextActions(case_),
        };
      }
      console.warn(
        `[Pipeline] Failed to acquire case pipeline lock for ${caseId}, proceeding without it:`,
        err,
      );
    }

    try {
      const result: PipelineResult = {
        transitions: [],
        scheduled_runs: [],
        final_status: 'open',
        next_actions: [],
      };

      let case_ = await this.adapter.getCase(caseId);
      result.final_status = case_.status;

      for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
        const transitioned = await this.tryAutoTransition(case_);
        if (!transitioned) break;

        result.transitions.push({
          from: case_.status,
          to: transitioned.to,
        });

        // Reload case with new status
        case_ = await this.adapter.getCase(caseId);
        result.final_status = case_.status;

        // Schedule runs for the new status (some may auto-complete immediately)
        const scheduled = await this.scheduleRunsForStatus(case_);
        result.scheduled_runs.push(...scheduled);

        // If runs were scheduled, check whether any are still active (pending/running).
        // Auto-completed runs (e.g. rule_run with no active rules) don't block — the loop
        // continues so the pipeline can evaluate the next transition in the same request.
        // Only truly async runs (e.g. review_run via resolveAndRunReview) block the chain.
        if (scheduled.length > 0) {
          const activeRuns = await this.adapter.getActiveRuns(case_.case_id);
          if (activeRuns.length > 0) break;
          // All scheduled runs auto-completed — reload case and continue chaining
          case_ = await this.adapter.getCase(caseId);
          result.final_status = case_.status;
        } else {
          // Even when no run records were scheduled, `scheduleRunsForStatus` may
          // have mutated the case (e.g. in_review without a diff source sets
          // `review_not_applicable=true` inline). Reload so the next
          // `tryAutoTransition` evaluates preconditions against fresh state —
          // otherwise the case parks in `in_review` despite all gates being
          // satisfiable on the manual/direct track.
          case_ = await this.adapter.getCase(caseId);
          result.final_status = case_.status;
        }
      }

      result.next_actions = this.computeNextActions(case_);
      return result;
    } finally {
      if (lock) {
        await lock.release().catch((err) => {
          console.warn(`[Pipeline] Failed to release case pipeline lock for ${caseId}:`, err);
        });
      }
    }
  }

  /**
   * Retry/backoff decision for a run that just failed — called
   * from `RunExecutor`'s executor-failure catch (both the outer catch and
   * `executeRuleRun`'s), `ReviewService.runReview`'s catch, and
   * `RunSweepService` after it marks a stale run failed.
   * Generalizes the narrow diff-resolution retry loop in
   * `scheduleRunsForStatus`'s `attemptReview` (which only retries a
   * not-yet-started review when the diff can't be resolved) to ANY failed
   * run: on a conservatively-classified transient failure, re-schedule with
   * exponential backoff (10s, 30s) up to `MAX_RUN_RETRIES`; on exhaustion (or
   * a permanent failure straight away — no retry, no exhaustion event, the
   * failure just stands) notify the case owner. Assistant runs are the one
   * exception on both terminal paths: they additionally get a documented hold,
   * because their statuses are not human-actionable on their own (see
   * `documentAssistantTerminalFailure` and `emitRetriesExhausted`).
   *
   * Durable backstop (PR #742): the retry intent is
   * persisted (`scheduleRunRetry` → `retry_at` on the failed run doc)
   * BEFORE the in-process `setTimeout` is armed. If this instance dies
   * before the timer fires (scale-to-zero, rolling deploy), the retry is
   * NOT lost — `RunSweepService`'s overdue-retry pass finds `retry_at` in
   * the past on a `failed` run and dispatches it through the exact same
   * `dispatchScheduledRetry` claim as the in-process timer, so whichever of
   * {timer, sweep} gets there first wins and the other is a clean no-op.
   *
   * Best-effort throughout: a bug in the retry machinery itself must never
   * throw past this method and mask the original run failure it's reacting
   * to. Does NOT call `onRunCompleted` itself — callers that want the
   * pipeline to react to the failed-run state call that separately (see the
   * lock-reentrancy note on `onRunCompleted`).
   */
  async handleRunFailure(run: Run): Promise<void> {
    try {
      // A stale Run can outlive its Case: merge/webhook processing may have
      // completed the Case while the worker disappeared. The failure itself
      // remains useful bookkeeping, but recovery work on a terminal Case is
      // junk. Read before classification so neither the transient branch nor
      // exhaustion/permanent side effects can create more work or notify an
      // owner about a Case that is already over. An unreadable Case also fails
      // closed here; guessing that recovery is safe is the dangerous choice.
      if (!(await this.loadRecoverableCase(run, 'handling its failure'))) return;

      const classification = classifyRunFailure(run.error_message);
      if (classification !== 'transient') {
        console.error('[Pipeline] run_failure_decision', JSON.stringify({
          run_id: run.run_id,
          case_id: run.case_id,
          run_type: run.run_type,
          attempt: run.attempt ?? 1,
          classification,
          error: run.error_message,
          disposition: isAssistantRunType(run.run_type)
            ? 'document_terminal_assistant_failure'
            : 'leave_failed_for_human',
        }));
        // A permanent failure "just stands" for every other run type — their
        // cases sit in an engineering status a human can act on. An assistant
        // case cannot: its only edges out of `open`/`in_build` are gated on a
        // documented hold or a result, and a failed run produces neither, so
        // without this the case has NO reachable transition at all and keeps
        // consuming one of the requester's active-task slots forever.
        if (isAssistantRunType(run.run_type)) {
          await this.documentAssistantTerminalFailure(run);
        }
        return;
      }

      const attempt = run.attempt ?? 1;
      const retriesSoFar = attempt - 1;
      if (retriesSoFar >= MAX_RUN_RETRIES) {
        console.error('[Pipeline] run_failure_decision', JSON.stringify({
          run_id: run.run_id,
          case_id: run.case_id,
          run_type: run.run_type,
          attempt,
          classification,
          error: run.error_message,
          disposition: isAssistantRunType(run.run_type)
            ? 'document_terminal_assistant_failure'
            : 'retries_exhausted',
        }));
        await this.emitRetriesExhausted(run);
        return;
      }

      const delayMs = retryBackoffMs(retriesSoFar);
      const retryAt = new Date(Date.now() + delayMs).toISOString();
      console.info('[Pipeline] run_failure_decision', JSON.stringify({
        run_id: run.run_id,
        case_id: run.case_id,
        run_type: run.run_type,
        attempt,
        classification,
        error: run.error_message,
        disposition: 'retry_scheduled',
        retry_at: retryAt,
      }));

      // Persist FIRST — the durable backstop only helps if it lands before
      // this instance could plausibly die. Best-effort: a persist failure
      // logs and falls through to the in-process timer anyway (matches the
      // "auxiliary durability infra must never become a new way to stop
      // retries" principle used for the case-pipeline lock).
      await this.adapter.scheduleRunRetry(run.run_id, retryAt).catch((err) => {
        console.error(`[Pipeline] Failed to persist retry intent for run ${run.run_id}:`, err);
      });

      setTimeout(() => {
        this.dispatchScheduledRetry(run).catch((err) => {
          console.error(
            `[Pipeline] Retry dispatch failed for run ${run.run_id} (case ${run.case_id}):`,
            err,
          );
        });
      }, delayMs);
    } catch (err) {
      console.error(`[Pipeline] handleRunFailure error for run ${run.run_id}:`, err);
    }
  }

  /**
   * Record that an assistant attempt failed for good, so the case can reach
   * `rejected` through the normal auto-transition fanout.
   *
   * Runs from `handleRunFailure` after a permanent classification or exhausted
   * retry ladder — after `failRun`, so the run is already terminal, and at the
   * exact point where the system decides to stop trying. This method does NOT
   * drive the transition: the caller does,
   * in its next statement (`RunExecutor.handleExecutionFailure`, the sweep's
   * `repairAssistantTerminalFailure`).
   *
   * That split is why the repair marker is NOT cleared here. The marker means
   * "this run's permanent failure has not yet produced a terminal case", so
   * writing the hold does not discharge it — between the write and the caller's
   * transition the instance can die, `onRunCompleted` can throw, or the pipeline
   * lock can be held by a concurrent evaluation working from a pre-repair read.
   * Clearing on the write would leave exactly the #768 state (non-terminal case,
   * hold written, no marker) with the backstop blind to it.
   * `settleAssistantFailureRepair` is what discharges the marker, on the one
   * observation that means the failure is done: a terminal case.
   *
   * Also called by the assistant sub-sweep for runs whose marker is still set,
   * so it must be idempotent: a case that already carries this verdict for this
   * run — BOTH halves of it — is left alone, with no second event.
   *
   * Best-effort throughout, like the rest of `handleRunFailure`, and reports its
   * outcome rather than throwing so the sweep can tell a landed repair from one
   * that keeps failing. A swallowed error that looked like success is what
   * turned the original failure into a permanently stuck case.
   *
   * No notification of its own: the `case_rejected` event emitted by the
   * transition already notifies the case owner via `EventNotifier`, and the
   * requester IS the owner for an assistant task.
   */
  async documentAssistantTerminalFailure(
    run: Run,
    classification: 'permanent' | 'retry_exhausted' = 'permanent',
  ): Promise<AssistantTerminalFailureRepair> {
    if (this.adapter.markAssistantFailureRepairPending) {
      try {
        await this.adapter.markAssistantFailureRepairPending(run.run_id);
      } catch (err) {
        // The marker is the sweep's only durable route back to this repair. A
        // hold without it can lose the next pipeline evaluation and wedge the
        // Case forever, so keep the failed Run self-consistent and write no
        // Case-side verdict until a later attempt can mark it first.
        console.warn(
          `[Pipeline] Failed to mark assistant run ${run.run_id} as awaiting terminal-failure repair; the case hold was not written:`,
          err,
        );
        return 'failed';
      }
    }

    let case_: Case;
    try {
      case_ = await this.adapter.getCase(run.case_id);
    } catch (err) {
      if (isMissingCaseError(err)) {
        console.info(
          `[Pipeline] Case ${run.case_id} no longer exists — dropping the terminal-failure repair for assistant run ${run.run_id}.`,
        );
        return await this.clearAssistantFailureRepairMarker(run.run_id)
          ? 'abandoned'
          : 'failed';
      }
      console.error(
        `[Pipeline] Failed to read case ${run.case_id} while documenting the terminal failure of assistant run ${run.run_id} — leaving the repair marker set for the sweep:`,
        err,
      );
      return 'failed';
    }

    // A terminal case needs no verdict: it already stopped consuming a slot,
    // and re-documenting one would only add a second timeline entry. It is also
    // the observation that discharges the marker.
    if (TERMINAL_CASE_STATUSES.has(case_.status)) {
      return await this.clearAssistantFailureRepairMarker(run.run_id)
        ? 'settled'
        : 'failed';
    }

    // Only these statuses have an assistant terminal-failure edge. Writing a
    // verdict in needs_human_decision (or an engineering status) would create
    // a marker no transition can ever discharge and make every sweep repeat it.
    if (case_.status !== 'open' && case_.status !== 'in_build') {
      console.info(
        `[Pipeline] Assistant run ${run.run_id} failed while case ${run.case_id} was ${case_.status}; no terminal-failure verdict applies in that status.`,
      );
      return await this.clearAssistantFailureRepairMarker(run.run_id)
        ? 'settled'
        : 'failed';
    }

    try {
      if (!(await this.terminalFailureFullyDocumented(case_, run))) {
        await writeAssistantHold(
          this.adapter,
          run.case_id,
          {
            wait_reason: 'failed_permanently',
            run_id: run.run_id,
            attempt: run.attempt ?? 1,
          },
          {
            type: 'assistant_task_abandoned',
            payload: {
              run_id: run.run_id,
              run_type: run.run_type,
              attempt: run.attempt ?? 1,
              error: run.error_message,
              classification,
            },
          },
          SYSTEM_ACTOR,
        );
      }
    } catch (err) {
      console.error(
        `[Pipeline] Failed to document terminal assistant failure for run ${run.run_id} (case ${run.case_id}) — leaving the repair marker set for the sweep:`,
        err,
      );
      return 'failed';
    }

    return 'documented';
  }

  /**
   * Is this run's terminal failure documented in FULL — the case fields AND the
   * `assistant_task_abandoned` event naming the run?
   *
   * Keying only on the case fields would be weaker than the precondition it
   * guards: `writeAssistantHold`'s sequential fallback (any adapter without the
   * transactional `documentAssistantHold`) can land the case write and then fail
   * the event write. A re-drive that concluded "already documented" from the case
   * half alone would emit nothing, leaving a verdict no event documents and a
   * case with no satisfiable terminal edge.
   *
   * The event read only happens on the re-drive path, where the case half is
   * already present; the first pass pays nothing for it.
   */
  private async terminalFailureFullyDocumented(case_: Case, run: Run): Promise<boolean> {
    const assistant = case_.assistant_context;
    if (assistant?.wait_reason !== 'failed_permanently' || assistant.wait_run_id !== run.run_id) {
      return false;
    }
    const ctx = await this.adapter.loadPreconditionContext(case_);
    return ctx.events.some(
      (event) => event.type === 'assistant_task_abandoned'
        && (event.payload as { run_id?: unknown }).run_id === run.run_id,
    );
  }

  /**
   * Discharge a run's terminal-failure repair marker, but only once the case is
   * observed TERMINAL — the single observation that means the permanent failure
   * has finished producing its outcome.
   *
   * Called by whoever drove the transition, right after it: the in-process path
   * (`RunExecutor.handleExecutionFailure`) and the sweep's re-drive. Without it
   * the in-process path would depend on a sweep pass to clean up after itself;
   * with it, the sweep stays the backstop for exactly the cases this misses (a
   * lost pipeline-lock race, a dead instance, a throwing evaluation).
   *
   * Returns whether the repair is discharged. A case that no longer exists
   * counts: it can never transition, so nothing is outstanding. A failed READ
   * does not — leaving the marker set costs one more sweep pass, which is the
   * cheap direction to be wrong in.
   */
  async settleAssistantFailureRepair(run: Run): Promise<boolean> {
    let case_: Case;
    try {
      case_ = await this.adapter.getCase(run.case_id);
    } catch (err) {
      if (isMissingCaseError(err)) {
        return this.clearAssistantFailureRepairMarker(run.run_id);
      }
      console.warn(
        `[Pipeline] Failed to re-read case ${run.case_id} to settle the terminal-failure repair of assistant run ${run.run_id} — leaving the marker set:`,
        err,
      );
      return false;
    }

    if (!TERMINAL_CASE_STATUSES.has(case_.status)) return false;
    return this.clearAssistantFailureRepairMarker(run.run_id);
  }

  private async clearAssistantFailureRepairMarker(runId: string): Promise<boolean> {
    if (!this.adapter.clearAssistantFailureRepairPending) return true;
    try {
      await this.adapter.clearAssistantFailureRepairPending(runId);
      return true;
    } catch (err) {
      console.warn(
        `[Pipeline] Failed to clear the terminal-failure repair marker on assistant run ${runId}:`,
        err,
      );
      return false;
    }
  }

  /**
   * Resolve the current owning Case before any recovery side effect.
   *
   * This check deliberately returns null on read failure. Where a durable
   * retry intent already exists, a later sweep can reconsider it while it
   * remains unclaimed. Otherwise suppressing new work is still safer than
   * creating a replacement while the lifecycle boundary is unknown.
   */
  private async loadRecoverableCase(run: Run, action: string): Promise<Case | null> {
    try {
      const case_ = await this.adapter.getCase(run.case_id);
      return TERMINAL_CASE_STATUSES.has(case_.status) ? null : case_;
    } catch (err) {
      console.error(
        `[Pipeline] Cannot read case ${run.case_id} before ${action} for run ${run.run_id}; recovery is suppressed:`,
        err,
      );
      return null;
    }
  }

  /**
   * Idempotently dispatch a retry previously scheduled by `handleRunFailure`
   * (`scheduleRunRetry`). Called by BOTH the in-process `setTimeout` above
   * AND `RunSweepService`'s overdue-retry pass — exactly one of them wins
   * `claimRunRetryDispatch`'s transaction (flips `retry_dispatched`); the
   * loser gets `null` back and does nothing further. This is what makes
   * "timer fires AND the sweep independently finds the same overdue retry"
   * safe instead of creating two new runs for one failure.
   */
  async dispatchScheduledRetry(run: Run): Promise<'dispatched' | 'already_claimed' | 'not_eligible'> {
    if (!this.adapter.claimRunRetryDispatch) return 'not_eligible';
    // Check before claiming: if the Case is terminal or temporarily
    // unreadable, leave the durable intent unclaimed so the sweep can make a
    // fresh decision later instead of consuming it without creating work.
    if (!(await this.loadRecoverableCase(run, 'claiming its scheduled retry'))) {
      return 'not_eligible';
    }
    const claimed = await this.adapter.claimRunRetryDispatch(run.run_id);
    if (!claimed) return 'already_claimed';

    const nextAttempt = (claimed.attempt ?? run.attempt ?? 1) + 1;
    try {
      // Re-read after the claim as a final race guard. The Case may have
      // completed between the pre-claim read and this dispatch.
      return await this.retryRun(claimed, nextAttempt) ? 'dispatched' : 'not_eligible';
    } catch (err) {
      console.error(`[Pipeline] dispatchScheduledRetry failed for run ${run.run_id}:`, err);
      return 'not_eligible';
    }
  }

  /**
   * Finish an exhausted retry ladder. Best-effort.
   *
   * Assistant tasks use the same terminal verdict as any other final assistant
   * failure. There is no clarification/resume channel, so parking an exhausted
   * attempt in `needs_human_decision` would create a sink. Other run types keep
   * their existing event + warning because their engineering statuses remain
   * human-actionable.
   */
  private async emitRetriesExhausted(run: Run): Promise<void> {
    // The Case could complete after handleRunFailure's first read. Re-check at
    // the exact event/notification boundary so that race cannot generate a
    // terminal-Case warning.
    const case_ = await this.loadRecoverableCase(run, 'recording retry exhaustion');
    if (!case_) return;

    if (isAssistantRunType(run.run_type)) {
      await this.documentAssistantTerminalFailure(run, 'retry_exhausted');
      return;
    }

    const payload = {
      run_id: run.run_id,
      run_type: run.run_type,
      attempts: run.attempt ?? 1,
      error: run.error_message,
    };
    try {
      // The case-owner notification this event promises (roadmap: a
      // `run_retries_exhausted` push on exhaustion) now comes from
      // `EventNotifier.notifyRunRetriesExhausted`, fired inline by
      // `EventService.emit` right below — not from a second, ad hoc call
      // here. That kept this event's notification off the same catalog
      // every other event goes through, silently un-toggleable and without
      // the Chat dispatch its `NOTIFICATION_EVENT_DEFAULTS` entry now gives
      // it for free (see `docs/specs/clerk-config-scheduling-chat.md` slice C).
      await this.adapter.emitEvent(run.case_id, 'run_retries_exhausted', payload, SYSTEM_ACTOR);
    } catch (err) {
      console.error(`[Pipeline] Failed to emit run_retries_exhausted for run ${run.run_id}:`, err);
    }
  }

  /**
   * Re-dispatch a failed run at `nextAttempt`. Only ever called from
   * `dispatchScheduledRetry` AFTER it has won the `claimRunRetryDispatch`
   * transaction, so this itself never needs its own idempotency guard.
   * Guards against piling onto a run of the same type that's already active
   * (a human manually retried in the meantime, or the retried run somehow
   * already got scheduled another way) — the `alreadyRunning`-style check
   * reads `getActiveRuns`, which naturally excludes the just-failed run
   * (its status is no longer pending/running), so a legitimate retry is
   * never blocked by its own failure.
   */
  private async retryRun(run: Run, nextAttempt: number): Promise<boolean> {
    const case_ = await this.loadRecoverableCase(run, 'creating its replacement run');
    if (!case_) return false;

    if (
      isAssistantRunType(run.run_type)
      && case_.assistant_cancel_intent !== undefined
    ) {
      return false;
    }

    const active = await this.adapter.getActiveRuns(case_.case_id);
    if (active.some((r) => r.run_type === run.run_type)) {
      // Something already re-started this run type — don't double-dispatch.
      return false;
    }

    if (run.run_type === 'review_run' && this.adapter.resolveAndRunReview) {
      const { run: retried } = await this.adapter.resolveAndRunReview(case_.case_id, nextAttempt);
      if (retried) {
        this.scheduleRunTimeoutCheck('review_run', case_, retried.run_id);
      }
      return true;
    }

    // Assistant retries must use the unclaimed-run claim path, not `createRun`:
    // `createRun` stamps a lease and `worker_id` at creation, leaving a
    // pending-but-owned run that nothing promotes to `running`. That makes
    // `assistant_run_claimed` unsatisfiable, so an assistant case cannot take
    // its open → in_build transition. `prepareAssistantReattempt` (or the
    // older `createUnclaimedRun`) instead creates an awaiting-claim run, which
    // `RunExecutor.claimIfUnclaimed` promotes to running through the atomic
    // `claimRun` transaction — the single promotion path shared by intake and
    // the assistant sub-sweep. Adding a separate executor "mark running" step
    // for a pending run it owns would create a second parallel path that
    // bypasses that transaction and reintroduces the double-execution risk the
    // claim exists to prevent.
    //
    // `claimRun` is deliberately part of this guard: `claimIfUnclaimed` passes
    // an awaiting-claim run straight through when an adapter has no claim
    // support (demo/in-memory adapters). Creating an unclaimed retry there
    // would leave it pending and lease-less, so those adapters retain the
    // existing `createRun` behavior. This branch also intentionally does not
    // call `scheduleRunTimeoutCheck`: assistant liveness comes from the lease
    // heartbeat plus the assistant sub-sweep's claim and expiry recovery, and
    // neither intake nor sweep recovery emits that notification. The durable
    // unclaimed replacement is also recoverable by that sweep if this process
    // dies after creation but before dispatch — unlike the `createRun` path.
    if (
      isAssistantRunType(run.run_type)
      && this.adapter.claimRun
      && (this.adapter.prepareAssistantReattempt || this.adapter.createUnclaimedRun)
    ) {
      const retried = this.adapter.prepareAssistantReattempt
        ? await this.adapter.prepareAssistantReattempt(
          case_.case_id, run.run_type, run.trigger_source, nextAttempt,
        )
        : await this.adapter.createUnclaimedRun!(
          case_.case_id, run.run_type, run.trigger_source, nextAttempt,
        );
      // `prepareAssistantReattempt` is idempotent on a deterministic attempt
      // key, so it returns the EXISTING replacement when one is already there —
      // which, on a re-drive, may be a run the assistant sweep has meanwhile
      // claimed and bound. Dispatching that one adds a second executor to a
      // live attempt. Until #835 the policy-bind conflict throw happened to
      // stop the loser (the fresh policy could not equal the bound snapshot);
      // now that the bind tolerates a superset, that accident is gone and the
      // fence has to be stated. `claimIfUnclaimed` alone is not it: an adapter
      // without claim support passes an awaiting-claim run straight through.
      if (!isClaimableAssistantReattempt(retried)) {
        console.info(
          `[Pipeline] Assistant replacement ${retried.run_id} (case ${case_.case_id}, attempt ${nextAttempt}) is no longer claimable — leaving it to its current owner (status=${retried.status}, worker=${retried.worker_id ?? 'none'}, policy_state=${retried.assistant_policy_state ?? 'none'}).`,
        );
        return false;
      }
      const executor = new RunExecutor(this.adapter, this);
      executor.dispatch(retried, case_);
      return true;
    }

    // Generic path (rule_run, build_run, …): create a fresh run doc carrying
    // the incremented attempt count and dispatch it through RunExecutor. Run
    // types RunExecutor has no executor for (build_run today) fail
    // immediately with a permanent-classified message ("No executor for run
    // type: …") — handleRunFailure won't retry that again, so this can't
    // spin forever on a type nothing can actually re-run.
    const retried = await this.adapter.createRun(case_.case_id, run.run_type, run.trigger_source, nextAttempt);
    const executor = new RunExecutor(this.adapter, this);
    executor.dispatch(retried, case_);
    this.scheduleRunTimeoutCheck(run.run_type, case_, retried.run_id);
    return true;
  }

  /**
   * Try to find and execute one auto-triggerable transition from the
   * current case status. Returns the transition definition if successful,
   * null if no auto-transition is possible.
   */
  private async tryAutoTransition(case_: Case): Promise<TransitionDefinition | null> {
    // If there's already a pending gate on this case, don't try more transitions
    if (case_.pending_gate) return null;

    // Load project's lifecycle profile for gate checks
    const profile = await this.adapter.getProjectLifecycleProfile(case_.project_id);

    let candidates = getAutoTransitionsFrom(case_.status, case_.case_type);

    // Feature flag: when ARBITRA_AUTO_CLOSE_ON_MERGE=false, strip the
    // auto-close-on-merge shortcut transitions so the pipeline falls back to
    // the classic approved → pending_merge → done path. Only the
    // `pr_merged`-gated shortcuts are stripped — the merge-not-applicable
    // skip (approved → done for repo-less cases, issue #687) is a different
    // mechanism and stays available regardless of the flag.
    if (
      AUTO_CLOSE_ON_MERGE_SOURCES.has(case_.status) &&
      !isAutoCloseOnMergeFlagEnabled()
    ) {
      candidates = candidates.filter(
        (c) => !(c.to === 'done' && c.preconditions.includes('pr_merged')),
      );
    }

    // Special case: ready_for_build → in_build is normally manual (no auto_trigger),
    // but when the lifecycle profile sets ready_to_build gate to 'auto', we include it
    // as an auto-transition candidate.
    if (case_.status === 'ready_for_build') {
      const readyToBuildBehavior = resolveGateBehavior('ready_to_build', profile);
      if (readyToBuildBehavior === 'auto') {
        const transition = findTransition('ready_for_build', 'in_build', case_.case_type);
        if (transition && !candidates.some((c) => c.to === 'in_build')) {
          candidates.push(transition);
        }
      }
    }

    if (candidates.length === 0) return null;

    const ctx = await this.adapter.loadPreconditionContext(case_);

    // Auto-skip the merge gate for truly repo-less cases (issue #687): an
    // approved case with NEITHER a PR ref NOR a branch can never satisfy
    // `pr_merged` and would park in `pending_merge` forever. Auto-attach a
    // `merge_not_applicable` decision (system actor — explicit audit trail,
    // mirrors the PR #462 manual-track auto-attach) so the
    // `approved → done` skip transition's precondition holds.
    //
    // Discriminator: ONLY when both `current_pr_ref` and `current_branch`
    // are empty. A recorded branch without a PR does NOT auto-skip — the PR
    // may still arrive via webhook branch-matching; such cases (including
    // sentinel branches like "n/a-...") use the explicit
    // `create_decision(type='merge_not_applicable')` recovery path instead.
    if (
      case_.status === 'approved' &&
      !case_.current_pr_ref &&
      !case_.current_branch
    ) {
      const alreadyAttached = loopbackScopedDecisions(ctx).some(
        (d) => d.type === 'merge_not_applicable',
      );
      if (!alreadyAttached) {
        const decision = await this.adapter.createMergeNotApplicableDecision(case_.case_id);
        ctx.decisions.push(decision);
        await this.adapter.emitEvent(
          case_.case_id,
          'decision_created',
          {
            decision_id: decision.decision_id,
            type: decision.type,
            auto_attached: true,
            reason: 'no_pr_and_no_branch',
          },
          SYSTEM_ACTOR,
        );
      }
    }

    const evaluator = createPreconditionEvaluator(ctx);

    // Try each auto-triggerable transition in order.
    // For in_review, the order in TRANSITION_MATRIX is:
    //   1. approved (auto-approve — best case)
    //   2. needs_human_decision (has_high_critical_findings)
    //   3. needs_human_decision (track_is_direct_and_high_critical_risk —
    //      four-eyes for Direct Track high/critical risk even with no findings)
    //   4. verification_pending (manual track, no high/critical)
    // (A separate in_review → done auto-transition also exists but only fires
    //  on pr_merged via the auto-close-on-merge path, not this review fanout.)
    for (const candidate of candidates) {
      const allSatisfied = await this.checkAllPreconditions(candidate, evaluator);
      if (!allSatisfied) continue;

      // Check gate behavior from lifecycle profile
      const gateId = candidate.from !== 'any' ? findGateId(candidate.from, candidate.to) : null;
      if (gateId) {
        const behavior = resolveGateBehavior(gateId, profile);
        if (behavior === 'confirm') {
          // Preconditions are met but gate requires confirmation.
          // Emit gate_pending event and set pending_gate on the case.
          await this.emitGatePending(case_, candidate, gateId);
          return null;
        }
      }

      await this.executeTransition(case_, candidate);
      return candidate;
    }

    return null;
  }

  /**
   * Called when a confirm gate blocks an auto-transition. Sets pending_gate on the
   * case, emits a gate_pending event, and dispatches notifications.
   */
  private async emitGatePending(
    case_: Case,
    candidate: TransitionDefinition,
    gateId: GateId,
  ): Promise<void> {
    const pendingGate = {
      gate_id: gateId,
      target_status: candidate.to,
      since: new Date().toISOString(),
    };

    await this.adapter.updateCase(case_.case_id, {
      pending_gate: pendingGate,
    } as Partial<Case>);

    await this.adapter.emitEvent(
      case_.case_id,
      'gate_pending',
      {
        gate_id: gateId,
        from_status: case_.status,
        to_status: candidate.to,
        preconditions_satisfied: true,
        awaiting: 'human_confirmation',
      },
      SYSTEM_ACTOR,
    );

    // Google Chat notification is handled by EventNotifier.notifyGatePending
    // (triggered by the gate_pending event emitted above) — no duplicate dispatch here.
  }

  /**
   * Execute a gate confirmation: validate the marker is still current,
   * re-evaluate preconditions against the state machine, execute the
   * blocked transition, and continue the pipeline chain. Called by the
   * DecisionService after a gate_confirmed decision is recorded.
   *
   * Self-validating against staleness (issue #1049). `emitGatePending`
   * writes `pending_gate` while the case sits in `GATE_TRANSITION_MAP[gate_id]
   * .from`, but nothing besides this method and `executeGateRejection` ever
   * clears it (the general write path, `applyTransitionInTransaction`, now
   * also clears it on every transition — see transition-core.ts — but a
   * caller writing status through this class's OWN non-transactional
   * `executeTransition` never runs while a gate is pending, by
   * construction). A legitimate transition that moves the case to a
   * DIFFERENT status (a case-level Request Changes, most commonly) can
   * still leave a marker on record whose `target_status` no longer reflects
   * reality. Trusting it blindly — the pre-#1049 bug — would write
   * `target_status` with no state-machine edge and no precondition check.
   * `GATE_TRANSITION_MAP[gate_id]` is looked up and compared against the
   * case's CURRENT status FIRST: a mismatch means the marker is stale, and
   * it is refused (clearing it) rather than acted on.
   *
   * Even when the marker still matches, preconditions are re-evaluated HERE,
   * at confirm time — not trusted from `emitGatePending`'s emit-time check —
   * through `StateMachine.validateTransition`, the exact same (matrix edge +
   * precondition evaluation) check `applyTransitionInTransaction` performs
   * on the transactional write path used by every other transition in the
   * product. A precondition that regressed between emit and confirm (e.g. a
   * finding reopened) blocks the write with a `TransitionError` instead of
   * silently passing through a stale "preconditions satisfied" marker; the
   * marker itself is left untouched in that case — the gate is still
   * legitimately pending for the case's current status, just not
   * confirmable until the precondition holds again.
   */
  async executeGateConfirmation(caseId: string): Promise<PipelineResult> {
    const case_ = await this.adapter.getCase(caseId);
    if (!case_.pending_gate) {
      throw new Error(`Case ${caseId} has no pending gate to confirm`);
    }

    const gateId = case_.pending_gate.gate_id;
    const staleTargetStatus = case_.pending_gate.target_status;
    const mapping = GATE_TRANSITION_MAP[gateId];

    if (!mapping || case_.status !== mapping.from) {
      // The case moved on since this gate was emitted — clear the stale
      // marker instead of writing whatever `target_status` it still
      // carries. `gate_rejected` is the SAME event `executeGateRejection`
      // emits for an informed decline: it reconciles every other
      // reviewer's now-obsolete `gate_pending` notification and tells the
      // case owner where the case actually landed (EventNotifier reads
      // `case_.status` fresh, not the stale marker).
      await this.adapter.updateCase(caseId, {
        pending_gate: undefined,
      } as Partial<Case>);
      await this.adapter.emitEvent(
        caseId,
        'gate_rejected',
        {
          gate_id: gateId,
          from_status: case_.status,
          to_status: staleTargetStatus,
          rejected: true,
          reason: 'stale_pending_gate',
        },
        SYSTEM_ACTOR,
      );
      throw new ArbitraError(
        `Gate '${gateId}' is stale: it was recorded for status '${mapping?.from ?? 'unknown'}' but case ${caseId} is now '${case_.status}'. The pending gate has been cleared.`,
        'STALE_GATE',
        409,
        {
          case_id: caseId,
          gate_id: gateId,
          expected_status: mapping?.from,
          current_status: case_.status,
        },
      );
    }

    const targetStatus = mapping.to;

    // Re-evaluate preconditions NOW, against live state. Throws
    // TransitionError (409, failed preconditions listed) when no matrix
    // variant is satisfied.
    const ctx = await this.adapter.loadPreconditionContext(case_);
    const transitionDef = await this.stateMachine.validateTransition(
      case_.status,
      targetStatus,
      createPreconditionEvaluator(ctx),
      case_.case_type,
    );

    // When confirming review_to_approved gate, create auto-approve decision
    // so that downstream preconditions (all_steps_completed) are satisfied.
    if (case_.status === 'in_review' && targetStatus === 'approved') {
      await this.adapter.createAutoApproveDecision(case_.case_id);
    }

    // Clear pending_gate and update status. Carries the approval pin for
    // the same reason `executeTransition` does (issue #1045): this is the
    // `review_to_approved: 'confirm'` route used by the strict lifecycle
    // preset, a third write path into `approved` that never reaches
    // `transition-core.ts`. Rule lives in `approval-pin.ts`.
    await this.adapter.updateCase(caseId, {
      pending_gate: undefined,
      status: targetStatus,
      updated_at: new Date().toISOString(),
      ...approvalPinPatch(targetStatus, case_),
    } as Partial<Case>);

    // A confirmed `pending_merge_to_done` gate reaches `done` without going
    // through `executeTransition`, so it needs the same completion cleanup.
    if (targetStatus === 'done') {
      await this.adapter.closeOutstandingWaiverProposals(caseId);
    }

    // Emit the events of the ACTUAL satisfied transition variant — matters
    // for (from, to) pairs with more than one (e.g. pending_merge → done
    // via pr_merged OR merge_not_applicable); `transitionDef` is guaranteed
    // to exist (validateTransition above throws otherwise), unlike the old
    // best-effort `findTransition` re-lookup this replaces.
    for (const eventType of transitionDef.events) {
      await this.adapter.emitEvent(
        caseId,
        eventType,
        {
          from_status: case_.status,
          to_status: targetStatus,
          triggered_by: 'gate_confirmation',
          gate_id: gateId,
        },
        SYSTEM_ACTOR,
      );
    }

    // Emit gate_confirmed event
    await this.adapter.emitEvent(
      caseId,
      'gate_confirmed',
      {
        gate_id: gateId,
        from_status: case_.status,
        to_status: targetStatus,
      },
      SYSTEM_ACTOR,
    );

    // Continue the pipeline chain (schedule runs, evaluate downstream transitions)
    return this.onRunCompleted(caseId);
  }

  /**
   * Execute a gate rejection: clear pending_gate, keep case in current state.
   */
  async executeGateRejection(caseId: string): Promise<void> {
    const case_ = await this.adapter.getCase(caseId);
    if (!case_.pending_gate) {
      throw new Error(`Case ${caseId} has no pending gate to reject`);
    }

    const gateId = case_.pending_gate.gate_id;
    const targetStatus = case_.pending_gate.target_status;

    // Clear pending_gate — case stays in current status
    await this.adapter.updateCase(caseId, {
      pending_gate: undefined,
      updated_at: new Date().toISOString(),
    } as Partial<Case>);

    // Emit gate_rejected event
    await this.adapter.emitEvent(
      caseId,
      'gate_rejected',
      {
        gate_id: gateId,
        from_status: case_.status,
        to_status: targetStatus,
        rejected: true,
      },
      SYSTEM_ACTOR,
    );
  }

  private async checkAllPreconditions(
    transition: TransitionDefinition,
    evaluator: { evaluate(id: string): Promise<{ satisfied: boolean }> },
  ): Promise<boolean> {
    for (const preconditionId of transition.preconditions) {
      const result = await evaluator.evaluate(preconditionId);
      if (!result.satisfied) return false;
    }
    return true;
  }

  private async executeTransition(case_: Case, transition: TransitionDefinition): Promise<void> {
    // When auto-approving (in_review → approved), create an auto_approve Decision
    // so that the approved → done precondition (all_steps_completed) is satisfied.
    if (case_.status === 'in_review' && transition.to === 'approved') {
      await this.adapter.createAutoApproveDecision(case_.case_id);
    }

    // Approval pin (issue #1045). This is the AUTONOMOUS `in_review ->
    // approved` edge — `review_to_approved: 'auto'` in both the autonomous
    // and standard lifecycle presets — so it is one of the normal ways a
    // case gets approved, and it never reaches `transition-core.ts`. Merged
    // into the status write itself so the pin cannot be committed apart
    // from the approval it describes. Rule lives in `approval-pin.ts`.
    await this.adapter.updateCaseStatus(
      case_.case_id,
      transition.to,
      approvalPinPatch(transition.to, case_),
    );

    // Completion closes any waiver proposal a human never confirmed — after
    // `done` no surface offers the confirm/reject action anymore (issue #751).
    if (transition.to === 'done') {
      await this.adapter.closeOutstandingWaiverProposals(case_.case_id);
    }

    for (const eventType of transition.events) {
      await this.adapter.emitEvent(
        case_.case_id,
        eventType,
        {
          from_status: case_.status,
          to_status: transition.to,
          triggered_by: 'autonomous_pipeline',
        },
        SYSTEM_ACTOR,
      );
    }

    // Dispatch push notifications for key transitions
    this.dispatchTransitionNotification(case_, transition.to).catch((err) =>
      console.warn('[Pipeline] Push notification dispatch failed:', err),
    );
  }

  /**
   * Send push notifications (Google Chat webhook) for state transitions
   * that require human action. Informational transitions (approved, done)
   * only generate in-app notifications — no external push.
   */
  private async dispatchTransitionNotification(case_: Case, toStatus: CaseStatus): Promise<void> {
    switch (toStatus) {
      case 'needs_human_decision':
        await this.dispatcher.dispatch({ event: 'case_needs_decision', case_ });
        break;
      // in_build loopback notification is handled by EventNotifier.notifyChangesRequested
      // (which has access to the decision rationale) — no duplicate dispatch here
    }
  }

  /** Expose the adapter for external services (e.g. DecisionService) that need to trigger pipeline continuation */
  getAdapter(): PipelineAdapter {
    return this.adapter;
  }

  private async scheduleRunsForStatus(
    case_: Case,
  ): Promise<Array<{ run_id: string; run_type: RunType }>> {
    const runTypes = STATUS_RUN_SCHEDULE[case_.status];
    if (!runTypes || runTypes.length === 0) return [];

    const scheduled: Array<{ run_id: string; run_type: RunType }> = [];
    for (const runType of runTypes) {
      // Check if there's already an active run of this type
      const activeRuns = await this.adapter.getActiveRuns(case_.case_id);
      const alreadyRunning = activeRuns.some((r) => r.run_type === runType);
      if (alreadyRunning) continue;

      // review_run: resolve diff from GitHub and run LLM review asynchronously.
      // The ReviewService creates its own run record and triggers onRunCompleted when done.
      if (runType === 'review_run') {
        // Precondition: a review needs a diff source. If the case has neither a
        // PR ref nor a branch, skip the auto-review entirely — the retry loop
        // would just fail 3× with "Diff could not be fetched from GitHub".
        // Post a single system comment so the user knows why nothing happened.
        if (!case_.current_pr_ref && !case_.current_branch) {
          await this.adapter.updateCase(case_.case_id, { review_not_applicable: true });
          await this.adapter.emitEvent(
            case_.case_id,
            'comment_added',
            {
              comment_type: 'system',
              body: 'Auto-review skipped: no PR or branch attached to this case. Attach a PR/branch or use a manual decision.',
            },
            SYSTEM_ACTOR,
          );
          await this.adapter.emitEvent(
            case_.case_id,
            'review_marked_not_applicable',
            { reason: 'no_diff_source' },
            SYSTEM_ACTOR,
          );
          continue;
        }
        if (this.adapter.resolveAndRunReview) {
          const MAX_REVIEW_RETRIES = 3;
          const REVIEW_RETRY_DELAY_MS = 3000;

          const attemptReview = async (): Promise<void> => {
            let currentCase = case_;
            for (let attempt = 1; attempt <= MAX_REVIEW_RETRIES; attempt++) {
              try {
                const { run } = await this.adapter.resolveAndRunReview!(currentCase.case_id);
                if (run) {
                  // Review started successfully — schedule a timeout check.
                  this.scheduleRunTimeoutCheck('review_run', currentCase, run.run_id);
                  return;
                }
                // Diff not resolved — retry after delay (PR ref may not be set yet)
                if (attempt < MAX_REVIEW_RETRIES) {
                  console.warn(`[Pipeline] Auto-review attempt ${attempt}/${MAX_REVIEW_RETRIES} for ${currentCase.case_id}: diff not resolved (PR: ${currentCase.current_pr_ref || 'none'}, branch: ${currentCase.current_branch || 'none'}), retrying in ${REVIEW_RETRY_DELAY_MS}ms…`);
                  await new Promise(resolve => setTimeout(resolve, REVIEW_RETRY_DELAY_MS));
                  // Re-fetch case to pick up any newly-set PR ref / branch
                  currentCase = await this.adapter.getCase(currentCase.case_id);
                }
              } catch (err) {
                // Real error — don't retry, create a failed run record
                console.error(`[Pipeline] Auto-review failed for ${currentCase.case_id}:`, err);
                const failedRun = await this.adapter.createRun(currentCase.case_id, 'review_run', SYSTEM_ACTOR);
                await this.adapter.failRun(
                  failedRun.run_id,
                  currentCase.case_id,
                  `Auto-review failed: ${err instanceof Error ? err.message : String(err)}`,
                );
                await this.adapter.emitEvent(
                  currentCase.case_id,
                  'run_created',
                  { run_id: failedRun.run_id, run_type: 'review_run', scheduled_by: 'autonomous_pipeline', error: 'diff_resolve_failed' },
                  SYSTEM_ACTOR,
                );
                return;
              }
            }

            // All retries exhausted — post system comment with specific reason
            const hasRefs = !!(currentCase.current_pr_ref || currentCase.current_branch);
            const reason = hasRefs
              ? `Diff could not be fetched from GitHub (PR: ${currentCase.current_pr_ref || 'none'}, branch: ${currentCase.current_branch || 'none'}). Check that GITHUB_TOKEN is set and has read access to the repository.`
              : 'No PR or branch reference set on the case. Please set current_pr_ref or current_branch and trigger /review manually.';
            console.warn(`[Pipeline] Auto-review skipped for ${currentCase.case_id} after ${MAX_REVIEW_RETRIES} attempts: ${reason}`);
            await this.adapter.updateCase(currentCase.case_id, { review_not_applicable: true });
            await this.adapter.emitEvent(
              currentCase.case_id,
              'comment_added',
              {
                comment_type: 'system',
                body: `Auto-review could not start after ${MAX_REVIEW_RETRIES} attempts: ${reason}`,
              },
              SYSTEM_ACTOR,
            );
            await this.adapter.emitEvent(
              currentCase.case_id,
              'review_marked_not_applicable',
              { reason: 'diff_fetch_retries_exhausted', attempts: MAX_REVIEW_RETRIES },
              SYSTEM_ACTOR,
            );
            // Resume the pipeline so the case can leave `in_review`. Without
            // this, the case parks in_review after all retries are exhausted
            // and the manual-track approve flow has no way to advance
            // (`auto_approve_criteria_met` / `track_is_manual_and_no_high_critical`
            // are now satisfiable but no one is driving the transition).
            try {
              await this.onRunCompleted(currentCase.case_id);
            } catch (err) {
              console.warn(
                `[Pipeline] Pipeline resume after review_not_applicable failed for ${currentCase.case_id}:`,
                err,
              );
            }
          };

          // Fire-and-forget: the review runs asynchronously. The pipeline chain stops here
          // (activeRuns check will find the running review_run) and resumes when the review
          // completes and calls onRunCompleted().
          attemptReview();
        }
        continue;
      }

      // Non-review runs: create and complete immediately (rule_run with no active rules = auto-pass,
      // evidence_collection_run = evidence arrives via webhooks/manual).
      const run = await this.adapter.createRun(case_.case_id, runType, SYSTEM_ACTOR);
      await this.adapter.completeRun(run.run_id, case_.case_id, `${runType} completed (auto)`);
      run.status = 'completed' as Run['status'];

      scheduled.push({ run_id: run.run_id, run_type: runType });

      await this.adapter.emitEvent(
        case_.case_id,
        'run_created',
        { run_id: run.run_id, run_type: runType, scheduled_by: 'autonomous_pipeline' },
        SYSTEM_ACTOR,
      );

      if (this.onRunScheduled) {
        this.onRunScheduled(run, case_);
        this.scheduleRunTimeoutCheck(runType, case_, run.run_id);
      }
    }
    return scheduled;
  }

  /**
   * Schedule a timeout check for a run type on a case. If the specific run
   * is still in pending/running state after RUN_TIMEOUT_MS, create a
   * `run_stalled` notification for the case owner.
   *
   * De-dupe: the notified-once flag is claimed via
   * `adapter.markRunTimeoutNotified(runId)` — an idempotent Firestore
   * transaction on the run doc — instead of the old in-memory `Set`, so it
   * survives a container restart mid-wait. Falls back to always-notify when
   * the adapter doesn't implement it (test doubles / older adapters).
   */
  private scheduleRunTimeoutCheck(runType: RunType, case_: Case, runId: string): void {
    setTimeout(async () => {
      try {
        const activeRuns = await this.adapter.getActiveRuns(case_.case_id);
        const stillRunning = activeRuns.some((r) => r.run_id === runId && r.run_type === runType);
        if (!stillRunning) return;

        if (this.adapter.markRunTimeoutNotified) {
          const alreadyNotified = await this.adapter.markRunTimeoutNotified(runId);
          if (alreadyNotified) return;
        }

        const runLabel = runType === 'review_run' ? 'AI Review' : runType.replace(/_/g, ' ');
        await this.notificationService.notify({
          user_id: case_.owner_user_id,
          type: 'run_stalled',
          title: 'Pipeline task taking longer than expected',
          body: `${runLabel} for '${case_.title}' has been running for over ${Math.round(RUN_TIMEOUT_MS / 1000)} seconds. It may need attention.`,
          case_id: case_.case_id,
        });
      } catch (err) {
        console.error(`[Pipeline] Timeout notification failed for ${case_.case_id}:${runType}:${runId}:`, err);
      }
    }, RUN_TIMEOUT_MS);
  }

  private computeNextActions(case_: Case): NextAction[] {
    const actions: NextAction[] = [];

    // If there's a pending gate, the primary action is to confirm/decline it
    if (case_.pending_gate) {
      actions.push({
        type: 'await_human',
        reason: `Awaiting gate confirmation to proceed to ${case_.pending_gate.target_status}`,
      });
      return actions;
    }

    switch (case_.status) {
      case 'open':
        actions.push({ type: 'await_human', reason: 'Triage required: set scope, track, and risk level' });
        break;
      case 'exploration':
        actions.push({ type: 'start_run', run_type: 'exploration_run', reason: 'Start exploration to analyze codebase' });
        break;
      case 'ready_for_build':
        actions.push({ type: 'await_human', reason: 'Developer must start implementation' });
        break;
      case 'in_build':
        actions.push({ type: 'await_ci', reason: 'Waiting for PR creation and CI results' });
        break;
      case 'in_validation':
        actions.push({ type: 'start_run', run_type: 'rule_run', reason: 'Run rule evaluation' });
        break;
      case 'in_review':
        actions.push({ type: 'start_run', run_type: 'review_run', reason: 'Run LLM-based code review' });
        break;
      case 'needs_human_decision':
        actions.push({ type: 'await_human', reason: 'Human decision required for high/critical findings' });
        break;
      case 'verification_pending':
        actions.push({ type: 'await_human', reason: 'Manual validation required' });
        break;
      case 'approved':
        actions.push({ type: 'transition_ready', target: 'pending_merge' });
        break;
      case 'pending_merge':
        actions.push({ type: 'transition_ready', target: 'done' });
        break;
      case 'done':
        actions.push({ type: 'case_complete' });
        break;
      case 'rejected':
        actions.push({ type: 'case_complete' });
        break;
    }

    return actions;
  }
}
