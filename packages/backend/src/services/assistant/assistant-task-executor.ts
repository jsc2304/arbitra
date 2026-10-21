import { FieldValue } from 'firebase-admin/firestore';
import type { LanguageModel } from 'ai';
import {
  assertAssistantRunPolicyInvariant,
  assistantToolPoliciesEqual,
  TERMINAL_CASE_STATUSES,
  TransitionError,
  type Artifact,
  type Case,
  type CaseEvent,
  type Evidence,
  type KnowledgeAsset,
  type RiskLevel,
  type Run,
} from '@arbitra/shared';
import { collections, getDb } from '../../lib/firestore.js';
import { generateId } from '../../lib/ids.js';
import { isEffectiveMember } from '../../lib/project-access.js';
import {
  getArtifactStorage,
  type ArtifactStorageAdapter,
} from '../../lib/artifact-storage.js';
import {
  getModelForRiskWithProject,
  resolveModelForRiskWithProject,
} from '../../lib/llm-provider.js';
import { CaseRepository } from '../case/case-repository.js';
import { EventService } from '../event/event-service.js';
import { StateMachine } from '../orchestration/state-machine.js';
import type { PreconditionContext } from '../orchestration/preconditions.js';
import {
  applyTransitionInTransaction,
  loadTransactionPreconditionContext,
} from '../orchestration/transition-core.js';
import { resolveAssistantIntakeLimits } from './assistant-intake-service.js';
import {
  applyInjectedContextBounds,
  boundFailureMessage,
  resolveAssistantBounds,
  toolStepBudget,
  type AssistantBounds,
} from './assistant-bounds.js';
import { clerkCoreIds } from './clerk-core.js';
import {
  runAssistantLoop,
  type AssistantLoopResult,
  type AssistantReadsWithheldReason,
  type GenerateTextFn,
} from './assistant-loop.js';
import {
  checkAssistantTaskInput,
  decideAssistantPolicy,
  type AssistantPolicyDecision,
} from './assistant-policy.js';
import { bindAssistantToolPolicy } from './assistant-tool-policy-binding.js';
import {
  assertAssistantRunNotCancelled,
  isAssistantRunCancelledError,
  registerAssistantRunCancellation,
} from './assistant-cancel-coordinator.js';
import {
  AssistantCancellationService,
  type AssistantCancellationReconcileInput,
} from './assistant-cancellation-service.js';
import {
  answerPreview,
  buildAssistantFollowUpUserMessage,
  buildAssistantSystemPrompt,
  buildAssistantUserMessage,
  validateAssistantAnswer,
  type AssistantFollowUpPromptTurn,
  type AssistantInjectedContextEntry,
  type RequesterPromptProfile,
} from './assistant-prompt.js';
import { AssistantFollowUpService } from './assistant-follow-up-service.js';
import { selectReadTools, type ToolCallRecord } from './tool-registry.js';

/**
 * Executes one attempt of one `assistant_task_run` — the point where Clerk first
 * produces something.
 *
 * ## Where the attempt boundary is
 *
 * `RunExecutor` owns the two durability steps that are identical for every run
 * type and must happen exactly once per attempt: `claimIfUnclaimed` (so a run
 * dispatched twice executes once) and `startLeaseHeartbeat` (so a live
 * execution never looks orphaned). By the time this class is called the run is
 * claimed, `running`, and heartbeated. Re-claiming here would fail the claim
 * predicate against our own write, and starting a second heartbeat would
 * duplicate lease refreshes — so the order the attempt runs in is: claim,
 * heartbeat (both in `RunExecutor.execute`), then everything below.
 *
 * ## What each attempt does, in order
 *
 * 1. reload the case and the requester (never trust the dispatched copies — a
 *    recovery dispatch can be minutes old);
 * 2. check for cancellation or a terminal state, on the case AND on the run;
 * 3. deterministic input checks (`checkAssistantTaskInput`);
 * 4. `open → in_build`, so the case reflects that work started;
 * 5. bind the requester-scoped read-registry policy for this attempt;
 * 6. the bounded loop (`runAssistantLoop`);
 * 7. output validation (`validateAssistantAnswer`);
 * 8. one transaction that commits everything or nothing.
 *
 * ## Why re-running this is safe
 *
 * Every tool is read-only and the registry cannot express anything else (see
 * `tool-registry.ts`). That is what makes the reliability machinery this sits on
 * safe: an expired lease produces a fresh attempt, the assistant sub-sweep
 * dispatches runs nobody claimed, and a crash can leave a surplus run. Each of
 * those can re-run the loop, and none of them can repeat an outward action,
 * because there is no outward action to repeat.
 */

const SYSTEM_ACTOR = 'system:clerk';

/** What one attempt concluded. `RunExecutor` maps these onto the run. */
export type AssistantRunOutcome =
  /** The completion transaction committed. The run is already `completed`. */
  | { outcome: 'completed'; summary: string }
  /** The attempt failed; the caller fails the run and lets retry policy decide. */
  | { outcome: 'failed'; message: string; reason: string }
  /**
   * Nothing should be persisted, but the run is still ours: the caller
   * completes it with this summary so the lease is released and the reason is
   * recorded.
   */
  | { outcome: 'discarded'; summary: string; reason: string }
  /**
   * The run is no longer ours (already terminal, reassigned, or gone). The
   * caller must touch NOTHING — completing or failing it here would clobber
   * whoever owns it now.
   */
  | { outcome: 'stood_down'; reason: string };

export interface AssistantTaskRunner {
  run(run: Run, case_: Case): Promise<AssistantRunOutcome>;
}

export interface AssistantTaskExecutorOptions {
  caseRepo?: CaseRepository;
  eventService?: EventService;
  stateMachine?: StateMachine;
  storage?: ArtifactStorageAdapter;
  /** Seam for tests. Defaults to the AI SDK's `generateText`. */
  generate?: GenerateTextFn;
  /** Seam for tests. Defaults to risk- and project-aware model resolution. */
  resolveModel?: (case_: Case) => Promise<{ model: LanguageModel; modelId: string }>;
  loadPreconditionContext?: (case_: Case, actorId: string) => Promise<PreconditionContext>;
  /**
   * The attempt's clock. Seam for tests, and the reason there is one: the current
   * instant now reaches the model (`buildAssistantSystemPrompt`) and is recorded
   * on the artifact as `as_of`, so a test that could not pin it would assert
   * against whatever the suite happened to run at.
   */
  now?: () => Date;
  /**
   * Whether the pipeline adapter that dispatched this run can claim runs at
   * all — `typeof adapter.claimRun === 'function'`, asked of the adapter by
   * `RunExecutor.resolveAssistantRunner`. This is a structural property of the
   * deployment, never something to infer from a run document; see
   * `readRunState`.
   *
   * Defaults to `true` (strict) so an omitted option fails closed.
   */
  claimCapable?: boolean;
  /** Seam for idempotent cancelled-trace reconciliation tests. */
  cancellationService?: Pick<AssistantCancellationService, 'reconcile'>;
  /**
   * Whole preceding conversation loader (every ancestor turn, oldest first).
   * Called after policy bind, before model work.
   */
  loadFollowUpContext?: (case_: Case) => Promise<AssistantFollowUpPromptTurn[] | null>;
}

export class AssistantTaskExecutor implements AssistantTaskRunner {
  private readonly caseRepo: CaseRepository;
  private readonly eventService: EventService;
  private readonly stateMachine: StateMachine;
  private readonly options: AssistantTaskExecutorOptions;
  private readonly claimCapable: boolean;
  private readonly cancellationService: Pick<AssistantCancellationService, 'reconcile'>;
  private readonly followUps: AssistantFollowUpService;

  constructor(options: AssistantTaskExecutorOptions = {}) {
    this.caseRepo = options.caseRepo ?? new CaseRepository();
    this.eventService = options.eventService ?? new EventService();
    this.stateMachine = options.stateMachine ?? new StateMachine();
    this.claimCapable = options.claimCapable ?? true;
    this.cancellationService = options.cancellationService ?? new AssistantCancellationService();
    this.followUps = new AssistantFollowUpService(options.storage);
    this.options = options;
  }

  async run(dispatchedRun: Run, _dispatchedCase: Case): Promise<AssistantRunOutcome> {
    const bounds = resolveAssistantBounds();
    const runId = dispatchedRun.run_id;
    const caseId = dispatchedRun.case_id;
    const startedAt = Date.now();

    // ── 1. reload the case ──────────────────────────────────────────
    let case_: Case;
    try {
      case_ = await this.caseRepo.getById(caseId);
    } catch {
      // Absent or soft-deleted. The run is still ours, so complete it rather
      // than leaving a `running` run behind a lease nobody will renew.
      return {
        outcome: 'discarded',
        reason: 'case_unavailable',
        summary: 'Assistant task discarded: the case is deleted or no longer exists.',
      };
    }

    // ── 2. cancellation / terminal state, run side ──────────────────
    // Run first: the dedicated cancellation transaction terminalises BOTH.
    // Returning `discarded` from the terminal Case check first would make
    // RunExecutor call `completeRun` and resurrect the already-cancelled Run.
    const runState = await this.readRunState(runId, dispatchedRun);
    if (runState) {
      if (runState.outcome === 'stood_down' && runState.reason === 'run_cancelled') {
        return this.reconcileCancellation({
          runId,
          reconciledBy: 'executor',
          usageStatus: 'complete',
          traceStatus: 'recorded',
          trace: [],
          steps: 0,
          finishReason: 'cancelled_before_execution',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          durationMs: Date.now() - startedAt,
        });
      }
      return runState;
    }

    // ── 2b. cancellation / terminal state, case side ─────────────────
    if (TERMINAL_CASE_STATUSES.has(case_.status)) {
      return {
        outcome: 'discarded',
        reason: 'case_terminal',
        summary: `Assistant task discarded: the case is already ${case_.status}.`,
      };
    }

    // ── 3. deterministic input checks ───────────────────────────────
    // These run before the requester is reloaded, because one of them IS
    // "does this case name a requester at all" — there is nothing to reload
    // until that holds.
    const limits = resolveAssistantIntakeLimits();
    const inputCheck = checkAssistantTaskInput(case_, limits.maxInputChars);
    if (!inputCheck.ok) {
      return this.fail(case_, dispatchedRun, {
        reason: `input:${inputCheck.reason}`,
        message: inputCheck.message ?? 'Assistant task input rejected.',
        durationMs: Date.now() - startedAt,
      });
    }
    const requesterUserId = case_.assistant_context!.requester_user_id!;

    // ── 3b. reload the requester (the identity every tool read is scoped to) ──
    const identity = await this.verifyRequester(requesterUserId, case_);
    if (!identity.ok) {
      return this.fail(case_, dispatchedRun, {
        reason: identity.reason,
        message: identity.message,
        durationMs: Date.now() - startedAt,
      });
    }
    const requesterProfile = identity.profile;

    // ── 4. record that work started ─────────────────────────────────
    if (case_.status === 'open') {
      try {
        case_ = await this.transitionCase(caseId, 'in_build', {
          run_id: runId,
          attempt: dispatchedRun.attempt ?? 1,
        });
      } catch (err) {
        return this.fail(case_, dispatchedRun, {
          reason: 'transition:in_build',
          message: `Assistant task could not start: ${describeError(err)}`,
          durationMs: Date.now() - startedAt,
        });
      }
    } else if (case_.status !== 'in_build') {
      // `needs_human_decision` and every engineering status: this attempt has
      // no route to `done` from here, and forcing one would bypass the hold the
      // status represents.
      return {
        outcome: 'discarded',
        reason: 'case_status_not_executable',
        summary: `Assistant task discarded: the case is ${case_.status}, which no attempt can complete from.`,
      };
    }

    // ── 5. bind policy before any model/provider work ───────────────
    // The classifier labels the attempt; requester-scoped read availability is
    // independent. Persisting the snapshot here keeps model failures auditable.
    const proposedPolicy = decideAssistantPolicy(case_);
    let activeRun: Run;
    try {
      const binding = await bindAssistantToolPolicy({
        run: dispatchedRun,
        policy: proposedPolicy,
        allowClaimless: !this.claimCapable,
      });
      if (binding.kind === 'blocked') {
        if (binding.reason === 'run_cancelled') {
          await this.reconcileCancellation({
            runId: dispatchedRun.run_id,
            reconciledBy: 'executor',
            usageStatus: 'complete',
            traceStatus: 'recorded',
            trace: [],
            steps: 0,
            finishReason: 'cancelled_before_policy_bind',
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            durationMs: Date.now() - startedAt,
          });
          return { outcome: 'stood_down', reason: 'policy_bind:run_cancelled' };
        }
        return { outcome: 'stood_down', reason: `policy_bind:${binding.reason}` };
      }
      activeRun = binding.run;
    } catch (err) {
      return this.fail(case_, dispatchedRun, {
        reason: 'policy_binding_failed',
        message: `Assistant tool policy could not be bound: ${describeError(err)}`,
        policy: proposedPolicy,
        durationMs: Date.now() - startedAt,
      });
    }
    const policy = activeRun.assistant_tool_policy!;

    let userPrompt: string;
    try {
      const followUpContext = this.options.loadFollowUpContext
        ? await this.options.loadFollowUpContext(case_)
        : await this.followUps.loadContext(case_);
      userPrompt = followUpContext && followUpContext.length > 0
        ? buildAssistantFollowUpUserMessage(case_.description, followUpContext)
        : buildAssistantUserMessage(case_.description);
    } catch (err) {
      return this.fail(case_, activeRun, {
        reason: 'follow_up_context_invalid',
        message: `Assistant follow-up context is invalid: ${describeError(err)}`,
        policy,
        durationMs: Date.now() - startedAt,
      });
    }

    // ── 5c. the requester's always-inject Clerk context (#832 slice A) ──
    // One fetch feeds BOTH the prompt below and `completeAtomically`'s
    // `injected_context` trace field — see `loadInjectedContext`. Failing the
    // attempt on a load error rather than degrading to "no context" keeps a
    // Firestore hiccup from silently answering without standing context the
    // requester expects to be there every time.
    let injectedContext: AssistantInjectedContextEntry[];
    try {
      injectedContext = await this.loadInjectedContext(requesterUserId, bounds);
    } catch (err) {
      return this.fail(case_, activeRun, {
        reason: 'injected_context_load_failed',
        message: `Assistant task could not load standing context: ${describeError(err)}`,
        policy,
        durationMs: Date.now() - startedAt,
      });
    }

    // ── 6. the bounded loop ─────────────────────────────────────────
    // Read once, so the instant the model is told, the instant recorded on the
    // artifact and any window the answer names all refer to the same moment.
    const asOf = this.currentInstant();
    let loop: AssistantLoopResult;
    let modelId = 'unknown';
    let cancellationRegistration: ReturnType<typeof registerAssistantRunCancellation> | undefined;
    try {
      const resolved = await this.resolveModel(case_);
      modelId = resolved.modelId;
      cancellationRegistration = registerAssistantRunCancellation(activeRun.run_id);
      loop = await runAssistantLoop({
        model: resolved.model,
        system: buildAssistantSystemPrompt(asOf, requesterProfile, injectedContext),
        prompt: userPrompt,
        descriptors: selectReadTools(policy.enabled_tools),
        bounds,
        requesterUserId,
        caseId,
        checkCancellation: () => assertAssistantRunNotCancelled(activeRun.run_id),
        cancellationSignal: cancellationRegistration.signal,
        ...(this.options.generate ? { generate: this.options.generate } : {}),
      });
    } catch (err) {
      return this.fail(case_, activeRun, {
        reason: 'model_call_failed',
        message: `Assistant task failed during generation: ${describeError(err)}`,
        policy,
        modelId,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      cancellationRegistration?.release();
    }

    if (loop.outcome === 'cancelled') {
      return this.reconcileCancellation({
        runId: activeRun.run_id,
        reconciledBy: 'executor',
        usageStatus: loop.cancellation_usage_status ?? 'partial',
        traceStatus: 'recorded',
        trace: loop.trace,
        steps: loop.steps,
        finishReason: loop.finish_reason,
        modelId,
        inputTokens: loop.input_tokens,
        outputTokens: loop.output_tokens,
        totalTokens: loop.total_tokens,
        durationMs: Date.now() - startedAt,
      });
    }

    // The provider may settle immediately before a cancellation commit. Re-read
    // the durable fence before interpreting that settled result as answer or
    // failure; completion performs the same check again inside its transaction.
    try {
      await assertAssistantRunNotCancelled(activeRun.run_id);
    } catch (err) {
      if (!isAssistantRunCancelledError(err)) throw err;
      return this.reconcileCancellation({
        runId: activeRun.run_id,
        reconciledBy: 'executor',
        usageStatus: 'complete',
        traceStatus: 'recorded',
        trace: loop.trace,
        steps: loop.steps,
        finishReason: loop.finish_reason,
        modelId,
        inputTokens: loop.input_tokens,
        outputTokens: loop.output_tokens,
        totalTokens: loop.total_tokens,
        durationMs: Date.now() - startedAt,
      });
    }

    if (loop.outcome === 'bound_exceeded') {
      const bound = loop.bound ?? 'attempt_wall_clock';
      return this.fail(case_, activeRun, {
        reason: `bound:${bound}`,
        message: boundFailureMessage(bound, { answerRetried: loop.answer_retried }),
        policy,
        modelId,
        trace: loop.trace,
        bounds,
        answerRetried: loop.answer_retried,
        durationMs: Date.now() - startedAt,
        ...(loop.discarded_preamble ? { discardedPreamble: loop.discarded_preamble } : {}),
      });
    }

    // ── 7. output validation ────────────────────────────────────────
    // Exactly the model's own text is validated and stored, whether or not its
    // reads were withheld. Nothing is prepended: `maxAnswerChars` then bounds the
    // same thing on both paths, so an answer near the limit cannot pass when the
    // budget was untouched and fail `answer_too_long` when it was spent. That the
    // reads ran out is recorded as metadata, not written into the answer — see
    // the note in `assistant-prompt.ts`.
    const answer = loop.answer;
    const validation = validateAssistantAnswer(answer, bounds.maxAnswerChars);
    if (!validation.ok) {
      return this.fail(case_, activeRun, {
        reason: `answer:${validation.reason}`,
        message: validation.message ?? 'Assistant answer rejected.',
        policy,
        modelId,
        trace: loop.trace,
        bounds,
        answerRetried: loop.answer_retried,
        durationMs: Date.now() - startedAt,
      });
    }

    // ── 8. commit everything, or nothing ───────────────────────────
    return this.completeAtomically({
      case_,
      run: activeRun,
      requesterUserId,
      policy,
      modelId,
      bounds,
      answer,
      asOf,
      injectedContext,
      readsWithheld: loop.reads_withheld,
      readsWithheldReason: loop.reads_withheld_reason,
      answerRetried: loop.answer_retried,
      trace: loop.trace,
      steps: loop.steps,
      finishReason: loop.finish_reason,
      inputTokens: loop.input_tokens,
      outputTokens: loop.output_tokens,
      totalTokens: loop.total_tokens,
      durationMs: Date.now() - startedAt,
    });
  }

  /** The attempt's clock, injectable so a test can pin what reaches the model. */
  private currentInstant(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Is the run still the one we claimed? Returns a stand-down outcome when it
   * is not, `null` when it is.
   *
   * `stood_down` rather than `discarded` on purpose: a run that is already
   * `failed`/`cancelled`/`completed`, or that carries another worker's id, must
   * not be written to at all — completing it would resurrect a terminal run and
   * could turn a swept failure into a false success.
   *
   * Ownership decides, not status: a run is ours when its stored document
   * carries our worker id, whatever its status. A `pending` run we own is
   * therefore still tolerated. An unclaimed `pending` document, however, must
   * stand down: every assistant attempt that reaches this executor has been
   * promoted by `claimRun` — from intake, the assistant sub-sweep, and
   * `RunCompletionHandler.retryRun`.
   *
   * The one unowned run that must still execute is the deliberate claim-less
   * hand-over: `RunExecutor.claimIfUnclaimed` passes an `awaiting_claim` run
   * straight through when the adapter implements no `claimRun` at all. That is
   * a structural property of the deployment, so it is asked of the adapter
   * (`claimCapable`, wired in `RunExecutor.resolveAssistantRunner`) and never
   * inferred from the run document.
   *
   * `awaiting_claim` specifically must NOT be used for that inference. A won
   * claim deletes the flag, so a run that still carries it did not come from a
   * successful claim — but that leaves three causes, not one: the adapter has
   * no `claimRun` (structural), `claimRun` returned `false` because another
   * worker won, or `claimRun` threw on a transient error. The latter two are
   * runtime outcomes and are handled where they occur, in `claimIfUnclaimed`:
   * a lost race returns `null` and the execution stands down, and a throw
   * propagates so the attempt fails and the retry path takes over. Treating
   * either as "no claim support" would let a single transient Firestore error
   * push a real assistant task down the unowned path and close its run without
   * the work having happened — a silent wrong result rather than a failure.
   *
   * Standing down is fail-closed. The claim sweep will hand an unclaimed run to
   * exactly one worker; executing it here would instead be a second, unowned
   * execution.
   */
  private async readRunState(
    runId: string,
    dispatchedRun: Run,
  ): Promise<AssistantRunOutcome | null> {
    const snapshot = await collections.runs().doc(runId).get();
    if (!snapshot.exists) {
      return { outcome: 'stood_down', reason: 'run_missing' };
    }
    const current = snapshot.data()!;
    if (current.assistant_cancel_intent !== undefined) {
      return { outcome: 'stood_down', reason: 'run_cancelled' };
    }
    if (isTerminalRunStatus(current.status)) {
      return { outcome: 'stood_down', reason: `run_${current.status}` };
    }
    if (!current.worker_id && this.claimCapable) {
      return { outcome: 'stood_down', reason: 'run_unclaimed' };
    }
    if (
      dispatchedRun.worker_id
      && current.worker_id
      && current.worker_id !== dispatchedRun.worker_id
    ) {
      return { outcome: 'stood_down', reason: 'run_reassigned' };
    }
    return null;
  }

  /**
   * The requester must still exist and still be a member of the case's project.
   * The run executes under a system actor, but every tool read is scoped to
   * this identity — so a revoked membership has to stop the attempt, not
   * silently fall back to system-level visibility.
   *
   * On success, also returns the requester's prompt profile (display name,
   * email) — narrowed from the SAME document read above, and read here rather
   * than a second time later, because this is where the executor already
   * loads the requester's own record as case context (not inside the tool
   * loop; see `assistant-prompt.ts`'s `requesterIdentitySection`). Narrowing
   * happens at the point of extraction, before the profile ever leaves this
   * function: only `display_name`/`email` are copied out, so the user
   * document's id, roles and avatar never become reachable from the caller,
   * let alone from the prompt. A document missing either field yields `null`
   * — gracefully, since a stale or partial user record must not fail an
   * otherwise-valid attempt over an optional data block.
   */
  private async verifyRequester(
    requesterUserId: string,
    case_: Case,
  ): Promise<
    | { ok: true; profile: RequesterPromptProfile | null }
    | { ok: false; reason: string; message: string }
  > {
    const [userSnap, projectSnap] = await Promise.all([
      collections.users().doc(requesterUserId).get(),
      collections.projects().doc(case_.project_id).get(),
    ]);
    if (!userSnap.exists) {
      return {
        ok: false,
        reason: 'requester_unknown',
        message:
          'Assistant task cannot run: the requesting user no longer exists, so no access scope '
          + 'can be resolved for its tools.',
      };
    }
    if (!projectSnap.exists || !isEffectiveMember(projectSnap.data()!, requesterUserId)) {
      return {
        ok: false,
        reason: 'requester_not_member',
        message:
          'Assistant task cannot run: the requesting user is no longer a member of the case project.',
      };
    }
    const userDoc = userSnap.data();
    const displayName = userDoc?.['display_name'];
    const email = userDoc?.['email'];
    const profile: RequesterPromptProfile | null =
      typeof displayName === 'string' && displayName.length > 0
      && typeof email === 'string' && email.length > 0
        ? { displayName, email }
        : null;
    return { ok: true, profile };
  }

  /**
   * The requester's always-inject Clerk context (#832 slice A): knowledge
   * assets in their OWN private Clerk project (`clerkCoreIds`, never the
   * case's `project_id` — for a Clerk task those are the same project, but
   * naming it via the requester keeps this query independent of which case
   * happens to be running) marked `always_inject: true`, most-recently-
   * updated first, with both bounds applied.
   *
   * Narrowed to `{knowledge_id, title, body}` HERE, before anything else on
   * the asset (status, tags, source refs, trust_level) becomes reachable
   * from either the prompt or the trace. Called exactly once per attempt —
   * the caller passes the SAME returned list to `buildAssistantSystemPrompt`
   * and to `completeAtomically`'s `injected_context`, so there is no second
   * query and the two can never disagree about what was injected.
   */
  private async loadInjectedContext(
    requesterUserId: string,
    bounds: Pick<AssistantBounds, 'maxInjectedContextEntries' | 'maxInjectedContextChars'>,
  ): Promise<AssistantInjectedContextEntry[]> {
    const { projectId } = clerkCoreIds(requesterUserId);
    const snapshot = await collections.knowledgeAssets()
      .where('scope_ref', '==', projectId)
      .where('always_inject', '==', true)
      .orderBy('updated_at', 'desc')
      .get();
    const candidates: AssistantInjectedContextEntry[] = snapshot.docs.map((doc) => {
      const asset = doc.data() as KnowledgeAsset;
      return { knowledge_id: asset.knowledge_id, title: asset.title, body: asset.body };
    });
    return applyInjectedContextBounds(candidates, bounds);
  }

  /** One status transition, in its own transaction, through the shared core. */
  private async transitionCase(
    caseId: string,
    target: 'in_build',
    payload: Record<string, unknown>,
  ): Promise<Case> {
    let committedEvents: CaseEvent[] = [];
    const case_ = await getDb().runTransaction(async (tx) => {
      const result = await applyTransitionInTransaction(
        tx,
        caseId,
        target,
        SYSTEM_ACTOR,
        this.transitionDeps(),
        { extraEventPayload: { triggered_by: 'assistant_task_executor', ...payload } },
      );
      // Retry-safe reassignment — see the same note in `completeAtomically`.
      committedEvents = result.committedEvents;
      return result.case;
    });
    // Post-commit, same hook the plain `emit()` path uses — see
    // `EventService.notifyCommitted`.
    this.eventService.notifyCommitted(committedEvents);
    return case_;
  }

  private transitionDeps(
    loadPreconditionContext = this.options.loadPreconditionContext
      ?? loadTransactionPreconditionContext,
  ) {
    return {
      caseRepo: this.caseRepo,
      eventService: this.eventService,
      stateMachine: this.stateMachine,
      loadPreconditionContext,
    };
  }

  private async resolveModel(case_: Case): Promise<{ model: LanguageModel; modelId: string }> {
    if (this.options.resolveModel) return this.options.resolveModel(case_);
    const risk = (case_.assistant_context?.risk_level ?? case_.risk_level) as RiskLevel;
    const [model, modelId] = await Promise.all([
      resolveModelForRiskWithProject(risk, case_.project_id),
      getModelForRiskWithProject(risk, case_.project_id),
    ]);
    return { model, modelId };
  }

  /**
   * Record a failed attempt and hand the verdict back to `RunExecutor`, which
   * fails the run and lets the retry policy decide. The `assistant_task_failed`
   * event is emitted here (best-effort, outside any transaction) because the
   * timeline is the only place a bound or a rejected answer would otherwise be
   * visible — the run's `error_message` alone is not on the case.
   *
   * The event carries the tool calls themselves, not just how many there were.
   * A failed attempt has usually already read real data on the requester's
   * behalf; recording only the count leaves an audit trail that says six reads
   * happened and cannot say what they were. No artifact is written on this path
   * (there is no result to reference), so the event payload is the trail —
   * `run_completed` records the same records for the same reason.
   */
  private async fail(
    case_: Case,
    run: Run,
    detail: {
      reason: string;
      message: string;
      durationMs: number;
      policy?: AssistantPolicyDecision;
      modelId?: string;
      trace?: ToolCallRecord[];
      bounds?: AssistantBounds;
      /**
       * Whether the reserved answer step was asked twice. Recorded on THIS path
       * and not only on the completed one, because the question the field exists
       * to answer — how often does the first ask come back empty — is answered
       * mostly by runs that failed anyway. Carried only when the loop ran, so
       * `absent` never means `false`.
       */
      answerRetried?: boolean;
      /**
       * The clipped preamble the model emitted alongside the tool calls it spent
       * the reserved step on, when the second ask then also failed. Never an
       * answer and never stored as one — recorded here because it was the last
       * thing the model said, and the trace should not lose it.
       */
      discardedPreamble?: string;
    },
  ): Promise<AssistantRunOutcome> {
    console.error(JSON.stringify({
      event: 'assistant_run_outcome',
      outcome: 'failed',
      run_id: run.run_id,
      case_id: case_.case_id,
      attempt: run.attempt ?? 1,
      reason: detail.reason,
      ...(detail.reason.startsWith('bound:')
        ? { bound: detail.reason.slice('bound:'.length) }
        : {}),
      error: detail.message,
      tool_call_count: detail.trace?.length ?? 0,
      model: detail.modelId ?? 'unresolved',
      duration_ms: detail.durationMs,
    }));
    try {
      await this.eventService.emit(
        case_.case_id,
        'assistant_task_failed',
        {
          run_id: run.run_id,
          attempt: run.attempt ?? 1,
          reason: detail.reason,
          ...(detail.policy ? { task_kind: detail.policy.task_kind } : {}),
          ...(detail.policy ? { tools_enabled: detail.policy.enabled_tools } : {}),
          ...(detail.policy
            ? {
                tool_selection_reason: detail.policy.tool_selection_reason,
                assistant_tool_policy: detail.policy,
              }
            : {}),
          ...(detail.modelId ? { model: detail.modelId } : {}),
          ...(detail.trace
            ? { tool_calls: detail.trace.length, tool_call_records: detail.trace }
            : {}),
          ...(detail.bounds ? { bounds: boundsPayload(detail.bounds) } : {}),
          ...(detail.answerRetried === undefined
            ? {}
            : { answer_retried: detail.answerRetried }),
          ...(detail.discardedPreamble ? { discarded_preamble: detail.discardedPreamble } : {}),
        },
        SYSTEM_ACTOR,
      );
    } catch (err) {
      console.warn(
        `[AssistantTaskExecutor] failed to emit assistant_task_failed for run ${run.run_id}:`,
        err,
      );
    }
    return { outcome: 'failed', reason: detail.reason, message: detail.message };
  }

  /**
   * Best-effort executor side of the durable cancellation handshake. The Run
   * is already terminal and fenced; a transient reconciliation failure must
   * never turn it into a retryable task failure. Its pending marker remains for
   * the assistant sweeper to settle with an honest unavailable receipt.
   */
  private async reconcileCancellation(
    input: AssistantCancellationReconcileInput,
  ): Promise<AssistantRunOutcome> {
    try {
      await this.cancellationService.reconcile(input);
    } catch (err) {
      console.warn(
        `[AssistantTaskExecutor] cancellation trace reconciliation failed for run ${input.runId}; `
          + 'leaving the durable pending marker for the assistant sweep:',
        err,
      );
    }
    return { outcome: 'stood_down', reason: 'run_cancelled' };
  }

  /**
   * The five documents that make a completed assistant task, committed together:
   * the run's completion, the artifact row, the `task_result` evidence, the
   * case's `in_build → done` transition, and the completion event (plus the
   * transition's own `assistant_task_completed`).
   *
   * ## Why the precondition is evaluated against the post-commit state
   *
   * `assistant_result_evidence_present` requires the latest `assistant_task_run`
   * to be `completed` AND a `task_result` evidence row pointing at it. Both are
   * created by THIS transaction, and a Firestore read never sees a
   * transaction's own staged writes — so validating against the committed state
   * would make the transition permanently unsatisfiable, and validating after
   * the commit would allow a case left `in_build` with its result already
   * recorded. The transition is therefore validated against exactly the state
   * this transaction is about to commit, by overlaying the staged run status and
   * the staged evidence onto the loaded context. The state machine still decides;
   * nothing about the precondition is bypassed or duplicated.
   *
   * ## Ordering inside the transaction
   *
   * All reads first (case, run, and the transition core's own case read), then
   * every write. Firestore rejects a read after a write, and the transition core
   * reads — so it is invoked before any of the four other writes are staged.
   *
   * ## Bytes vs. rows
   *
   * The artifact's BYTES are written to object storage before the transaction
   * opens, because they are not a Firestore document and cannot participate in
   * it. A discarded transaction therefore leaves an unreferenced blob behind —
   * unreachable, since nothing points at it, and cheaper than the alternative of
   * writing the row first and the bytes after, which would leave a row that
   * resolves to nothing.
   */
  private async completeAtomically(input: {
    case_: Case;
    run: Run;
    requesterUserId: string;
    policy: AssistantPolicyDecision;
    modelId: string;
    bounds: AssistantBounds;
    answer: string;
    /** The instant the model was told was "now". */
    asOf: Date;
    /**
     * The SAME fetch that fed `buildAssistantSystemPrompt` — see
     * `loadInjectedContext`. Narrowed further here, to `{knowledge_id, title}`,
     * because the trace records what was injected, never the body.
     */
    injectedContext: AssistantInjectedContextEntry[];
    readsWithheld: boolean;
    readsWithheldReason: AssistantReadsWithheldReason | null;
    answerRetried: boolean;
    trace: ToolCallRecord[];
    steps: number;
    finishReason: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    durationMs: number;
  }): Promise<AssistantRunOutcome> {
    const { case_, run } = input;
    const now = this.currentInstant().toISOString();
    const artifactId = generateId('artifact');
    const evidenceId = generateId('evidence');
    const preview = answerPreview(input.answer);

    const resultDocument = {
      schema: 'arbitra.assistant_task_result/v2',
      case_id: case_.case_id,
      run_id: run.run_id,
      attempt: run.attempt ?? 1,
      requester_user_id: input.requesterUserId,
      task_kind: input.policy.task_kind,
      assistant_tool_policy: input.policy,
      policy_version: case_.assistant_context?.policy_version ?? null,
      prompt_version: case_.assistant_context?.prompt_version ?? null,
      model: input.modelId,
      // The answer, and the full tool trace. Deliberately NOT here: the system
      // prompt, the assembled user message, any reasoning the model produced,
      // and any credential — see `assistant-prompt.ts`.
      answer: input.answer,
      /**
       * The instant the model was told was "now", and the frame every relative
       * window in the answer above is expressed in
       * (`ASSISTANT_PROMPT_TIME_ZONE`).
       *
       * Recorded because an answer is read later than it was written, and "the
       * last 48 hours" moves while it sits in the case. `created_at` below is the
       * moment this document was committed, which is close but is not the same
       * fact: it is when the result was stored, not the reference point the
       * reasoning used.
       */
      as_of: input.asOf.toISOString(),
      /**
       * The reserved answer step had to be asked twice, because the first ask
       * produced no text. A property of the run, not of the answer.
       */
      answer_retried: input.answerRetried,
      // The observable fact about how this answer was produced: the step that
      // produced it had no reads available, and which budget took them away. NOT
      // a claim that the answer is incomplete — that is the model's to make, in
      // the answer text above, and only when it has a gap to report.
      //
      // Recorded next to the answer AND carried on both completion events, because
      // these are read by different people at different times: the artifact is
      // what someone re-reading the case sees, the events are what the timeline
      // and an MCP consumer see. All three are machine-readable, so an audit can
      // filter for spent budgets without parsing prose.
      reads_withheld: input.readsWithheld,
      reads_withheld_reason: input.readsWithheldReason,
      tools_enabled: input.policy.enabled_tools,
      tool_calls: input.trace,
      /**
       * The always-inject Clerk context entries this attempt's prompt
       * actually carried (#832 slice A) — names and ids only, never the
       * body text, so a reader of the trace sees WHAT stood context shaped
       * the answer without the trace itself becoming a second copy of it.
       * From the SAME fetch that built the prompt (`loadInjectedContext`),
       * so this can never disagree with what the model was actually shown.
       */
      injected_context: input.injectedContext.map(({ knowledge_id, title }) => ({
        knowledge_id,
        title,
      })),
      /**
       * Steps of the ceiling that ran, which is the number `bounds.max_steps`
       * below is the ceiling FOR — so the document cannot appear to violate the
       * bound printed beside it. The second ask for the answer is a model call
       * outside that ceiling's count; it is reported by `answer_retried` above,
       * and model calls made is `steps` plus one when that is true.
       */
      steps: input.steps,
      finish_reason: input.finishReason,
      /**
       * Every model call of the attempt, the second ask included. The split sums
       * to the total by construction (`assistant-loop.ts`), which is what a reader
       * of "total (in / out)" assumes and what a cost figure derived from the
       * split needs.
       */
      usage: {
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        total_tokens: input.totalTokens,
      },
      bounds: boundsPayload(input.bounds),
      /** Whole attempt, from the first reload to the completion. */
      duration_ms: input.durationMs,
      created_at: now,
    };

    const storage = this.options.storage ?? getArtifactStorage();
    const serialised = JSON.stringify(resultDocument, null, 2);
    const base64 = Buffer.from(serialised, 'utf-8').toString('base64');
    const filename = `assistant-task-result-${run.run_id}.json`;
    const storagePath = await storage.save(filename, 'application/json', base64);

    const artifact: Artifact = {
      artifact_id: artifactId,
      case_id: case_.case_id,
      run_id: run.run_id,
      filename,
      content_type: 'application/json',
      storage_path: storagePath,
      size_bytes: Buffer.byteLength(serialised, 'utf-8'),
      created_by: SYSTEM_ACTOR,
      created_at: now,
    };

    const evidence: Evidence = {
      evidence_id: evidenceId,
      case_id: case_.case_id,
      run_id: run.run_id,
      type: 'task_result',
      source_type: 'automated',
      // What `assistant_result_evidence_present` requires: a non-empty
      // reference. It points at the artifact row above, which is the stored
      // result — resolvable through `GET /api/artifacts/:id/content`.
      artifact_ref: artifactId,
      summary: preview,
      machine_readable: true,
      validation_track: case_.validation_track,
      created_at: now,
      created_by: SYSTEM_ACTOR,
    };

    // Says what the attempt did, not what the answer is worth: an operator
    // scanning run summaries can see which answers were produced with the reads
    // already gone, without the summary asserting that any of them fell short.
    const runSummary = input.readsWithheld
      ? `Assistant task answered with no reads left (${input.trace.length} tool call(s), `
        + `${input.readsWithheldReason ?? 'read budget'} spent): ${preview}`
      : `Assistant task answered (${input.trace.length} tool call(s)): ${preview}`;

    type CommitResult =
      // `events`: every CaseEvent this transaction staged (transition events
      // plus `run_completed`), for the post-commit notify below — same
      // reasoning as `transitionCase`.
      | { kind: 'committed'; events: CaseEvent[] }
      | { kind: 'discarded'; reason: string; summary: string }
      | { kind: 'stood_down'; reason: string };

    let result: CommitResult;
    try {
      result = await getDb().runTransaction<CommitResult>(async (tx) => {
        // ---- reads (Firestore forbids any read after the first write) ----
        const caseRef = collections.cases().doc(case_.case_id);
        const runRef = collections.runs().doc(run.run_id);
        const [caseSnap, runSnap] = await Promise.all([tx.get(caseRef), tx.get(runRef)]);

        const freshCase = caseSnap.data();
        if (!freshCase || freshCase.deleted_at) {
          return {
            kind: 'discarded',
            reason: 'case_unavailable',
            summary: 'Assistant task result discarded: the case was deleted while it ran.',
          };
        }
        if (TERMINAL_CASE_STATUSES.has(freshCase.status)) {
          const terminalRun = runSnap.data();
          if (
            terminalRun?.status === 'cancelled'
            || terminalRun?.assistant_cancel_intent !== undefined
          ) {
            return { kind: 'stood_down', reason: 'run_cancelled' };
          }
          return {
            kind: 'discarded',
            reason: 'case_terminal',
            summary: `Assistant task result discarded: the case became ${freshCase.status} while it ran.`,
          };
        }
        const freshRun = runSnap.data();
        if (!freshRun) return { kind: 'stood_down', reason: 'run_missing' };
        if (isTerminalRunStatus(freshRun.status)) {
          return { kind: 'stood_down', reason: `run_${freshRun.status}` };
        }
        if (run.worker_id && freshRun.worker_id && freshRun.worker_id !== run.worker_id) {
          return { kind: 'stood_down', reason: 'run_reassigned' };
        }
        if ((freshRun.attempt ?? 1) !== (run.attempt ?? 1)) {
          return { kind: 'stood_down', reason: 'run_attempt_changed' };
        }
        if (freshRun.assistant_cancel_intent !== undefined) {
          return { kind: 'stood_down', reason: 'run_cancelled' };
        }
        try {
          assertAssistantRunPolicyInvariant(freshRun);
        } catch {
          return { kind: 'stood_down', reason: 'run_policy_invalid' };
        }
        if (
          freshRun.assistant_policy_state !== 'bound'
          || !assistantToolPoliciesEqual(freshRun.assistant_tool_policy!, input.policy)
        ) {
          return { kind: 'stood_down', reason: 'run_policy_changed' };
        }

        // The transition reads the case, so it runs before any write of ours.
        // Its case update also carries `task_kind`: Firestore rejects more than
        // one mutation per document per commit, so the classification cannot be
        // a second `tx.update` on the same case.
        const transitionResult = await applyTransitionInTransaction(
          tx,
          case_.case_id,
          'done',
          SYSTEM_ACTOR,
          this.transitionDeps(async (loadedCase, actorId) => {
            const base = await (this.options.loadPreconditionContext
              ?? loadTransactionPreconditionContext)(loadedCase, actorId);
            return projectStagedWrites(base, run.run_id, now, evidence);
          }),
          {
            // `assistant_task_completed` is the one event whose NAME asserts that
            // the task is answered, so it carries the read-budget fact too. A
            // consumer keying on this event to decide "answered" would otherwise
            // have no way to tell an attempt that still had reads to spare from one
            // that answered with none left — the case reaches `done` either way.
            extraEventPayload: {
              run_id: run.run_id,
              attempt: run.attempt ?? 1,
              reads_withheld: input.readsWithheld,
              assistant_tool_policy: input.policy,
              ...(input.readsWithheldReason
                ? { reads_withheld_reason: input.readsWithheldReason }
                : {}),
            },
            // Intake deliberately leaves `task_kind` absent ("not classified
            // yet"); classification is this executor's job, so it lands with
            // the result. `reads_withheld` (and its reason, when present)
            // travels the same way, onto the same document, in the same
            // write — it is otherwise only visible on the `run_completed`
            // event payload below, which the Scheduled tab's occurrence list
            // cannot read (it lists cases, not events).
            extraCaseUpdates: {
              assistant_context: {
                ...freshCase.assistant_context!,
                task_kind: input.policy.task_kind,
                reads_withheld: input.readsWithheld,
                ...(input.readsWithheldReason
                  ? { reads_withheld_reason: input.readsWithheldReason }
                  : {}),
              },
            },
          },
        );

        // ---- writes ----
        tx.update(runRef, {
          status: 'completed',
          summary: runSummary,
          finished_at: now,
          updated_at: now,
          output_refs: [artifactId],
          token_usage: {
            prompt_tokens: input.inputTokens,
            completion_tokens: input.outputTokens,
            total_tokens: input.totalTokens,
            model: input.modelId,
          },
          ...(case_.assistant_context?.prompt_version
            ? { prompt_version: case_.assistant_context.prompt_version }
            : {}),
          lease_expires_at: FieldValue.delete(),
          worker_id: FieldValue.delete(),
        });
        tx.create(collections.artifacts().doc(artifactId), artifact);
        tx.create(collections.evidence().doc(evidenceId), evidence);
        const runCompletedEvent = await this.eventService.emitInTransaction(
          tx,
          case_.case_id,
          'run_completed',
          {
            run_id: run.run_id,
            run_type: run.run_type,
            attempt: run.attempt ?? 1,
            artifact_id: artifactId,
            evidence_id: evidenceId,
            task_kind: input.policy.task_kind,
            tools_enabled: input.policy.enabled_tools,
            tool_selection_reason: input.policy.tool_selection_reason,
            assistant_tool_policy: input.policy,
            // The short trace summary. Per call: name, the parameter summary the
            // descriptor declared, result size, duration, outcome. No prompt, no
            // reasoning, no raw tool output, no credential.
            tool_calls: input.trace,
            // Steps of the ceiling, so `steps <= bounds.max_steps` holds on every
            // run. The second ask for the answer is a model call the ceiling did
            // not count, and it travels beside the count rather than inside it.
            steps: input.steps,
            answer_retried: input.answerRetried,
            finish_reason: input.finishReason,
            model: input.modelId,
            input_tokens: input.inputTokens,
            output_tokens: input.outputTokens,
            answer_chars: input.answer.length,
            reads_withheld: input.readsWithheld,
            ...(input.readsWithheldReason
              ? { reads_withheld_reason: input.readsWithheldReason }
              : {}),
            duration_ms: input.durationMs,
          },
          SYSTEM_ACTOR,
        );

        return {
          kind: 'committed',
          events: [...transitionResult.committedEvents, runCompletedEvent],
        };
      });
    } catch (err) {
      if (err instanceof TransitionError) {
        // The state machine refused the transition against the state this
        // transaction would have committed — most plausibly because a newer
        // attempt has since been prepared and is now the latest run, which will
        // produce its own result. Nothing was written; discard rather than fail,
        // so the run's lease is released with the reason recorded.
        return {
          outcome: 'discarded',
          reason: 'transition_refused',
          summary: `Assistant task result discarded: ${err.message}`,
        };
      }
      return this.fail(case_, run, {
        reason: 'completion_failed',
        message: `Assistant task completion failed: ${describeError(err)}`,
        policy: input.policy,
        modelId: input.modelId,
        trace: input.trace,
        bounds: input.bounds,
        durationMs: input.durationMs,
      });
    }

    if (result.kind === 'committed') {
      // Post-commit, same hook the plain `emit()` path uses — see
      // `EventService.notifyCommitted`. `assistant_task_completed` and
      // `case_completed` (from the transition) plus `run_completed` all
      // reach the notifier for the first time here; before this they were
      // staged via `emitInTransaction` and never notified at all.
      this.eventService.notifyCommitted(result.events);
      return { outcome: 'completed', summary: runSummary };
    }
    if (result.kind === 'discarded') {
      return { outcome: 'discarded', reason: result.reason, summary: result.summary };
    }
    if (result.reason === 'run_cancelled') {
      return this.reconcileCancellation({
        runId: run.run_id,
        reconciledBy: 'executor',
        usageStatus: 'complete',
        traceStatus: 'recorded',
        trace: input.trace,
        steps: input.steps,
        finishReason: input.finishReason,
        modelId: input.modelId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        totalTokens: input.totalTokens,
        durationMs: input.durationMs,
      });
    }
    return { outcome: 'stood_down', reason: result.reason };
  }
}

/**
 * Overlay this transaction's staged writes onto a loaded precondition context:
 * our run as `completed`, our evidence as present. See the argument on
 * `completeAtomically`.
 */
export function projectStagedWrites(
  base: PreconditionContext,
  runId: string,
  finishedAt: string,
  evidence: Evidence,
): PreconditionContext {
  const runs = base.runs.map((candidate) =>
    candidate.run_id === runId
      ? { ...candidate, status: 'completed' as const, finished_at: finishedAt }
      : candidate,
  );
  return {
    ...base,
    runs,
    evidence: [...base.evidence, evidence],
  };
}

/**
 * A run this attempt must not write to. Status distinguishes terminal from
 * in-flight; `readRunState` decides ownership separately.
 */
function isTerminalRunStatus(status: Run['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function boundsPayload(bounds: AssistantBounds): Record<string, number> {
  return {
    max_steps: bounds.maxSteps,
    // Recorded alongside `max_steps` because it, not `max_steps`, is how many
    // steps the attempt could actually spend on reads — a payload that reports
    // only the ceiling reads as one more read than the attempt ever had.
    tool_step_budget: toolStepBudget(bounds),
    max_tool_calls: bounds.maxToolCalls,
    tool_call_limit_ms: bounds.toolCallLimitMs,
    token_budget: bounds.tokenBudget,
    attempt_wall_clock_ms: bounds.attemptWallClockMs,
    max_answer_chars: bounds.maxAnswerChars,
    max_output_tokens: bounds.maxOutputTokens,
    max_answer_output_tokens: bounds.maxAnswerOutputTokens,
    max_tool_result_chars: bounds.maxToolResultChars,
    max_injected_context_entries: bounds.maxInjectedContextEntries,
    max_injected_context_chars: bounds.maxInjectedContextChars,
  };
}

/** Message only — never a stack trace, which can carry file paths and values. */
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}
