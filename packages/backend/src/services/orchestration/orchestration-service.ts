import type { Case, CaseEvent, CaseStatus } from '@arbitra/shared';
import { ArbitraError } from '@arbitra/shared';
import { CaseRepository } from '../case/case-repository.js';
import { EventService } from '../event/event-service.js';
import { StateMachine } from './state-machine.js';
import { getDb } from '../../lib/firestore.js';
import {
  applyTransitionInTransaction,
  loadTransactionPreconditionContext,
} from './transition-core.js';
import { closeOutstandingWaiverProposalsOnCompletion } from './waiver-completion.js';
import {
  acquireCasePipelineLock,
  CasePipelineLockHeldError,
  type CasePipelineLockHandle,
} from './case-pipeline-lock.js';

export class OrchestrationService {
  constructor(
    private readonly caseRepo = new CaseRepository(),
    private readonly eventService = new EventService(),
    private readonly stateMachine = new StateMachine(),
  ) {}

  /**
   * Transition one case, in its own transaction.
   *
   * The transaction body lives in `applyTransitionInTransaction` so the
   * assistant task executor can commit the same validated transition together
   * with its own writes — see `transition-core.ts`. This method's observable
   * behaviour is unchanged by that extraction: same read order, same status
   * write, same events with the same payloads, same return value, and the same
   * post-commit waiver cleanup.
   *
   * Concurrency (issue #754): this is an explicit transition request (a human
   * decision, or a direct `/transition` call) racing the pipeline's own
   * auto-transition cycle (`RunCompletionHandler.onRunCompleted`,
   * `case-pipeline-lock.ts`) for the SAME case. Before #754 this method opened
   * its transaction directly, with no coordination against that cycle — two
   * near-simultaneous transitions could both read the same pre-transition
   * state and both commit, double-firing transition side effects (duplicate
   * `waived_on_completion` decisions on completion, per #753's review).
   *
   * This now takes the same per-case pipeline lock `onRunCompleted` takes,
   * mirroring its acquire/release discipline (see below), but with a
   * DIFFERENT response to a held lock: `onRunCompleted`'s callers are
   * fire-and-forget auto-transition triggers, so a loser can no-op cleanly —
   * the winner's evaluation already covers the state change. This method's
   * caller is an explicit human/agent decision — silently no-op'ing here would
   * make the decision look like it succeeded when the case never moved.
   * Instead a held lock is surfaced as a retryable 409 conflict
   * (`CASE_PIPELINE_LOCKED`) so the caller can represent it honestly and retry
   * rather than either silently proceeding (the pre-#754 bug) or retrying
   * forever in-process.
   *
   * Fail-open on any OTHER lock-acquisition error mirrors `onRunCompleted`
   * exactly (auxiliary locking infra must never become a new way to block a
   * transition outright) — that fail-open policy itself is issue #730's open
   * decision, deliberately unchanged here.
   */
  async transition(
    caseId: string,
    targetStatus: CaseStatus,
    actorId: string,
  ): Promise<Case> {
    let lock: CasePipelineLockHandle | null = null;
    try {
      lock = await acquireCasePipelineLock(caseId);
    } catch (err) {
      if (err instanceof CasePipelineLockHeldError) {
        // The pipeline is mid-evaluation for this case. Unlike
        // `onRunCompleted`'s auto-transition callers, this is an explicit
        // transition request — no-op'ing here would silently lie to the
        // caller about whether the transition happened. Surface a retryable
        // conflict instead.
        throw new ArbitraError(
          `Case ${caseId} is mid-transition (pipeline lock held); retry in a moment.`,
          'CASE_PIPELINE_LOCKED',
          409,
          { case_id: caseId },
        );
      }
      // Any other failure to acquire the lock (Firestore unreachable, a test
      // double that doesn't stub the lock's transaction surface, etc.) is
      // logged and the transition proceeds unlocked — mirrors
      // `onRunCompleted`'s fail-open policy (issue #730 is the open decision
      // on whether that should change; out of scope here).
      console.warn(
        `[OrchestrationService] Failed to acquire case pipeline lock for ${caseId}, proceeding without it:`,
        err,
      );
    }

    try {
      const db = getDb();

      let committedEvents: CaseEvent[] = [];
      const updated = await db.runTransaction(async (transaction) => {
        const result = await applyTransitionInTransaction(
          transaction,
          caseId,
          targetStatus,
          actorId,
          {
            caseRepo: this.caseRepo,
            eventService: this.eventService,
            stateMachine: this.stateMachine,
            loadPreconditionContext: loadTransactionPreconditionContext,
          },
        );
        // Firestore may retry this callback on contention — reassign (never
        // append) so a stale attempt's events can never survive alongside the
        // one that actually commits.
        committedEvents = result.committedEvents;
        return result.case;
      });

      // Notify for the events the transaction just committed — the same
      // fire-and-forget hook `EventService.emit` uses for the non-transactional
      // path, run here because `emitInTransaction` itself cannot know whether
      // this transaction will still abort when it stages the write. See
      // `EventService.notifyCommitted`.
      this.eventService.notifyCommitted(committedEvents);

      // Completion closes any waiver proposal a human never confirmed — after
      // `done` no surface offers the confirm/reject action anymore (issue #751).
      // Runs AFTER the commit (its writes are non-transactional and would conflict
      // on transaction retry) and awaited so the trail is consistent before the
      // caller sees the completed case. Non-fatal by contract: the closer never
      // throws, so it can never reject an already-committed transition.
      if (targetStatus === 'done') {
        await closeOutstandingWaiverProposalsOnCompletion(caseId, 'completion');
      }

      return updated;
    } finally {
      if (lock) {
        await lock.release().catch((err) => {
          console.warn(`[OrchestrationService] Failed to release case pipeline lock for ${caseId}:`, err);
        });
      }
    }
  }

  async getValidTransitions(caseId: string): Promise<CaseStatus[]> {
    const case_ = await this.caseRepo.getById(caseId);
    const transitions = this.stateMachine.getValidTransitions(case_.status, case_.case_type);
    // Dedupe: some (from, to) pairs have multiple precondition variants
    // (e.g. pending_merge → done via pr_merged OR merge_not_applicable).
    return [...new Set(transitions.map((t) => t.to))];
  }
}
