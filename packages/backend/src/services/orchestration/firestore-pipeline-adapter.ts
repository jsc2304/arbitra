import { createHash } from 'node:crypto';
import {
  assertAssistantRunPolicyInvariant,
  isAssistantRunType,
  type Case,
  type CaseStatus,
  type Run,
  type RunType,
  type Decision,
  type EventType,
  type LifecycleProfile,
} from '@arbitra/shared';
import { FieldValue } from 'firebase-admin/firestore';
import type {
  CancelUnclaimedAssistantReattemptResult,
  FailRunIfStillStaleResult,
  PipelineAdapter,
  ResolveAndRunReviewResult,
  RunClaimResult,
  RunStalenessCheck,
} from './pipeline-adapter.js';
import type { AssistantHoldWrite } from './assistant-hold-writer.js';
import { newWorkerId } from './run-worker-id.js';
import type { PreconditionContext } from './preconditions.js';
import { CaseRepository } from '../case/case-repository.js';
import { EventService } from '../event/event-service.js';
import { ReviewService } from '../review/review-service.js';
import { DiffResolver } from '../diff/diff-resolver.js';
import { fetchReviewContext } from '../diff/review-context.js';
import { collections, getDb } from '../../lib/firestore.js';
import { generateId } from '../../lib/ids.js';
import { buildDecisionSnapshot, CompletenessEvaluator } from '../evidence/completeness-evaluator.js';
import { RuleRepository } from '../rule/rule-repository.js';
import { closeOutstandingWaiverProposalsOnCompletion } from './waiver-completion.js';
import { openRepositoryToken } from '../../lib/secret-box.js';

const SYSTEM_ACTOR = 'system';

/**
 * How long a run's lease is valid before it's considered orphaned (worker
 * process killed mid-execution — deploy rollout, scale-to-zero, OOM). A
 * `pending`/`running` run past its lease is a candidate for the stale-run
 * sweep (separate workstream) instead of deadlocking the case's `alreadyRunning`
 * guard forever. Default 5 minutes.
 */
const RUN_LEASE_TTL_MS = parseInt(process.env['ARBITRA_RUN_LEASE_TTL_MS'] ?? '300000', 10);

export class FirestorePipelineAdapter implements PipelineAdapter {
  constructor(
    private readonly caseRepo = new CaseRepository(),
    private readonly eventService = new EventService(),
    private readonly completenessEvaluator = new CompletenessEvaluator(),
    private readonly ruleRepository = new RuleRepository(),
  ) {}

  async getCase(caseId: string): Promise<Case> {
    return this.caseRepo.getById(caseId);
  }

  async updateCaseStatus(
    caseId: string,
    status: CaseStatus,
    extraUpdates: Partial<Case> = {},
  ): Promise<Case> {
    return this.caseRepo.update(caseId, {
      ...extraUpdates,
      status,
      updated_at: new Date().toISOString(),
    });
  }

  async updateCase(caseId: string, updates: Partial<Case>): Promise<Case> {
    // Handle clearing of optional fields — Firestore needs FieldValue.delete() instead of undefined
    const firestoreUpdates: Record<string, unknown> = {
      ...updates,
      updated_at: new Date().toISOString(),
    };
    if ('pending_gate' in updates && updates.pending_gate === undefined) {
      firestoreUpdates['pending_gate'] = FieldValue.delete();
    }
    const ref = collections.cases().doc(caseId);
    await ref.update(firestoreUpdates);
    const snap = await ref.get();
    return snap.data()!;
  }

  async loadPreconditionContext(case_: Case): Promise<PreconditionContext> {
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
      actorId: SYSTEM_ACTOR,
      onAutoHealReviewNotApplicable: (caseId) =>
        this.persistReviewNotApplicableHeal(caseId),
    };
  }

  /**
   * Persist `review_not_applicable=true` on a case and emit a
   * `review_marked_not_applicable` event so the timeline records the
   * auto-heal. Used by the precondition evaluator's heal path for cases
   * that exhausted retries before PR #454 added the flag. Idempotent:
   * skips the write if the flag is already set.
   *
   * Concurrency: the read-then-write was previously non-atomic, so two
   * concurrent `loadPreconditionContext` callers (e.g. MCP `get_case_context`
   * + open web UI) both saw flag=false and both emitted a duplicate
   * `review_marked_not_applicable` event. We now wrap the read+write in a
   * Firestore transaction and only emit when the transaction itself flipped
   * the flag from false to true (the loser observes flag=true inside the tx
   * and skips the emit). The event is emitted outside the transaction
   * because `EventService.emit` performs its own non-transactional writes.
   */
  async persistReviewNotApplicableHeal(caseId: string): Promise<void> {
    const ref = collections.cases().doc(caseId);
    const flipped = await getDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!data || data.review_not_applicable) return false;
      tx.update(ref, {
        review_not_applicable: true,
        updated_at: new Date().toISOString(),
      });
      return true;
    });
    if (!flipped) return;
    await this.emitEvent(
      caseId,
      'review_marked_not_applicable',
      { reason: 'auto_healed_from_pipeline_failure_comment' },
      'system:pipeline',
    );
  }

  async createRun(caseId: string, runType: RunType, triggerSource: string, attempt = 1): Promise<Run> {
    const now = new Date();
    const nowIso = now.toISOString();
    const run: Run = {
      run_id: generateId('run'),
      case_id: caseId,
      run_type: runType,
      trigger_source: triggerSource,
      status: 'pending',
      input_refs: [],
      output_refs: [],
      started_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
      lease_expires_at: new Date(now.getTime() + RUN_LEASE_TTL_MS).toISOString(),
      worker_id: newWorkerId(),
      attempt,
      ...(runType === 'assistant_task_run'
        ? { assistant_policy_state: 'unbound' as const }
        : {}),
    };
    assertAssistantRunPolicyInvariant(run);
    await collections.runs().doc(run.run_id).set(run);
    return run;
  }

  /**
   * Create a `pending` run that nobody owns yet — see
   * `PipelineAdapter.createUnclaimedRun`. Deliberately omits every ownership
   * field `createRun` stamps:
   *
   * - no `lease_expires_at` / `worker_id` — there is no worker yet, and a lease
   *   nobody is renewing would just start ticking towards the stale sweep,
   * - no `started_at` — execution has not started; `claimRun` stamps it at the
   *   moment a worker actually takes the run.
   *
   * `awaiting_claim: true` records that the missing lease is INTENDED, which is
   * what keeps the run out of the stale-run sweep's legacy no-lease cohort.
   */
  async createUnclaimedRun(
    caseId: string,
    runType: RunType,
    triggerSource: string,
    attempt = 1,
  ): Promise<Run> {
    const nowIso = new Date().toISOString();
    const run: Run = {
      run_id: generateId('run'),
      case_id: caseId,
      run_type: runType,
      trigger_source: triggerSource,
      status: 'pending',
      input_refs: [],
      output_refs: [],
      created_at: nowIso,
      updated_at: nowIso,
      awaiting_claim: true,
      attempt,
      ...(runType === 'assistant_task_run'
        ? { assistant_policy_state: 'unbound' as const }
        : {}),
    };
    assertAssistantRunPolicyInvariant(run);
    await collections.runs().doc(run.run_id).set(run);
    return run;
  }

  async prepareAssistantReattempt(
    caseId: string,
    runType: RunType,
    triggerSource: string,
    attempt: number,
  ): Promise<Run> {
    const retryKey = `${caseId}\0${runType}\0${triggerSource}\0${attempt}`;
    const runId = `run_retry_${createHash('sha256').update(retryKey).digest('base64url').slice(0, 24)}`;
    const ref = collections.runs().doc(runId);
    const caseRef = collections.cases().doc(caseId);
    return getDb().runTransaction(async (tx) => {
      const [existingSnap, caseSnap] = await Promise.all([tx.get(ref), tx.get(caseRef)]);
      const case_ = caseSnap.data();
      if (
        !case_
        || case_.deleted_at
        || case_.status === 'done'
        || case_.status === 'rejected'
        || case_.assistant_cancel_intent !== undefined
      ) {
        throw new Error(`Assistant case ${caseId} is terminal or cancelled; no reattempt may be prepared`);
      }
      const existing = existingSnap.data();
      if (existing) {
        if (
          existing.case_id !== caseId
          || existing.run_type !== runType
          || existing.trigger_source !== triggerSource
          || (existing.attempt ?? 1) !== attempt
        ) {
          throw new Error(`Assistant retry key collision for ${runId}`);
        }
        assertAssistantRunPolicyInvariant(existing, { allowLegacyTaskRead: true });
        return existing;
      }

      const nowIso = new Date().toISOString();
      const run: Run = {
        run_id: runId,
        case_id: caseId,
        run_type: runType,
        trigger_source: triggerSource,
        status: 'pending',
        input_refs: [],
        output_refs: [],
        created_at: nowIso,
        updated_at: nowIso,
        awaiting_claim: true,
        attempt,
        ...(runType === 'assistant_task_run'
          ? { assistant_policy_state: 'unbound' as const }
          : {}),
      };
      assertAssistantRunPolicyInvariant(run);
      tx.create(ref, run);
      return run;
    });
  }

  /**
   * Atomically remove an unnecessary prepared replacement from the claimable
   * queue without erasing its audit record. This transaction races safely with
   * `claimRun`: if a worker claims first, Firestore retries this transaction
   * against the running doc and the predicate refuses to cancel it; if this
   * cancellation commits first, the claimant retries and sees `cancelled`.
   */
  async cancelUnclaimedAssistantReattempt(
    runId: string,
    reason: string,
  ): Promise<CancelUnclaimedAssistantReattemptResult> {
    const ref = collections.runs().doc(runId);
    return getDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!data) return { cancelled: false, run: null };
      if (!isAssistantRunType(data.run_type)) return { cancelled: false, run: data };
      if (data.status !== 'pending' || data.awaiting_claim !== true) {
        return { cancelled: false, run: data };
      }
      if (data.lease_expires_at || data.worker_id) {
        return { cancelled: false, run: data };
      }

      const now = new Date().toISOString();
      tx.update(ref, {
        status: 'cancelled',
        summary: reason,
        finished_at: now,
        updated_at: now,
        awaiting_claim: FieldValue.delete(),
      });
      const cancelledRun: Run = {
        ...data,
        status: 'cancelled',
        summary: reason,
        finished_at: now,
        updated_at: now,
      };
      delete cancelledRun.awaiting_claim;
      return { cancelled: true, run: cancelledRun };
    });
  }

  /**
   * Atomically take ownership of an unclaimed run — see
   * `PipelineAdapter.claimRun`. Same read-inside-transaction-then-write-
   * conditionally shape as `markRunTimeoutNotified` / `failRunIfStillStale` /
   * `claimRunRetryDispatch`: Firestore serializes the commits of two
   * transactions that read the same document, so the loser re-runs, observes
   * the winner's write, and its predicate rejects.
   *
   * The predicate is the whole safety argument, so it is spelled out
   * explicitly rather than folded together:
   *
   * - doc missing              → nothing to claim,
   * - `status !== 'pending'`   → someone already moved it out of the claimable
   *                              state (claimed, completed, failed, cancelled),
   * - `lease_expires_at` set   → a worker already owns it. EXPIRED counts as
   *                              owned: a starved-but-alive heartbeat must not
   *                              be joined by a second executor. Expired
   *                              assistant leases are recovered by starting a
   *                              new attempt, not by re-claiming this doc.
   * - `worker_id` set          → same, checked independently of the lease so a
   *                              partially-written or lease-less-but-owned doc
   *                              still reads as held (fail closed).
   */
  async claimRun(runId: string, workerId: string): Promise<RunClaimResult> {
    const ref = collections.runs().doc(runId);
    return getDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!data) return { claimed: false, run: null };
      if (data.status !== 'pending') return { claimed: false, run: data };
      if (data.lease_expires_at || data.worker_id) return { claimed: false, run: data };

      if (isAssistantRunType(data.run_type)) {
        const caseSnap = await tx.get(collections.cases().doc(data.case_id));
        const case_ = caseSnap.data();
        if (
          !case_
          || case_.deleted_at
          || case_.status === 'done'
          || case_.status === 'rejected'
          || case_.assistant_cancel_intent !== undefined
        ) {
          return { claimed: false, run: data };
        }
      }

      assertAssistantRunPolicyInvariant(data, { allowLegacyTaskRead: true });
      const upgradesLegacyTaskPolicy = data.run_type === 'assistant_task_run'
        && data.assistant_policy_state === undefined
        && data.assistant_tool_policy === undefined;
      if (upgradesLegacyTaskPolicy && data.awaiting_claim !== true) {
        throw new Error('Legacy assistant task run can be upgraded only while explicitly awaiting claim');
      }
      if (data.run_type === 'assistant_task_run' && data.assistant_policy_state === 'bound') {
        throw new Error('A bound assistant task run cannot be claimed from pending');
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + RUN_LEASE_TTL_MS).toISOString();
      tx.update(ref, {
        status: 'running',
        started_at: nowIso,
        lease_expires_at: leaseExpiresAt,
        worker_id: workerId,
        updated_at: nowIso,
        // The run is owned now — the flag's only job was to explain the
        // lease-less window, and leaving it set would misreport a running run
        // as still waiting for a claim.
        awaiting_claim: FieldValue.delete(),
        ...(upgradesLegacyTaskPolicy ? { assistant_policy_state: 'unbound' } : {}),
      });

      const claimedRun: Run = {
        ...data,
        status: 'running',
        started_at: nowIso,
        lease_expires_at: leaseExpiresAt,
        worker_id: workerId,
        updated_at: nowIso,
        ...(upgradesLegacyTaskPolicy ? { assistant_policy_state: 'unbound' as const } : {}),
      };
      delete claimedRun.awaiting_claim;
      assertAssistantRunPolicyInvariant(claimedRun);
      return { claimed: true, run: claimedRun };
    });
  }

  /**
   * Persist both halves of an assistant hold atomically. The precondition
   * evaluator requires the wait reason on the case AND the documenting event,
   * so pipeline re-evaluation must never observe only one.
   *
   * The hold's run scope is written alongside the reason for the same reason it
   * exists: a hold that cannot be attributed to an attempt never expires.
   */
  async documentAssistantHold(
    caseId: string,
    hold: AssistantHoldWrite,
    event: { type: EventType; payload: Record<string, unknown> },
    actorId: string,
  ): Promise<void> {
    const caseRef = collections.cases().doc(caseId);
    await getDb().runTransaction(async (tx) => {
      const caseSnap = await tx.get(caseRef);
      const caseData = caseSnap.data();
      if (!caseData) {
        throw new Error(`Case ${caseId} not found while documenting assistant hold '${hold.wait_reason}'`);
      }

      tx.update(caseRef, {
        assistant_context: {
          ...caseData.assistant_context,
          wait_reason: hold.wait_reason,
          wait_run_id: hold.run_id,
          wait_attempt: hold.attempt,
        },
        updated_at: new Date().toISOString(),
      });
      await this.eventService.emitInTransaction(tx, caseId, event.type, event.payload, actorId);
    });
  }

  /**
   * Mark a permanently failed assistant run as still awaiting its case-side
   * repair. Written before the case write so a crash in between leaves a run
   * the assistant sub-sweep can find (see `Run.assistant_failure_repair_pending`).
   */
  async markAssistantFailureRepairPending(runId: string): Promise<void> {
    await collections.runs().doc(runId).update({
      assistant_failure_repair_pending: true,
      assistant_failure_repair_settled_at: FieldValue.delete(),
      updated_at: new Date().toISOString(),
    });
  }

  /**
   * Clear the marker once the repair has landed. Deleted rather than set to
   * `false` so the sweep's single equality filter keeps selecting only the runs
   * that still need work.
   */
  async clearAssistantFailureRepairPending(runId: string): Promise<void> {
    const now = new Date().toISOString();
    await collections.runs().doc(runId).update({
      assistant_failure_repair_pending: FieldValue.delete(),
      assistant_failure_repair_settled_at: now,
      updated_at: now,
    });
  }

  /**
   * Idempotently claim the timeout-notification slot for a run. Uses a
   * transaction so two racing timers (e.g. across a container restart where
   * both the old and new instance briefly overlap) can't both notify.
   * Returns whether the slot was already claimed before this call.
   */
  async markRunTimeoutNotified(runId: string): Promise<boolean> {
    const ref = collections.runs().doc(runId);
    return getDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!data) return true; // run doc gone — treat as already-handled, don't notify
      if (data.timeout_notified) return true;
      tx.update(ref, { timeout_notified: true, updated_at: new Date().toISOString() });
      return false;
    });
  }

  /**
   * Extend a run's lease while a worker is actively executing it. Called on
   * a heartbeat interval by `RunExecutor` — without this, a long-running
   * execution would appear orphaned to the stale-run sweep before it's
   * actually done. No-op (best-effort) if the run doc no longer exists.
   */
  async refreshRunLease(runId: string, workerId: string): Promise<void> {
    const ref = collections.runs().doc(runId);
    await getDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const run = snap.data();
      if (
        !run
        || run.status !== 'running'
        || run.worker_id !== workerId
        || run.assistant_cancel_intent !== undefined
      ) return;
      const now = new Date();
      tx.update(ref, {
        lease_expires_at: new Date(now.getTime() + RUN_LEASE_TTL_MS).toISOString(),
        worker_id: workerId,
        updated_at: now.toISOString(),
      });
    });
  }

  async completeRun(runId: string, _caseId: string, summary: string): Promise<Run> {
    const ref = collections.runs().doc(runId);
    return getDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const run = snap.data();
      if (!run) throw new Error(`Run not found: ${runId}`);
      if (
        run.status === 'completed'
        || run.status === 'failed'
        || run.status === 'cancelled'
        || run.assistant_cancel_intent !== undefined
      ) return run;
      const now = new Date().toISOString();
      tx.update(ref, {
        status: 'completed',
        summary,
        finished_at: now,
        updated_at: now,
        lease_expires_at: FieldValue.delete(),
        worker_id: FieldValue.delete(),
      });
      const completed: Run = { ...run, status: 'completed', summary, finished_at: now, updated_at: now };
      delete completed.lease_expires_at;
      delete completed.worker_id;
      return completed;
    });
  }

  async failRun(runId: string, _caseId: string, error: string): Promise<Run> {
    const ref = collections.runs().doc(runId);
    return getDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const run = snap.data();
      if (!run) throw new Error(`Run not found: ${runId}`);
      if (
        run.status === 'completed'
        || run.status === 'failed'
        || run.status === 'cancelled'
        || run.assistant_cancel_intent !== undefined
      ) return run;
      const now = new Date().toISOString();
      tx.update(ref, {
        status: 'failed',
        error_message: error,
        finished_at: now,
        updated_at: now,
        lease_expires_at: FieldValue.delete(),
        worker_id: FieldValue.delete(),
      });
      const failed: Run = { ...run, status: 'failed', error_message: error, finished_at: now, updated_at: now };
      delete failed.lease_expires_at;
      delete failed.worker_id;
      return failed;
    });
  }

  /**
   * Transactional stale-run-sweeper-only fail (PR #742). Re-reads the
   * run INSIDE the transaction and only writes `failed` if it's still `pending`/`running` AND `isStillStale` still
   * accepts the fresh doc — otherwise the run legitimately resolved on its
   * own between the sweep's query and this call, and we must not clobber a
   * real completion/failure with a spurious one (which would otherwise
   * trigger a duplicate retry — double LLM cost/findings, or two live
   * workers on the same run).
   */
  async failRunIfStillStale(
    runId: string,
    _caseId: string,
    error: string,
    isStillStale: RunStalenessCheck,
  ): Promise<FailRunIfStillStaleResult> {
    const ref = collections.runs().doc(runId);
    return getDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!data) return { failed: false, run: null };
      if (data.status !== 'pending' && data.status !== 'running') {
        return { failed: false, run: data };
      }
      if (!isStillStale(data)) {
        return { failed: false, run: data };
      }
      const now = new Date().toISOString();
      tx.update(ref, {
        status: 'failed',
        error_message: error,
        finished_at: now,
        updated_at: now,
        lease_expires_at: FieldValue.delete(),
        worker_id: FieldValue.delete(),
      });
      const failedRun: Run = { ...data, status: 'failed', error_message: error, finished_at: now, updated_at: now };
      delete failedRun.lease_expires_at;
      delete failedRun.worker_id;
      return { failed: true, run: failedRun };
    });
  }

  /**
   * Persist a retry's scheduled dispatch time on a `failed` run (durable
   * retry backstop). Plain (non-transactional) update: only the ONE caller
   * that just won `failRun`/`failRunIfStillStale` for this run ever calls
   * this, so there's no concurrent writer to race.
   */
  async scheduleRunRetry(runId: string, retryAt: string): Promise<void> {
    const ref = collections.runs().doc(runId);
    await getDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const run = snap.data();
      if (!run || run.status !== 'failed' || run.assistant_cancel_intent !== undefined) return;
      tx.update(ref, { retry_at: retryAt, updated_at: new Date().toISOString() });
    });
  }

  /**
   * Idempotently claim the right to dispatch a scheduled retry — see
   * `PipelineAdapter.claimRunRetryDispatch`. Transactional so the in-process
   * timer and the stale-run sweep's overdue-retry pass can race safely:
   * exactly one flips `retry_dispatched` and gets the run back; the other
   * gets `null`.
   */
  async claimRunRetryDispatch(runId: string): Promise<Run | null> {
    const ref = collections.runs().doc(runId);
    return getDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!data) return null;
      if (data.retry_dispatched) return null;
      if (data.status !== 'failed') return null;
      if (isAssistantRunType(data.run_type)) {
        const caseSnap = await tx.get(collections.cases().doc(data.case_id));
        const case_ = caseSnap.data();
        if (
          !case_
          || case_.deleted_at
          || case_.status === 'done'
          || case_.status === 'rejected'
          || case_.assistant_cancel_intent !== undefined
        ) return null;
      }
      const now = new Date().toISOString();
      tx.update(ref, { retry_dispatched: true, updated_at: now });
      return { ...data, retry_dispatched: true, updated_at: now };
    });
  }

  async emitEvent(
    caseId: string,
    type: EventType,
    payload: Record<string, unknown>,
    actorId: string,
  ): Promise<void> {
    await this.eventService.emit(caseId, type, payload, actorId);
  }

  async createAutoApproveDecision(caseId: string): Promise<Decision> {
    const now = new Date().toISOString();

    // Load findings and review runs for a specific rationale
    const [case_, findingsSnap, runsSnap] = await Promise.all([
      this.getCase(caseId),
      collections.findings().where('case_id', '==', caseId).get(),
      collections.runs().where('case_id', '==', caseId).where('run_type', '==', 'review_run').get(),
    ]);
    const findings = findingsSnap.docs.map((d) => d.data());
    const reviewRuns = runsSnap.docs.map((d) => d.data());

    // Build rationale from actual data
    const parts: string[] = ['Auto-approved'];

    // Model info from the most recent completed review run
    const completedReview = reviewRuns
      .filter((r) => r.status === 'completed' && r.token_usage?.model)
      .sort((a, b) => (b.finished_at ?? '').localeCompare(a.finished_at ?? ''))
      [0];
    if (completedReview?.token_usage?.model) {
      const modelName = typeof completedReview.token_usage.model === 'string'
        ? completedReview.token_usage.model
        : (completedReview.token_usage.model as unknown as Record<string, string>).modelId ?? 'AI';
      parts[0] = `Auto-approved after ${modelName} review`;
    }

    // Finding summary
    if (findings.length === 0) {
      parts.push('no findings');
    } else {
      const bySeverity: Record<string, number> = {};
      for (const f of findings) {
        bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      }
      const severityParts = Object.entries(bySeverity)
        .sort(([a], [b]) => {
          const order = ['critical', 'high', 'medium', 'low', 'info'];
          return order.indexOf(a) - order.indexOf(b);
        })
        .map(([sev, count]) => `${count} ${sev}`);
      parts.push(`${severityParts.join(', ')} finding${findings.length !== 1 ? 's' : ''} (none blocking)`);
    }

    parts.push('all rules passed');

    const snapshot = await buildDecisionSnapshot(
      case_,
      this.completenessEvaluator,
      this.ruleRepository,
    );

    const decision: Decision = {
      decision_id: generateId('decision'),
      case_id: caseId,
      type: 'auto_approve',
      actor_id: 'system:pipeline',
      rationale: parts.join(', '),
      snapshot,
      created_at: now,
    };
    await collections.decisions().doc(decision.decision_id).set(decision);
    return decision;
  }

  async closeOutstandingWaiverProposals(caseId: string): Promise<{ closed: number }> {
    return closeOutstandingWaiverProposalsOnCompletion(caseId, 'completion');
  }

  async createMergeNotApplicableDecision(caseId: string): Promise<Decision> {
    const case_ = await this.getCase(caseId);
    const snapshot = await buildDecisionSnapshot(
      case_,
      this.completenessEvaluator,
      this.ruleRepository,
    );
    const decision: Decision = {
      decision_id: generateId('decision'),
      case_id: caseId,
      type: 'merge_not_applicable',
      actor_id: 'system:pipeline',
      rationale:
        'Auto-attached on approval: case has no PR reference and no branch — implementation lives outside the repository, so the merge gate does not apply (issue #687).',
      snapshot,
      created_at: new Date().toISOString(),
    };
    await collections.decisions().doc(decision.decision_id).set(decision);
    return decision;
  }

  async getProjectLifecycleProfile(projectId: string): Promise<LifecycleProfile | undefined> {
    try {
      const doc = await collections.projects().doc(projectId).get();
      if (!doc.exists) return undefined;
      const project = doc.data()!;
      return project.lifecycle_profile;
    } catch (err) {
      console.warn(`[FirestorePipelineAdapter] Failed to load project ${projectId}:`, err);
      return undefined;
    }
  }

  async getActiveRuns(caseId: string): Promise<Run[]> {
    const snap = await collections
      .runs()
      .where('case_id', '==', caseId)
      .where('status', 'in', ['pending', 'running'])
      .get();
    return snap.docs.map((d) => d.data());
  }

  async resolveAndRunReview(caseId: string, attempt = 1, triggerSource = 'system:pipeline'): Promise<ResolveAndRunReviewResult> {
    const case_ = await this.getCase(caseId);

    // Look up per-repository GitHub token (fall back to global env var) and URL
    let repoToken: string | undefined;
    let repoUrl: string | undefined;
    if (case_.repository_id && case_.project_id) {
      let repoSnap = await collections.repositories()
        .where('project_id', '==', case_.project_id)
        .where('repository_id', '==', case_.repository_id)
        .limit(1)
        .get();

      // Fallback: if repository_id looks like a slug (org/repo), try matching by URL
      if (repoSnap.empty && !case_.repository_id.startsWith('repo_')) {
        const allRepos = await collections.repositories()
          .where('project_id', '==', case_.project_id)
          .limit(50)
          .get();
        const match = allRepos.docs.find((d) => {
          const url = d.data().url || '';
          return url.includes(case_.repository_id!);
        });
        if (match) {
          repoToken = openRepositoryToken(match.data().github_token, match.data().repository_id);
          repoUrl = match.data().url;
        }
      }

      if (!repoSnap.empty) {
        const repo = repoSnap.docs[0]!.data();
        repoToken ??= openRepositoryToken(repo.github_token, repo.repository_id);
        repoUrl ??= repo.url;
      }
    }

    const diffResolver = new DiffResolver(repoToken);
    const result = await diffResolver.resolve(case_, repoUrl);

    if (!result.ok) {
      // Surface WHY, not just that nothing happened (issue #1054): "no PR or
      // branch reference" and "GitHub fetch failed" send an operator to
      // completely different fixes, and both used to collapse into a bare
      // `null` here.
      return { run: null, failureReason: result.reason };
    }

    // Best-effort enrichment: post-change file contents + repo file listing,
    // fetched server-side via the GitHub API (the pipeline has no repo
    // checkout). Fail-soft — a fetch failure must never block the review.
    const reviewContext = await fetchReviewContext(case_, repoToken, repoUrl);

    // Run review (creates its own run record, produces findings, triggers pipeline on completion).
    // The resolver's truncation verdict travels with the diff: a review of a
    // truncated prefix must raise `diff_exceeds_limit` and be recorded as
    // partial, never silently pass for a review of the whole change (#877).
    // `headSha` travels the same way, into `Run.reviewed_head_sha`, so the
    // review gate can require the completed run to match the case's current
    // head instead of any review completed since the last changes_requested.
    const reviewService = new ReviewService(this.eventService, this);
    const { run } = await reviewService.runReview(
      case_,
      result.diff,
      triggerSource,
      reviewContext,
      repoToken,
      attempt,
      { truncated: result.truncated, lineCount: result.lineCount, reviewedHeadSha: result.headSha, repositoryUrl: repoUrl },
    );
    return { run };
  }
}
