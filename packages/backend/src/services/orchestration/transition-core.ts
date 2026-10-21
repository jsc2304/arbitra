import type { Case, CaseEvent, CaseStatus, EventType } from '@arbitra/shared';
import { FieldValue } from 'firebase-admin/firestore';
import { CaseRepository } from '../case/case-repository.js';
import { EventService } from '../event/event-service.js';
import { StateMachine } from './state-machine.js';
import { createPreconditionEvaluator, type PreconditionContext } from './preconditions.js';
import { collections } from '../../lib/firestore.js';
import { approvalPinPatch, approvalPinMirror } from '../case/approval-pin.js';

/**
 * The transactional core of a case status transition.
 *
 * ## Why this module exists
 *
 * `OrchestrationService.transition` opens its own `runTransaction`, and
 * Firestore has no nested transactions — so a second caller that needs the
 * transition to commit TOGETHER with its own writes (the assistant task
 * executor: run completion + artifact + evidence + transition + event, all or
 * nothing) cannot call it. Rather than let a second copy of the validation
 * appear, the whole body of that transaction lives here and accepts a
 * transaction instead of creating one. Both callers pass their own.
 *
 * Drift between two copies of transition validation is the failure class this
 * area keeps hitting, so there is exactly one: the state machine is consulted
 * here and nowhere else on the write path.
 *
 * `OrchestrationService.transition` is a thin wrapper around this function and
 * behaves exactly as before — same read order, same events, same return value
 * — which its existing tests pin. The one deliberate addition to the write
 * itself is universal: every transition now also clears `pending_gate` (see
 * the note inline below, issue #1049).
 */
export interface TransitionCoreDeps {
  caseRepo: Pick<CaseRepository, 'getInTransaction' | 'updateInTransaction'>;
  eventService: Pick<EventService, 'emitInTransaction'>;
  stateMachine: Pick<StateMachine, 'validateTransition'>;
  /**
   * Loads the precondition context the state machine validates against.
   *
   * Injected rather than hard-wired because the two callers legitimately need
   * different views of "current state":
   *
   * - `OrchestrationService` validates against what is committed
   *   (`loadTransactionPreconditionContext`);
   * - the assistant task executor validates against the state its own
   *   transaction is about to commit, because the evidence that satisfies
   *   `assistant_result_evidence_present` is created by that same transaction
   *   and Firestore reads never see a transaction's own staged writes. See
   *   `AssistantTaskExecutor` for the full argument.
   */
  loadPreconditionContext: (case_: Case, actorId: string) => Promise<PreconditionContext>;
}

export interface TransitionCoreResult {
  /** The case as it will exist once the caller's transaction commits. */
  case: Case;
  from: CaseStatus;
  /** Transition events emitted (staged) by this call. */
  events: EventType[];
  /**
   * The full `CaseEvent`s staged by this call, in emission order — same
   * events as `events` above, but carrying the payload/actor a post-commit
   * notification needs. The caller's own `runTransaction` must pass these to
   * `EventService.notifyCommitted` AFTER it resolves; this function has no
   * way to know whether the enclosing transaction will actually commit, so
   * it never notifies itself. See `EventService.notifyCommitted`.
   */
  committedEvents: CaseEvent[];
}

/**
 * Validate and stage one status transition inside `transaction`.
 *
 * Read/write ordering matters: this performs its case read FIRST and only then
 * stages writes, because Firestore forbids a read after a write inside a
 * transaction. Callers that need their own reads must therefore do them
 * BEFORE calling this, and their own writes AFTER.
 *
 * Throws `TransitionError` when no variant of the (from → to) transition has
 * its preconditions satisfied — which aborts the caller's whole transaction,
 * exactly as intended: a transition that the state machine rejects must not
 * commit alongside anything else.
 */
export interface TransitionCoreOptions {
  /**
   * Extra keys merged into every transition event's payload, after
   * `from_status`/`to_status`. Omitted by `OrchestrationService` so its event
   * payloads are byte-for-byte what they were before the extraction.
   */
  extraEventPayload?: Record<string, unknown>;
  /**
   * Extra case fields written in the SAME update as the status.
   *
   * Exists so a caller does not have to stage a second write to the case
   * document: Firestore rejects more than one mutation per document in one
   * commit, so "status here, my own field there" would abort the whole
   * transaction. `status`, `updated_at`, and `pending_gate` are applied last
   * and always win — a caller cannot use this to keep a stale `pending_gate`
   * alive across a status change it did not itself confirm/reject (see the
   * note on the `pending_gate` clear below).
   */
  extraCaseUpdates?: Partial<Case>;
}

export async function applyTransitionInTransaction(
  transaction: FirebaseFirestore.Transaction,
  caseId: string,
  targetStatus: CaseStatus,
  actorId: string,
  deps: TransitionCoreDeps,
  options: TransitionCoreOptions = {},
): Promise<TransitionCoreResult> {
  // Load case within transaction for consistency
  const case_ = await deps.caseRepo.getInTransaction(transaction, caseId);

  // Load context for precondition evaluation
  const ctx = await deps.loadPreconditionContext(case_, actorId);

  // Validate transition (throws TransitionError on failure)
  const transitionDef = await deps.stateMachine.validateTransition(
    case_.status,
    targetStatus,
    createPreconditionEvaluator(ctx),
    case_.case_type,
  );

  // Update case status
  const now = new Date().toISOString();
  deps.caseRepo.updateInTransaction(transaction, caseId, {
    ...(options.extraCaseUpdates ?? {}),
    status: targetStatus,
    updated_at: now,
    // Pin the approval to the commit it covers (issue #1045), in the SAME
    // atomic write as the status it belongs to, so the two can never be
    // committed apart. `arbitra/case` publishes `success` for
    // `approved`/`pending_merge`/`done` only when the SHA being published
    // equals this pin, so a fixup pushed after approval can no longer be
    // certified past a required check.
    //
    // Written here rather than by the notifier that publishes the status:
    // `EventService.emit`/`notifyCommitted` never await `onCaseEvent`, so a
    // pin written there is lost with any dropped notification — leaving the
    // case permanently unpinned with no way back, since out of `approved`
    // the matrix has only `-> done` and `-> pending_merge`. It would also
    // race the second, independent publish the auto `approved ->
    // pending_merge` edge fires.
    //
    // This is NOT the only write path into `approved` — `Pipeline` has two
    // more that never reach this function. The rule itself therefore lives
    // in `approval-pin.ts`, which all three call; see its doc comment.
    ...approvalPinPatch(targetStatus, case_),
    // Any status change invalidates a `pending_gate` marker recorded for a
    // DIFFERENT status (issue #1049): `emitGatePending` writes the marker
    // while the case sits in one status, but a later, unrelated transition
    // (e.g. a case-level Request Changes moving `in_review` → `in_build`)
    // can move the case on before anyone confirms/declines it — nothing
    // else ever clears it. Clearing it here unconditionally means no
    // transition THROUGH THIS PATH can leave a marker pointing at a status
    // the case has already left. (This comment used to call this "the one
    // write path every transition shares". It is not: `Pipeline` writes
    // `status` directly through the adapter in two more places — see
    // `approval-pin.ts`. Believing the claim is what left the approval pin
    // unstamped on both pipeline routes in issue #1045. `executeTransition`
    // is reached only via `tryAutoTransition`, which refuses to run while
    // `pending_gate` is set, so the marker itself stays contained — but the
    // claim is false and must not be reused.) The "freeze leg" of #1049:
    // `tryAutoTransition` refuses to evaluate ANY further auto-transition
    // while `pending_gate` is set). `FieldValue.delete()` — not `undefined`
    // — because this Firestore instance runs with
    // `ignoreUndefinedProperties: true`, under which an `undefined` value
    // is silently omitted from the write instead of clearing the field.
    pending_gate: FieldValue.delete() as unknown as undefined,
  } as Partial<Case>);

  // Emit transition events
  const committedEvents: CaseEvent[] = [];
  for (const eventType of transitionDef.events) {
    const event = await deps.eventService.emitInTransaction(
      transaction,
      caseId,
      eventType,
      {
        from_status: case_.status,
        to_status: targetStatus,
        ...(options.extraEventPayload ?? {}),
      },
      actorId,
    );
    committedEvents.push(event);
  }

  return {
    case: {
      ...case_,
      ...(options.extraCaseUpdates ?? {}),
      status: targetStatus,
      updated_at: now,
      // Mirrors the approval pin staged above, including its cleared form —
      // `undefined` rather than the Firestore delete sentinel.
      ...approvalPinMirror(targetStatus, case_),
      // Mirrors the `FieldValue.delete()` staged above — the in-memory
      // return value must reflect the cleared marker too, not the
      // Firestore-only delete sentinel.
      pending_gate: undefined,
    },
    from: case_.status,
    events: [...transitionDef.events],
    committedEvents,
  };
}

/**
 * The precondition context for a transition being decided inside a Firestore
 * transaction.
 *
 * Intentionally NO `onAutoHealReviewNotApplicable`: this context is loaded
 * inside a `runTransaction` and the heal performs its own non-transactional
 * writes which would conflict on retry. The evaluator still returns
 * `satisfied: true` via the heal logic itself; the persist will fire on the
 * next read-side context load (`FirestorePipelineAdapter.loadPreconditionContext`
 * via the agent context route). The heal is idempotent so this is safe.
 *
 * The six queries are deliberately NOT `transaction.get` calls — they are
 * collection queries, which Firestore transactions cannot express as reads
 * against a snapshot, and this is the shape the transition path has always
 * used.
 */
export async function loadTransactionPreconditionContext(
  case_: Case,
  actorId: string,
): Promise<PreconditionContext> {
  const [runsSnap, findingsSnap, ruleResultsSnap, evidenceSnap, decisionsSnap, eventsSnap] =
    await Promise.all([
      collections.runs().where('case_id', '==', case_.case_id).get(),
      collections.findings().where('case_id', '==', case_.case_id).get(),
      collections.ruleResults().where('case_id', '==', case_.case_id).get(),
      collections.evidence().where('case_id', '==', case_.case_id).get(),
      collections.decisions().where('case_id', '==', case_.case_id).get(),
      collections.caseEvents().where('case_id', '==', case_.case_id).get(),
    ]);

  return {
    case_,
    runs: runsSnap.docs.map((d) => d.data()),
    findings: findingsSnap.docs.map((d) => d.data()),
    ruleResults: ruleResultsSnap.docs.map((d) => d.data()),
    evidence: evidenceSnap.docs.map((d) => d.data()),
    decisions: decisionsSnap.docs.map((d) => d.data()),
    events: eventsSnap.docs.map((d) => d.data()),
    actorId,
  };
}
