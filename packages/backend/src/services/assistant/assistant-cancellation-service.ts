import { FieldValue } from 'firebase-admin/firestore';
import {
  ArbitraError,
  ForbiddenError,
  NotFoundError,
  assertAssistantRunPolicyInvariant,
  type AssistantCancelIntent,
  type AssistantCancelReconciler,
  type AssistantCancelReceipt,
  type Case,
  type Run,
} from '@arbitra/shared';
import { collections, getDb } from '../../lib/firestore.js';
import { CaseRepository } from '../case/case-repository.js';
import { EventService } from '../event/event-service.js';
import { StateMachine } from '../orchestration/state-machine.js';
import type { PreconditionContext } from '../orchestration/preconditions.js';
import {
  applyTransitionInTransaction,
  loadTransactionPreconditionContext,
} from '../orchestration/transition-core.js';
import type { ToolCallRecord } from './tool-registry.js';
import { abortAssistantRunInProcess } from './assistant-cancel-coordinator.js';

const SYSTEM_ACTOR = 'system:clerk';
// 'needs_human_decision' dropped (#811 item 3, following #805):
// #805 removed the only transitions that could put an `assistant_task` case
// into that status, so it's unreachable here and would only mislead a
// reader into thinking a stop from that status is still possible.
const CANCELLABLE_CASE_STATUSES = new Set(['open', 'in_build']);

export class AssistantCancellationConflictError extends ArbitraError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ASSISTANT_CANCELLATION_CONFLICT', 409, details);
    this.name = 'AssistantCancellationConflictError';
  }
}

export interface AssistantCancellationResult {
  case: Case;
  target_run_id: string;
  revision: number;
  run_ids: string[];
  pending_reconciliation_run_ids: string[];
  replayed: boolean;
}

export interface AssistantCancellationReconcileInput {
  runId: string;
  reconciledBy: AssistantCancelReconciler;
  usageStatus: AssistantCancelReceipt['usage_status'];
  traceStatus: AssistantCancelReceipt['trace_status'];
  trace?: ToolCallRecord[];
  steps?: number;
  finishReason?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  durationMs?: number;
}

export interface AssistantCancellationReconcileResult {
  run: Run;
  receipt: AssistantCancelReceipt;
  replayed: boolean;
}

export interface AssistantCancellationServiceOptions {
  caseRepo?: CaseRepository;
  eventService?: EventService;
  stateMachine?: StateMachine;
  loadPreconditionContext?: (case_: Case, actorId: string) => Promise<PreconditionContext>;
  now?: () => Date;
}

/**
 * Cancels Clerk work at the same durable boundary that owns its completion.
 *
 * The generic `open|in_build -> rejected` transition stays guarded by
 * `assistant_no_active_run` (see `CANCELLABLE_CASE_STATUSES` above — an
 * assistant_task case has no route into `needs_human_decision`, so that
 * status is not part of this flow). This dedicated transaction reads every
 * Run for the Case, projects the exact active task Runs to `cancelled` for that
 * precondition, and writes the Case fence, Run fences and terminal transition
 * together. There is therefore no committed state in which the Case says
 * cancelled while a task Run can still be claimed or complete successfully.
 */
export class AssistantCancellationService {
  private readonly caseRepo: CaseRepository;
  private readonly eventService: EventService;
  private readonly stateMachine: StateMachine;
  private readonly options: AssistantCancellationServiceOptions;

  constructor(options: AssistantCancellationServiceOptions = {}) {
    this.caseRepo = options.caseRepo ?? new CaseRepository();
    this.eventService = options.eventService ?? new EventService();
    this.stateMachine = options.stateMachine ?? new StateMachine();
    this.options = options;
  }

  async cancel(
    caseId: string,
    actorId: string,
    targetRunId: string,
  ): Promise<AssistantCancellationResult> {
    const result = await getDb().runTransaction<AssistantCancellationResult>(async (tx) => {
      const caseRef = collections.cases().doc(caseId);
      const runsQuery = collections.runs().where('case_id', '==', caseId);
      const [caseSnap, runsSnap, actorSnap] = await Promise.all([
        tx.get(caseRef),
        tx.get(runsQuery),
        tx.get(collections.users().doc(actorId)),
      ]);

      const case_ = caseSnap.data();
      if (!case_ || case_.deleted_at) throw new NotFoundError('Case', caseId);
      if (case_.case_type !== 'assistant_task') {
        throw new AssistantCancellationConflictError('Only Clerk assistant tasks can be stopped.', {
          case_id: caseId,
          case_type: case_.case_type ?? null,
        });
      }
      const isAdmin = actorSnap.data()?.roles?.includes('admin') ?? false;
      const isRequester = case_.owner_user_id === actorId
        && case_.assistant_context?.requester_user_id === actorId;
      if (!isAdmin && !isRequester) {
        throw new ForbiddenError('Only the requester or an administrator can stop this Clerk task.', {
          case_id: caseId,
        });
      }

      const runs = runsSnap.docs.map((doc) => doc.data());
      const targetRun = runs.find((run) => run.run_id === targetRunId);
      if (!targetRun || targetRun.run_type !== 'assistant_task_run') {
        throw new AssistantCancellationConflictError(
          'The requested Run is not a Clerk task attempt on this Case.',
          { case_id: caseId, target_run_id: targetRunId },
        );
      }
      const active = runs.filter((run) => run.status === 'pending' || run.status === 'running');
      if (active.some((run) => run.run_type === 'assistant_action_run')) {
        throw new AssistantCancellationConflictError(
          'This task has active assistant action work and cannot use the read-task stop path.',
          { case_id: caseId },
        );
      }
      const activeTaskRuns = active
        .filter((run) => run.run_type === 'assistant_task_run')
        .sort((left, right) => left.run_id.localeCompare(right.run_id));

      if (case_.status === 'rejected' && case_.assistant_cancel_intent) {
        // Exact replay: the terminal Case and its revision are immutable. A
        // fresh active task here would indicate corrupted legacy state; fail
        // closed rather than pretending the first cancellation covered it.
        if (activeTaskRuns.length > 0) {
          throw new AssistantCancellationConflictError(
            'The task is already cancelled but still has active Runs that require reconciliation.',
            { case_id: caseId, run_ids: activeTaskRuns.map((run) => run.run_id) },
          );
        }
        const revision = case_.assistant_cancel_intent.revision;
        if (targetRun.assistant_cancel_intent?.revision !== revision) {
          throw new AssistantCancellationConflictError(
            'This stop request targets a different attempt than the recorded cancellation.',
            { case_id: caseId, target_run_id: targetRunId, cancel_revision: revision },
          );
        }
        return {
          case: case_,
          target_run_id: targetRunId,
          revision,
          run_ids: runs
            .filter((run) => run.assistant_cancel_intent?.revision === revision)
            .map((run) => run.run_id)
            .sort((left, right) => left.localeCompare(right)),
          pending_reconciliation_run_ids: runs
            .filter((run) => run.assistant_cancel_reconcile_pending === true)
            .map((run) => run.run_id)
            .sort((left, right) => left.localeCompare(right)),
          replayed: true,
        };
      }

      if (!CANCELLABLE_CASE_STATUSES.has(case_.status)) {
        throw new AssistantCancellationConflictError(
          `A Clerk task in '${case_.status}' cannot be stopped.`,
          { case_id: caseId, status: case_.status },
        );
      }
      if (targetRun.status !== 'pending' && targetRun.status !== 'running') {
        throw new AssistantCancellationConflictError(
          'The selected Clerk attempt is no longer active. Refresh before stopping a newer retry.',
          {
            case_id: caseId,
            target_run_id: targetRunId,
            target_status: targetRun.status,
            active_run_ids: activeTaskRuns.map((run) => run.run_id),
          },
        );
      }

      const revision = Math.max(
        case_.assistant_cancel_intent?.revision ?? 0,
        ...runs.map((run) => run.assistant_cancel_intent?.revision ?? 0),
      ) + 1;
      const requestedAt = this.currentInstant().toISOString();
      const intent: AssistantCancelIntent = {
        revision,
        requested_at: requestedAt,
        requested_by: actorId,
      };

      const pendingRunIds: string[] = [];
      const runningRunIds: string[] = [];
      for (const run of activeTaskRuns) {
        const definitelyUnstarted = run.status === 'pending'
          && !run.started_at
          && !run.worker_id
          && !run.lease_expires_at;
        if (definitelyUnstarted) {
          pendingRunIds.push(run.run_id);
        } else {
          runningRunIds.push(run.run_id);
        }
      }

      const activeIds = new Set(activeTaskRuns.map((run) => run.run_id));
      const loadContext = this.options.loadPreconditionContext
        ?? loadTransactionPreconditionContext;
      const transition = await applyTransitionInTransaction(
        tx,
        caseId,
        'rejected',
        actorId,
        {
          caseRepo: this.caseRepo,
          eventService: this.eventService,
          stateMachine: this.stateMachine,
          loadPreconditionContext: async (loadedCase, transitionActor) => {
            const base = await loadContext(loadedCase, transitionActor);
            const seen = new Set<string>();
            const projected = base.runs.map((run) => {
              seen.add(run.run_id);
              return activeIds.has(run.run_id)
                ? { ...run, status: 'cancelled' as const, assistant_cancel_intent: intent }
                : run;
            });
            for (const run of runs) {
              if (!seen.has(run.run_id)) {
                projected.push(activeIds.has(run.run_id)
                  ? { ...run, status: 'cancelled' as const, assistant_cancel_intent: intent }
                  : run);
              }
            }
            return { ...base, case_: { ...base.case_, assistant_cancel_intent: intent }, runs: projected };
          },
        },
        {
          extraCaseUpdates: { assistant_cancel_intent: intent },
          extraEventPayload: {
            cancel_revision: revision,
            requested_at: requestedAt,
            requested_by: actorId,
            run_ids: activeTaskRuns.map((run) => run.run_id),
            pending_run_ids: pendingRunIds,
            running_run_ids: runningRunIds,
          },
        },
      );

      // No reads after this point: `applyTransitionInTransaction` has staged
      // the first writes. Zero-work receipts and Run updates now join that same
      // commit without violating Firestore's read-before-write rule.
      const zeroUsageEvents = new Map<string, string>();
      for (const run of activeTaskRuns) {
        if (!pendingRunIds.includes(run.run_id)) continue;
        const event = await this.eventService.emitInTransaction(
          tx,
          caseId,
          'run_cancelled',
          {
            run_id: run.run_id,
            run_type: run.run_type,
            attempt: run.attempt ?? 1,
            cancel_revision: revision,
            reconciled_by: 'cancel_service',
            usage_status: 'complete',
            trace_status: 'recorded',
            tool_calls: 0,
            tool_call_records: [],
            steps: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          },
          SYSTEM_ACTOR,
        );
        zeroUsageEvents.set(run.run_id, event.event_id);
      }

      for (const run of activeTaskRuns) {
        const eventId = zeroUsageEvents.get(run.run_id);
        const receipt: AssistantCancelReceipt | undefined = eventId
          ? {
              revision,
              reconciled_at: requestedAt,
              reconciled_by: 'cancel_service',
              usage_status: 'complete',
              trace_status: 'recorded',
              event_id: eventId,
            }
          : undefined;
        const staged: Run = {
          ...run,
          status: 'cancelled',
          summary: 'Clerk task stopped by its requester.',
          finished_at: requestedAt,
          updated_at: requestedAt,
          assistant_cancel_intent: intent,
          ...(receipt
            ? { assistant_cancel_receipt: receipt }
            : { assistant_cancel_reconcile_pending: true }),
        };
        delete staged.awaiting_claim;
        delete staged.lease_expires_at;
        delete staged.worker_id;
        assertAssistantRunPolicyInvariant(staged, { allowLegacyTaskRead: true });
        tx.update(collections.runs().doc(run.run_id), {
          status: staged.status,
          summary: staged.summary,
          finished_at: staged.finished_at,
          updated_at: staged.updated_at,
          assistant_cancel_intent: intent,
          ...(receipt
            ? { assistant_cancel_receipt: receipt }
            : { assistant_cancel_reconcile_pending: true }),
          awaiting_claim: FieldValue.delete(),
          lease_expires_at: FieldValue.delete(),
          worker_id: FieldValue.delete(),
        });
      }

      return {
        case: transition.case,
        target_run_id: targetRunId,
        revision,
        run_ids: activeTaskRuns.map((run) => run.run_id),
        pending_reconciliation_run_ids: runningRunIds,
        replayed: false,
      };
    });

    // Commit first, then interrupt local in-flight calls. The durable revision
    // is the authority; aborting before it existed would let an executor report
    // cancellation that Firestore had never accepted.
    for (const runId of result.run_ids) {
      abortAssistantRunInProcess(runId, result.revision);
    }
    return result;
  }

  /**
   * Attach the redacted in-memory trace and metering to an already-cancelled
   * Run. Receipt + event are one idempotent transaction; a competing executor
   * or sweeper observes the receipt and returns it without a duplicate event.
   */
  async reconcile(
    input: AssistantCancellationReconcileInput,
  ): Promise<AssistantCancellationReconcileResult> {
    return getDb().runTransaction<AssistantCancellationReconcileResult>(async (tx) => {
      const runRef = collections.runs().doc(input.runId);
      const runSnap = await tx.get(runRef);
      const run = runSnap.data();
      if (!run) throw new NotFoundError('Run', input.runId);
      if (run.status !== 'cancelled' || !run.assistant_cancel_intent) {
        throw new AssistantCancellationConflictError(
          'Only a durably cancelled assistant task Run can be reconciled.',
          { run_id: input.runId, status: run.status },
        );
      }
      if (run.assistant_cancel_receipt) {
        return { run, receipt: run.assistant_cancel_receipt, replayed: true };
      }

      const trace = input.trace ?? [];
      const event = await this.eventService.emitInTransaction(
        tx,
        run.case_id,
        'run_cancelled',
        {
          run_id: run.run_id,
          run_type: run.run_type,
          attempt: run.attempt ?? 1,
          cancel_revision: run.assistant_cancel_intent.revision,
          reconciled_by: input.reconciledBy,
          usage_status: input.usageStatus,
          trace_status: input.traceStatus,
          tool_calls: trace.length,
          ...(input.traceStatus === 'recorded' ? { tool_call_records: trace } : {}),
          ...(input.steps === undefined ? {} : { steps: input.steps }),
          ...(input.finishReason ? { finish_reason: input.finishReason } : {}),
          ...(input.modelId ? { model: input.modelId } : {}),
          ...(input.inputTokens === undefined ? {} : { input_tokens: input.inputTokens }),
          ...(input.outputTokens === undefined ? {} : { output_tokens: input.outputTokens }),
          ...(input.totalTokens === undefined ? {} : { total_tokens: input.totalTokens }),
          ...(input.durationMs === undefined ? {} : { duration_ms: input.durationMs }),
        },
        SYSTEM_ACTOR,
      );
      const reconciledAt = this.currentInstant().toISOString();
      const receipt: AssistantCancelReceipt = {
        revision: run.assistant_cancel_intent.revision,
        reconciled_at: reconciledAt,
        reconciled_by: input.reconciledBy,
        usage_status: input.usageStatus,
        trace_status: input.traceStatus,
        event_id: event.event_id,
      };
      const tokenUsage = input.modelId !== undefined
        && input.inputTokens !== undefined
        && input.outputTokens !== undefined
        && input.totalTokens !== undefined
        ? {
            prompt_tokens: input.inputTokens,
            completion_tokens: input.outputTokens,
            total_tokens: input.totalTokens,
            model: input.modelId,
          }
        : undefined;
      const updated: Run = {
        ...run,
        summary: trace.length > 0
          ? `Clerk task stopped after ${trace.length} recorded read(s).`
          : 'Clerk task stopped before any read completed.',
        updated_at: reconciledAt,
        assistant_cancel_receipt: receipt,
        ...(tokenUsage ? { token_usage: tokenUsage } : {}),
      };
      delete updated.assistant_cancel_reconcile_pending;
      assertAssistantRunPolicyInvariant(updated, { allowLegacyTaskRead: true });
      tx.update(runRef, {
        summary: updated.summary,
        updated_at: reconciledAt,
        assistant_cancel_receipt: receipt,
        assistant_cancel_reconcile_pending: FieldValue.delete(),
        ...(tokenUsage ? { token_usage: tokenUsage } : {}),
      });
      return { run: updated, receipt, replayed: false };
    });
  }

  private currentInstant(): Date {
    return this.options.now?.() ?? new Date();
  }
}
