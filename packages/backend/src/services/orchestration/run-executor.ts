import type { Run, Case } from '@arbitra/shared';
import { isAssistantRunType } from '@arbitra/shared';
import type { PipelineAdapter } from './pipeline-adapter.js';
// Type-only: `pipeline.ts` imports `RunExecutor` as a VALUE (to dispatch
// retries), so this side must stay type-only to avoid a runtime
// circular import between the two modules.
import type { RunCompletionHandler } from './pipeline.js';
// Type-only for the same reason and one more: the assistant task runner is
// loaded lazily (see `resolveAssistantRunner`) so this module stays importable
// by adapters that never execute an assistant task.
import type { AssistantTaskRunner } from '../assistant/assistant-task-executor.js';
import { newWorkerId } from './run-worker-id.js';

/**
 * How often to refresh a run's Firestore lease while `execute()` is working.
 * Must stay comfortably below the lease TTL (`ARBITRA_RUN_LEASE_TTL_MS`,
 * default 5 min) so a still-alive execution never appears orphaned to the
 * stale-run sweep. Default 1 minute.
 */
const HEARTBEAT_INTERVAL_MS = parseInt(
  process.env['ARBITRA_RUN_HEARTBEAT_INTERVAL_MS'] ?? '60000',
  10,
);

/**
 * Executes scheduled runs in the background.
 * For MVP, handles rule_run in-process.
 * Review runs require a diff and are triggered separately via POST /api/runs.
 */
export class RunExecutor {
  /** Memoised lazy-loaded default assistant runner. See `resolveAssistantRunner`. */
  private lazyAssistantRunner: AssistantTaskRunner | null = null;

  constructor(
    private readonly adapter: PipelineAdapter,
    private readonly pipeline: RunCompletionHandler,
    /**
     * Runner for `assistant_task_run`. Left undefined in production — the
     * default is loaded lazily on first use — and injectable so a caller can
     * substitute one.
     */
    private readonly assistantRunner?: AssistantTaskRunner,
  ) {}

  /**
   * Dispatch a run for background execution.
   * Returns immediately — actual work happens asynchronously.
   */
  dispatch(run: Run, case_: Case): void {
    setImmediate(() => {
      this.execute(run, case_).catch((err) => {
        console.error(`[RunExecutor] Run ${run.run_id} (${run.run_type}) failed:`, err);
      });
    });
  }

  private async execute(dispatchedRun: Run, case_: Case): Promise<void> {
    // Ownership first: a run dispatched to us unclaimed has no lease and no
    // `worker_id` yet, so it must be claimed BEFORE the heartbeat starts (the
    // heartbeat needs a `worker_id`) and before any work happens (losing the
    // claim means another worker owns this run and we must stand down). A
    // no-op for every run created via `createRun` — see `claimIfUnclaimed`.
    const run = await this.claimIfUnclaimed(dispatchedRun);
    if (!run) return;

    const stopHeartbeat = this.startLeaseHeartbeat(run);
    try {
      // Mark as running
      await this.adapter.emitEvent(
        case_.case_id,
        'run_started',
        { run_id: run.run_id, run_type: run.run_type },
        'system:run-executor',
      );

      let executed = true;
      switch (run.run_type) {
        case 'rule_run':
          executed = await this.executeRuleRun(run, case_);
          break;
        case 'evidence_collection_run':
          // Evidence comes from webhooks/manual upload — just mark as completed
          await this.adapter.completeRun(run.run_id, case_.case_id, 'Evidence collection — awaiting external input');
          break;
        case 'assistant_task_run':
        case 'assistant_action_run':
          executed = await this.executeAssistantRun(run, case_);
          break;
        default:
          await this.handleExecutionFailure(run, case_, `No executor for run type: ${run.run_type}`);
          return;
      }

      // After execution, re-evaluate pipeline for auto-transitions. Skipped
      // when `executed` is false — `executeRuleRun` already routed the
      // failure through `handleExecutionFailure` (which calls
      // `onRunCompleted` itself), so calling it again here would just be a
      // redundant re-evaluation of the same, unchanged state.
      if (executed) {
        await this.pipeline.onRunCompleted(case_.case_id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown execution error';
      await this.handleExecutionFailure(run, case_, message);
    } finally {
      // Clear the heartbeat regardless of outcome. `completeRun`/`failRun`
      // already clear `lease_expires_at`/`worker_id` on the run doc itself —
      // this only stops the in-process timer so it can't fire again and
      // resurrect a lease on a run that's already terminal.
      stopHeartbeat();
    }
  }

  /**
   * Fail the run, then hand off to the pipeline's retry decision
   * (`handleRunFailure`) and re-evaluate the case (`onRunCompleted`). Fixes a
   * gap (PR #742): this executor's catches used to call
   * `adapter.failRun` directly and never reached `handleRunFailure`, so a
   * transient `rule_run` failure dead-ended forever — the stale-run sweep
   * only queries `pending`/`running` runs, so an already-`failed` run is
   * invisible to it without this wiring.
   *
   * Lock-reentrancy: `onRunCompleted` acquires a per-case Firestore
   * lock for the duration of its own evaluation. Could THIS call race one
   * that's still holding it? `execute()` only ever runs via
   * `RunExecutor.dispatch()`'s `setImmediate`, and the only caller of
   * `dispatch()` is `RunCompletionHandler.retryRun` — itself only reachable
   * through `dispatchScheduledRetry`, which fires from either a 10s/30s-later
   * `setTimeout` or a separate stale-run sweep pass. Neither runs nested
   * inside another `onRunCompleted` call's synchronous stack, so in practice
   * this never races the SAME call that scheduled it. But the safety
   * argument doesn't depend on that timing: `onRunCompleted`'s lock-acquire
   * failure path is an explicit, designed no-op (see its own doc comment) —
   * not an error — so calling it here is safe by construction regardless of
   * what else might be evaluating this case concurrently.
   */
  private async handleExecutionFailure(run: Run, case_: Case, message: string): Promise<void> {
    const failed = await this.adapter.failRun(run.run_id, case_.case_id, message).catch((err) => {
      console.error(`[RunExecutor] failRun itself failed for run ${run.run_id}:`, err);
      return null;
    });
    const failedRun: Run = failed ?? { ...run, status: 'failed', error_message: message };

    // A cancellation may commit between the runner throwing and this generic
    // failure handler reaching Firestore. The adapter returns the fresh
    // cancelled Run instead of overwriting it; cancellation is terminal and
    // must never enter retry or terminal-failure repair.
    if (failedRun.status === 'cancelled' || failedRun.assistant_cancel_intent !== undefined) {
      console.info(
        `[RunExecutor] Run ${run.run_id} was cancelled while handling a failure — `
          + 'skipping retry and failure repair.',
      );
      return;
    }

    // The stale-run sweeper already emits this event. The normal in-process
    // path must do the same so the Case timeline does not depend on which
    // failure path happened to observe the Run. Only emit after `failRun`
    // actually landed; otherwise the event would claim a durable state that
    // Firestore does not contain.
    if (failed?.status === 'failed') {
      await this.adapter.emitEvent(
        case_.case_id,
        'run_failed',
        {
          run_id: failedRun.run_id,
          run_type: failedRun.run_type,
          attempt: failedRun.attempt ?? 1,
          error: failedRun.error_message,
          in_process: true,
        },
        'system:run-executor',
      ).catch((err) => {
        console.error(`[RunExecutor] Failed to emit run_failed for run ${run.run_id}:`, err);
      });
    }

    await this.pipeline.handleRunFailure(failedRun).catch((err) => {
      console.error(`[RunExecutor] handleRunFailure failed for run ${run.run_id}:`, err);
    });
    await this.pipeline.onRunCompleted(case_.case_id).catch((err) => {
      console.error(
        `[RunExecutor] onRunCompleted failed for case ${case_.case_id} after run ${run.run_id} failed:`,
        err,
      );
    });

    // A permanently failed assistant run carries a repair marker that is
    // discharged by the case becoming TERMINAL, not by the hold being written —
    // and the evaluation above is what makes it terminal. Observing that here
    // keeps the in-process path from leaving sweep work behind; anything this
    // misses (a lost pipeline-lock race, an evaluation that threw, this instance
    // dying) still keeps its marker and is recovered by the assistant sub-sweep.
    // Scoped to assistant run types: no other run type has a marker at all.
    //
    // try/catch rather than `.catch()`: a SYNCHRONOUS throw here would escape
    // `handleExecutionFailure` into `executeAssistantRun`'s catch, which would
    // call this method a second time for the same run.
    if (isAssistantRunType(failedRun.run_type)) {
      try {
        await this.pipeline.settleAssistantFailureRepair(failedRun);
      } catch (err) {
        console.warn(
          `[RunExecutor] Failed to settle the terminal-failure repair for assistant run ${run.run_id}:`,
          err,
        );
      }
    }
  }

  /**
   * Resolve which run doc this execution actually owns.
   *
   * Runs created via `createUnclaimedRun` carry `awaiting_claim` and have no
   * lease and no `worker_id` — ownership is decided here rather than at
   * creation time, so the same run can safely be dispatched from two places
   * (an in-process dispatch racing the assistant sub-sweep's recovery
   * dispatch) and still execute exactly once.
   *
   * Returns the post-claim run doc on a win, or `null` when another worker
   * already owns it and this execution must stand down without touching the
   * run (no `failRun`: the run is not broken, it is simply not ours — failing
   * it would clobber a live execution).
   *
   * Pass-through for every run that is NOT flagged `awaiting_claim`, which is
   * every run created by `createRun` — the six pre-existing run types never
   * reach the claim path. Also a pass-through when the adapter doesn't
   * implement `claimRun` (demo/in-memory adapters): the run then executes
   * unclaimed exactly as it would have before this method existed.
   *
   * Deliberately NOT wrapped in a try/catch: if the claim itself errors, the
   * throw propagates to `dispatch`'s logger and the run stays `pending` /
   * `awaiting_claim`, which is exactly the state the assistant sub-sweep
   * recovers from. Routing this through `handleExecutionFailure` instead would
   * fail a run we never established ownership of.
   */
  private async claimIfUnclaimed(run: Run): Promise<Run | null> {
    if (!run.awaiting_claim || !this.adapter.claimRun) return run;

    const { claimed, run: claimedRun } = await this.adapter.claimRun(run.run_id, newWorkerId());
    if (!claimed || !claimedRun) {
      console.info(
        `[RunExecutor] Run ${run.run_id} (${run.run_type}) was already claimed by another worker — standing down.`,
      );
      return null;
    }
    return claimedRun;
  }

  /**
   * Execute an assistant run.
   *
   * This method owns the run-durability contract around the task body; the body
   * itself is `AssistantTaskExecutor`. By the time it is called the run has been
   * claimed exactly once (`claimIfUnclaimed`) and is being heartbeated
   * (`startLeaseHeartbeat`) — the two steps that must happen once per attempt
   * for every run type, which is why they live here and not in the runner.
   *
   * Four possible verdicts, and each maps to a different treatment of the run:
   *
   * - `completed` — the runner already wrote the run's completion inside its own
   *   atomic transaction. Touch nothing.
   * - `discarded` — nothing should be persisted but the run is still ours;
   *   complete it with the reason so the lease is released and the timeline
   *   records why.
   * - `stood_down` — the run is no longer ours (terminal, reassigned, gone).
   *   Touch NOTHING: completing it would resurrect a terminal run, and failing
   *   it would clobber whoever owns it now.
   * - `failed` — route through `handleExecutionFailure` so the retry policy and
   *   the pipeline both see it, exactly as `executeRuleRun` does.
   *
   * ## When no runner applies
   *
   * `assistant_action_run` has no executor (an acting tool does not exist — see
   * `tool-registry.ts`), and an `assistant_task_run` whose case carries no
   * `assistant_context.requester_user_id` cannot be executed either: without a
   * requester there is no access scope to resolve for its tools, and running it
   * under the system actor is exactly the data leak the tool layer exists to
   * prevent. Both keep the durability-only behaviour: the run is completed with
   * a recorded reason so its lease is released and it does not sit `running`
   * behind a lease nobody renews.
   *
   * Returns `true` on success, `false` if it routed the failure through
   * `handleExecutionFailure` (same contract as `executeRuleRun`).
   */
  private async executeAssistantRun(run: Run, case_: Case): Promise<boolean> {
    try {
      const runner = await this.resolveAssistantRunner(run, case_);
      if (!runner) {
        await this.adapter.completeRun(
          run.run_id,
          case_.case_id,
          `${run.run_type.replace(/_/g, ' ')} claimed — ${this.noRunnerReason(run, case_)}`,
        );
        return true;
      }

      const outcome = await runner.run(run, case_);
      switch (outcome.outcome) {
        case 'completed':
          return true;
        case 'discarded':
          await this.adapter.completeRun(run.run_id, case_.case_id, outcome.summary);
          return true;
        case 'stood_down':
          console.info(
            `[RunExecutor] Assistant run ${run.run_id} stood down (${outcome.reason}) — leaving the run untouched.`,
          );
          return true;
        case 'failed':
          await this.handleExecutionFailure(run, case_, outcome.message);
          return false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Assistant run execution failed';
      await this.handleExecutionFailure(run, case_, message);
      return false;
    }
  }

  /** Why this assistant run gets the durability-only path. */
  private noRunnerReason(run: Run, case_: Case): string {
    if (run.run_type !== 'assistant_task_run') return 'no task handler for this run type';
    if (!case_.assistant_context?.requester_user_id) {
      return 'the case records no requester, so no access scope can be resolved for its tools';
    }
    return 'no task handler available';
  }

  /**
   * The runner for this run, or `null` when the durability-only path applies.
   *
   * The default is imported lazily (same idiom as `executeRuleRun`'s service
   * imports) rather than constructed in the constructor: it pulls in Firestore,
   * the artifact storage adapter and the LLM provider, none of which the other
   * run types need, and `run-executor.ts` is imported by `pipeline.ts` on every
   * pipeline evaluation.
   */
  private async resolveAssistantRunner(
    run: Run,
    case_: Case,
  ): Promise<AssistantTaskRunner | null> {
    if (run.run_type !== 'assistant_task_run') return null;
    if (!case_.assistant_context?.requester_user_id) return null;
    if (this.assistantRunner) return this.assistantRunner;
    if (!this.lazyAssistantRunner) {
      const { AssistantTaskExecutor } = await import('../assistant/assistant-task-executor.js');
      // Claim capability is a property of THIS adapter, so it is answered here
      // and handed over explicitly. The executor must not re-derive it from a
      // run document — see `AssistantTaskExecutor.readRunState`.
      this.lazyAssistantRunner = new AssistantTaskExecutor({
        claimCapable: typeof this.adapter.claimRun === 'function',
      });
    }
    return this.lazyAssistantRunner;
  }

  /**
   * Start refreshing `run`'s lease on an interval so a long execution never
   * looks orphaned to the (separate) stale-run sweep. No-op when the adapter
   * doesn't support lease refresh (e.g. demo/in-memory adapters) or the run
   * has no `worker_id` (older run docs, or an adapter that doesn't stamp one).
   * Returns a function that stops the heartbeat.
   */
  private startLeaseHeartbeat(run: Run): () => void {
    if (!this.adapter.refreshRunLease || !run.worker_id) {
      return () => {};
    }
    const { run_id: runId, worker_id: workerId } = run;
    const timer = setInterval(() => {
      this.adapter.refreshRunLease!(runId, workerId).catch((err) => {
        console.warn(`[RunExecutor] Lease heartbeat failed for run ${runId}:`, err);
      });
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(timer);
  }

  /** Returns `true` on success, `false` if it routed the failure through `handleExecutionFailure`. */
  private async executeRuleRun(run: Run, case_: Case): Promise<boolean> {
    try {
      const { RuleService } = await import('../rule/rule-service.js');
      const { EvidenceRepository } = await import('../evidence/evidence-repository.js');

      const ruleService = new RuleService();
      const evidenceRepo = new EvidenceRepository();
      const evidence = await evidenceRepo.getByCaseId(case_.case_id);

      await ruleService.evaluateRulesForCase(
        case_,
        evidence,
        run.run_id,
        'system:run-executor',
      );

      await this.adapter.completeRun(
        run.run_id,
        case_.case_id,
        'Rule evaluation completed',
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Rule evaluation failed';
      await this.handleExecutionFailure(run, case_, message);
      return false;
    }
  }
}
