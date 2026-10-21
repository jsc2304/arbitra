import type { Case, Decision, CreateDecisionInput, DecisionSnapshot, Finding, FindingStatus, Project, CaseEvent, Run, RuleResult, FailedPrecondition } from '@arbitra/shared';
import { ArbitraError, isBlockingFindingStatus, isAuthorBlockingOrigin, resolveTransitionTarget, TERMINAL_CASE_STATUSES } from '@arbitra/shared';
import { mostRecentIterationBoundary } from '../orchestration/iteration-boundary.js';

/**
 * Result of `DecisionService.createDecision`.
 *
 * The decision is always persisted on success. `transition_error` is
 * populated when the post-decision state-machine transition could not run
 * (e.g. preconditions not met). The decision itself is not rolled back —
 * it stays as a documented audit record. Callers (HTTP route, UI) should
 * surface the error as a non-fatal warning, not a hard failure.
 */
export interface CreateDecisionResult {
  decision: Decision;
  transition_error?: {
    code: string;
    message: string;
  };
}
import { collections, getDb } from '../../lib/firestore.js';
import { EventService } from '../event/event-service.js';
import { CaseRepository } from '../case/case-repository.js';
import { OrchestrationService } from '../orchestration/orchestration-service.js';
import { RunCompletionHandler } from '../orchestration/pipeline.js';
import { FirestorePipelineAdapter } from '../orchestration/firestore-pipeline-adapter.js';
import { buildDecisionSnapshot, CompletenessEvaluator } from '../evidence/completeness-evaluator.js';
import { RuleRepository } from '../rule/rule-repository.js';
import { generateId } from '../../lib/ids.js';
import { checkSelfApprovalProhibition, checkWaivePermission, checkReviewNotApplicablePermission } from './anti-gaming.js';

/** Decision types for which owner-self-approval audit (`self_approved: true`) applies. */
const SELF_APPROVAL_DECISION_TYPES: ReadonlySet<Decision['type']> = new Set([
  'approve',
  'gate_confirmed',
  'gate_rejected',
]);

/** Map decision type → finding status when decision targets a specific finding */
const decisionToFindingStatus: Partial<Record<Decision['type'], FindingStatus>> = {
  waive: 'waived',
  approve: 'resolved',
  reject: 'contested',
  request_changes: 'open',
  // Agent proposal — NON-terminal. `waiver_proposed` still blocks approval
  // (see BLOCKING_FINDING_STATUSES); a human must confirm with a `waive`/
  // `approve` decision to reach a resolved status. Human-in-the-loop stays
  // intact (issue arbitra-mcp#34).
  propose_waiver: 'waiver_proposed',
};

export class DecisionService {
  constructor(
    private readonly caseRepo = new CaseRepository(),
    private readonly eventService = new EventService(),
    private readonly orchestrationService = new OrchestrationService(),
    private readonly completenessEvaluator = new CompletenessEvaluator(),
    private readonly ruleRepository = new RuleRepository(),
  ) {}

  async createDecision(
    input: CreateDecisionInput,
    actorId: string,
  ): Promise<CreateDecisionResult> {
    const case_ = await this.caseRepo.getById(input.case_id);

    // Terminal-state guard (issue #752): a `done`/`rejected` case has finished
    // its lifecycle — the client-facing route (and anything hitting it, e.g.
    // the MCP surface) must not be able to mutate the decision trail or
    // finding dispositions afterward with no recorded reopening. This mirrors
    // the `TERMINAL_CASE_STATUSES` guards webhook-service.ts already applies
    // at its boundary. System-recorded completion decisions from the #751 fix
    // (`waived_on_completion` in waiver-completion.ts, `auto_approve` /
    // `merge_not_applicable` in firestore-pipeline-adapter.ts) write directly
    // to Firestore and never call `createDecision`, so they are unaffected.
    if (TERMINAL_CASE_STATUSES.has(case_.status)) {
      throw new ArbitraError(
        `Cannot record decision: case ${input.case_id} is ${case_.status} and no longer accepts decisions.`,
        'TERMINAL_CASE_BLOCKS_DECISION',
        409,
        { case_status: case_.status },
      );
    }

    // Resolve the effective evidence-policy cell and parent metadata through
    // the same path used by completeness checks. Resolution must succeed
    // before a decision can be written: an "exact" governance snapshot must
    // never silently substitute fabricated fallback metadata.
    const effectivePolicy = await this.completenessEvaluator.getEffectivePolicy(case_);
    const allowSelfApproval = effectivePolicy.rule.allow_self_approval === true;

    // Anti-gaming: check self-approval prohibition
    checkSelfApprovalProhibition(case_, actorId, input.type, allowSelfApproval);

    const decisionSnapshot = await buildDecisionSnapshot(
      case_,
      this.completenessEvaluator,
      this.ruleRepository,
      effectivePolicy,
    );

    // Human escape hatch for a case stuck in `in_review` (server-side review
    // run failed permanently — e.g. provider quota error). Diverges into
    // its own guarded path entirely: unlike the other case-level decisions
    // below, there is no single `resolveTransitionTarget` — setting the flag
    // can unlock any of the four `in_review` outbound auto-transitions
    // (approved / needs_human_decision / verification_pending), so we let the
    // pipeline's own auto-trigger fanout pick the right one.
    if (input.type === 'review_not_applicable') {
      return this.createReviewNotApplicableDecision(case_, input, actorId, decisionSnapshot);
    }

    // Human-confirmation-rule gate resolution: a `gate_confirmed`/
    // `gate_rejected` decision carrying `rule_id` targets a blocked
    // `human_confirmation` RuleResult rather than the lifecycle
    // `pending_gate` handled further below — mutually exclusive gate kinds.
    // Resolved here, BEFORE the generic decision persist below, so
    // `resolveHumanConfirmationGate` owns writing the Decision itself: the
    // Decision and the RuleResult flip(s) it documents land in a single
    // Firestore transaction (both or neither), and a validation failure
    // (invalid rule, no blocked result, anti-gaming) is thrown before any
    // write, so it never orphans a Decision either. Previously this branch
    // ran AFTER the generic decision persist, so even a plain validation
    // error left a Decision on record for a flip that never happened
    // (issue #738).
    if (
      (input.type === 'gate_confirmed' || input.type === 'gate_rejected') &&
      input.rule_id
    ) {
      const gateDecision = await this.resolveHumanConfirmationGate(
        case_,
        input,
        actorId,
        allowSelfApproval,
        decisionSnapshot,
      );
      return { decision: gateDecision };
    }

    // Manual-track sugar: when a user clicks "Approve" on a manual-track case
    // that does not yet have a `manual_validation_confirmed` decision in the
    // CURRENT iteration, the approve transition would fail its
    // `auto_approve_criteria_met` / `manual_validation_confirmed` precondition.
    // The user-facing model is "Approve = confirm manual validation +
    // approve" — so we auto-attach the missing validation decision FIRST
    // (same actor, same timestamp, same snapshot), then proceed with the
    // approve as normal. Both decisions persist for audit; the user clicked
    // one button.
    //
    // Idempotency is scoped to the current iteration (see
    // `mostRecentIterationBoundary`). A `manual_validation_confirmed` from
    // before the most recent loop-back (`changes_requested`) or before entry
    // into `verification_pending` (`manual_verification_requested`) does NOT
    // count — the user couldn't have meant a stale, in-review confirmation
    // as the verification_pending attestation. This stays in lockstep with
    // the matching precondition in preconditions.ts, so the auto-attach and
    // the gate agree on what counts as "current".
    //
    // Direct-track cases are unaffected.
    if (
      input.type === 'approve' &&
      case_.validation_track === 'manual'
    ) {
      const [existingDecisionsSnap, eventsSnap] = await Promise.all([
        collections.decisions().where('case_id', '==', input.case_id).get(),
        collections.caseEvents().where('case_id', '==', input.case_id).get(),
      ]);
      const events = eventsSnap.docs.map((d) => d.data() as CaseEvent);
      const boundary = mostRecentIterationBoundary(events);
      const hasValidationDecision = existingDecisionsSnap.docs.some((d) => {
        const decision = d.data() as Decision;
        if (decision.type !== 'manual_validation_confirmed') return false;
        // Boundary not yet hit -> all confirmations are "current" (preserves
        // the existing single-approve happy path).
        if (boundary === null) return true;
        return decision.created_at > boundary;
      });
      if (!hasValidationDecision) {
        const autoValidation: Decision = {
          decision_id: generateId('decision'),
          case_id: input.case_id,
          finding_id: input.finding_id,
          type: 'manual_validation_confirmed',
          actor_id: actorId,
          rationale: 'Auto-attached on approve (manual track)',
          snapshot: decisionSnapshot,
          created_at: new Date().toISOString(),
          // The user clicked one button — copy the parent approve's
          // actor_metadata onto the auto-attached confirmation so both audit
          // rows surface the same client (Cursor / Claude Code / Codex).
          ...(input.actor_metadata !== undefined && { actor_metadata: input.actor_metadata }),
        };
        await collections.decisions().doc(autoValidation.decision_id).set(autoValidation);
        await this.eventService.emit(
          input.case_id,
          'decision_created',
          {
            decision_id: autoValidation.decision_id,
            type: autoValidation.type,
            finding_id: autoValidation.finding_id,
            // Forward IDE-client signature onto the event payload so the
            // case timeline (which renders from raw CaseEvent.payload) shows
            // the same client badge as the courtroom + activity feed.
            ...(autoValidation.actor_metadata !== undefined
              ? { actor_metadata: autoValidation.actor_metadata }
              : {}),
          },
          actorId,
        );
      }
    }

    // Guardrail: case-level approve from `needs_human_decision` fails the
    // `all_high_critical_resolved` precondition when any open high/critical
    // finding exists. Previously the decision was written and the
    // transition error was swallowed (see orchestration call below),
    // leaving the UI with no feedback. Fail fast with a structured 409 so
    // the frontend can explain exactly which findings block the approval.
    if (
      input.type === 'approve' &&
      !input.finding_id &&
      case_.status === 'needs_human_decision'
    ) {
      const findingsSnap = await collections.findings()
        .where('case_id', '==', input.case_id)
        .get();
      // Mirror the relaxed `all_high_critical_resolved` precondition: only
      // AUTHORED high/critical findings block the human approve. Submodule/
      // vendored-origin findings the author didn't write must not 409 the
      // approval (issue #633). Back-compat: a missing
      // origin counts as authored and still blocks.
      const openBlockers = findingsSnap.docs
        .map((d) => d.data() as Finding)
        .filter((f) =>
          isAuthorBlockingOrigin(f.origin) &&
          (f.severity === 'high' || f.severity === 'critical') &&
          isBlockingFindingStatus(f.status),
        );
      if (openBlockers.length > 0) {
        throw new ArbitraError(
          `Cannot approve: ${openBlockers.length} open high/critical finding${openBlockers.length === 1 ? '' : 's'} must be waived or resolved first.`,
          'OPEN_FINDINGS_BLOCK_DECISION',
          409,
          {
            open_finding_ids: openBlockers.map((f) => f.finding_id),
            blocking_severities: Array.from(new Set(openBlockers.map((f) => f.severity))),
            guidance: 'Waive or resolve the listed findings before approving.',
          },
        );
      }
    }

    const isOwnerSelfAction =
      actorId === case_.owner_user_id &&
      SELF_APPROVAL_DECISION_TYPES.has(input.type);

    // Build decision snapshot
    const decision: Decision = {
      decision_id: generateId('decision'),
      case_id: input.case_id,
      finding_id: input.finding_id,
      type: input.type,
      actor_id: actorId,
      rationale: input.rationale,
      snapshot: decisionSnapshot,
      created_at: new Date().toISOString(),
      // Rule targeted by a gate_confirmed/gate_rejected that resolves a
      // blocked human_confirmation RuleResult. Absent for lifecycle
      // pending_gate resolutions and all other decision types.
      ...(input.rule_id !== undefined && { rule_id: input.rule_id }),
      // Audit flag: only set true when the owner is acting on their own case under
      // a policy cell that permits it. Never persisted as false.
      ...(isOwnerSelfAction && allowSelfApproval ? { self_approved: true } : {}),
      // Authoritative IDE-agent signature when the caller is an MCP client.
      // Already normalized at the route boundary; we only persist when present
      // so old decisions stay back-compatible.
      ...(input.actor_metadata !== undefined && { actor_metadata: input.actor_metadata }),
    };

    // Waive permission check when targeting a specific finding
    if (input.finding_id && input.type === 'waive') {
      const findingDoc = await collections.findings().doc(input.finding_id).get();
      if (findingDoc.exists) {
        await checkWaivePermission(findingDoc.data()!, actorId, case_, input.rationale);
      }
    }

    await collections.decisions().doc(decision.decision_id).set(decision);

    // Update linked finding status + resolution metadata.
    // A finding-level decision may (a) change the finding status and/or (b)
    // record resolution text, contest the severity, or link a knowledge asset.
    // We persist the metadata whenever it is supplied — even for decision types
    // with no status mapping — so a bare `propose_waiver`/`waive` that carries
    // only a `resolution` still lands it. `resolution` was previously written
    // by nothing (the field existed on the type but was dead); this is where it
    // gets populated.
    if (input.finding_id) {
      const newStatus = decisionToFindingStatus[input.type];
      const findingUpdate: Record<string, unknown> = {};
      if (newStatus) {
        findingUpdate.status = newStatus;
      }
      if (input.resolution !== undefined) {
        findingUpdate.resolution = input.resolution;
      }
      if (input.severity_contested !== undefined) {
        findingUpdate.severity_contested = input.severity_contested;
      }
      if (input.knowledge_asset_ref !== undefined) {
        findingUpdate.knowledge_asset_ref = input.knowledge_asset_ref;
      }
      if (Object.keys(findingUpdate).length > 0) {
        const findingRef = collections.findings().doc(input.finding_id);
        const findingDoc = await findingRef.get();
        if (findingDoc.exists) {
          findingUpdate.updated_at = new Date().toISOString();
          await findingRef.update(findingUpdate);
        }
      }
    }

    await this.eventService.emit(
      input.case_id,
      'decision_created',
      {
        decision_id: decision.decision_id,
        type: input.type,
        finding_id: input.finding_id,
        // Forward IDE-client signature onto the event payload so the
        // case timeline (which renders from raw CaseEvent.payload) shows
        // the same client badge as the courtroom + activity feed.
        ...(decision.actor_metadata !== undefined
          ? { actor_metadata: decision.actor_metadata }
          : {}),
      },
      actorId,
    );

    // Handle gate_confirmed / gate_rejected decisions via the pipeline
    // (the `input.rule_id` variant is resolved earlier — see the
    // human-confirmation-rule branch above — so only the lifecycle
    // pending_gate kind reaches here).
    if (input.type === 'gate_confirmed' || input.type === 'gate_rejected') {
      if (!case_.pending_gate) {
        throw new Error(`Case ${input.case_id} has no pending gate to ${input.type === 'gate_confirmed' ? 'confirm' : 'reject'}`);
      }

      // Anti-gaming: same trust boundary as the human_confirmation RuleResult
      // gate path (`assertGateConfirmerAllowed`) — owner self-approval
      // prohibition + confirmer-role check.
      await this.assertGateConfirmerAllowed(case_, actorId, allowSelfApproval);

      try {
        const adapter = new FirestorePipelineAdapter();
        const handler = new RunCompletionHandler(adapter);

        if (input.type === 'gate_confirmed') {
          await handler.executeGateConfirmation(input.case_id);
        } else {
          await handler.executeGateRejection(input.case_id);
        }
      } catch (error) {
        console.error(`Failed to ${input.type === 'gate_confirmed' ? 'confirm' : 'reject'} gate:`, error);
        throw error;
      }

      return { decision };
    }

    let transitionError: CreateDecisionResult['transition_error'];
    let didTransition = false;
    // Track the status actually transitioned to so the pipeline chain below can
    // mirror the /transition route's in_build carve-out. The finding-level path
    // always targets 'approved'; only the case-level target can be 'in_build'.
    let transitionedTarget: string | undefined;

    // Case-level decisions may trigger a state transition. manual_validation_confirmed
    // and merge_not_applicable are semantically case-level even if the caller
    // attaches a finding_id.
    const isCaseLevelDecision =
      !input.finding_id ||
      input.type === 'manual_validation_confirmed' ||
      input.type === 'merge_not_applicable';
    if (isCaseLevelDecision) {
      const target = resolveTransitionTarget(input.type, case_.status);
      if (target) {
        try {
          await this.orchestrationService.transition(input.case_id, target, actorId);
          didTransition = true;
          transitionedTarget = target;
        } catch (error) {
          // Transition may fail if preconditions aren't met — decision is still
          // recorded. Surface the error to the caller via the result payload
          // instead of swallowing it (previous behavior left the UI showing
          // "success" while the case stayed stuck — see the no-diff bug where
          // approve decisions piled up on cases stuck in_review).
          console.error('Failed to transition case after decision:', error);
          transitionError = toTransitionError(error);
        }
      }
    }

    // Finding-level decisions in needs_human_decision: re-evaluate whether case can advance
    // (e.g. waiving the last blocking finding should auto-advance to approved).
    // A `propose_waiver` is explicitly excluded: it leaves the finding in the
    // still-blocking `waiver_proposed` status, so it must never advance the case
    // — a human confirms the terminal `waive`/`approve` first. (The transition
    // would fail its precondition anyway; the guard makes the intent explicit
    // and avoids a pointless transition attempt + swallowed error.)
    if (
      input.finding_id &&
      input.type !== 'propose_waiver' &&
      case_.status === 'needs_human_decision'
    ) {
      try {
        await this.orchestrationService.transition(input.case_id, 'approved', actorId);
        didTransition = true;
        transitionedTarget = 'approved';
      } catch (error) {
        // Common: preconditions not yet satisfied (other findings still open).
        // Captured for observability but generally not surfaced to the UI for
        // finding-level decisions — finding-level UX shows finding state, not
        // case state. We still attach it to the result so callers can choose.
        if (!transitionError) {
          transitionError = toTransitionError(error);
        }
      }
    }

    // Chain the pipeline so any further auto-transitions enabled by this
    // transition can fire in the same request. Without this, a manual-track
    // approve that lands the case in `approved` stalls there even though
    // the project's lifecycle preset has `approved_to_pending_merge: 'auto'`
    // — the only auto-chain entry points were webhooks, evidence registration,
    // review completion, and the `/transition` route. Mirrors the chain
    // performed in `/api/cases/[caseId]/transition`.
    //
    // Skip for in_build — the agent is about to implement code, commit, push, and
    // create a PR. The pipeline should NOT advance until the agent posts a build_run.
    // (A request_changes decision can transition a case to in_build via
    // resolveTransitionTarget.) Mirrors the same carve-out in the /transition route.
    if (didTransition && transitionedTarget !== 'in_build') {
      try {
        const adapter = new FirestorePipelineAdapter();
        const handler = new RunCompletionHandler(adapter);
        await handler.onRunCompleted(input.case_id);
      } catch (error) {
        // Non-fatal — the primary transition already succeeded and the
        // decision is persisted. Log so stalled-case investigations can
        // see why the chain didn't advance.
        console.error(
          `[pipeline] onRunCompleted failed after decision transition (case ${input.case_id}):`,
          error,
        );
      }
    }

    return transitionError ? { decision, transition_error: transitionError } : { decision };
  }

  /**
   * Human escape hatch: sets `Case.review_not_applicable` via a documented,
   * role-gated decision instead of the pipeline's own no-diff auto-attach.
   * Recovers a case stuck in `in_review` after a permanent review-run
   * failure (e.g. a provider quota error) with no completed run and no
   * retry that can ever succeed.
   *
   * Guards (in order, each a 409-style typed error):
   *   1. Case must be `in_review`.
   *   2. No completed `review_run` may already exist for the CURRENT
   *      iteration — loopback-scoped the same way `review_run_completed`
   *      (preconditions.ts) scopes it, so a stale pre-loopback run never
   *      blocks a fresh escape-hatch request.
   *   3. `case_.review_not_applicable` must not already be true
   *      (idempotency — the flag is already set, nothing to do).
   *
   * Permission: reviewer/tech_lead/admin (see `checkReviewNotApplicablePermission`).
   * The case owner may file this if they also hold one of those roles — this
   * is an operational unblock, not an approval; downstream approval
   * anti-gaming is unaffected.
   *
   * Effect: persists the decision, sets the flag, emits `decision_created`
   * plus `review_not_applicable_marked` (the human-filed counterpart of the
   * pipeline's `review_marked_not_applicable` / `review_not_applicable_cleared`),
   * then re-runs the pipeline's auto-transition evaluation so the case
   * immediately advances to whichever of approved / needs_human_decision /
   * verification_pending its other preconditions now satisfy.
   */
  private async createReviewNotApplicableDecision(
    case_: Case,
    input: CreateDecisionInput,
    actorId: string,
    decisionSnapshot: DecisionSnapshot,
  ): Promise<CreateDecisionResult> {
    // Permission first: an unprivileged actor gets a 403 before learning
    // anything about the case's review state.
    const project = await this.getProjectForRoleCheck(case_.project_id);
    await checkReviewNotApplicablePermission(case_, actorId, project);

    if (case_.status !== 'in_review') {
      throw new ArbitraError(
        `Cannot record review_not_applicable: case ${case_.case_id} is ${case_.status}, not in_review.`,
        'REVIEW_NOT_APPLICABLE_WRONG_STATUS',
        409,
        { case_status: case_.status },
      );
    }

    if (case_.review_not_applicable) {
      throw new ArbitraError(
        `Case ${case_.case_id} is already marked review_not_applicable.`,
        'REVIEW_NOT_APPLICABLE_ALREADY_SET',
        409,
      );
    }

    const [runsSnap, eventsSnap] = await Promise.all([
      collections.runs().where('case_id', '==', case_.case_id).get(),
      collections.caseEvents().where('case_id', '==', case_.case_id).get(),
    ]);
    const events = eventsSnap.docs.map((d) => d.data() as CaseEvent);
    const boundary = mostRecentIterationBoundary(events);
    const hasCurrentIterationCompletedReviewRun = runsSnap.docs.some((d) => {
      const run = d.data() as Run;
      if (run.run_type !== 'review_run' || run.status !== 'completed') return false;
      // No loopback yet -> every run is "current" (mirrors preconditions.ts's
      // currentIterationRuns / the manual-track sugar's boundary check above).
      return boundary === null || run.created_at > boundary;
    });
    if (hasCurrentIterationCompletedReviewRun) {
      throw new ArbitraError(
        `Cannot record review_not_applicable: case ${case_.case_id} already has a completed review run for the current iteration.`,
        'REVIEW_NOT_APPLICABLE_RUN_EXISTS',
        409,
      );
    }

    const decision: Decision = {
      decision_id: generateId('decision'),
      case_id: case_.case_id,
      type: 'review_not_applicable',
      actor_id: actorId,
      rationale: input.rationale,
      snapshot: decisionSnapshot,
      created_at: new Date().toISOString(),
      ...(input.actor_metadata !== undefined && { actor_metadata: input.actor_metadata }),
    };
    await collections.decisions().doc(decision.decision_id).set(decision);

    await this.caseRepo.update(case_.case_id, { review_not_applicable: true });

    await this.eventService.emit(
      case_.case_id,
      'decision_created',
      {
        decision_id: decision.decision_id,
        type: decision.type,
        ...(decision.actor_metadata !== undefined
          ? { actor_metadata: decision.actor_metadata }
          : {}),
      },
      actorId,
    );

    await this.eventService.emit(
      case_.case_id,
      'review_not_applicable_marked',
      {
        actor_id: actorId,
        rationale_excerpt: input.rationale.slice(0, 200),
        reason: 'human_decision',
      },
      actorId,
    );

    let transitionError: CreateDecisionResult['transition_error'];
    try {
      const adapter = new FirestorePipelineAdapter();
      const handler = new RunCompletionHandler(adapter);
      await handler.onRunCompleted(case_.case_id);
    } catch (error) {
      // Non-fatal — decision + flag are already persisted; mirrors the
      // same fail-soft chain used after other case-level decisions below.
      console.error(
        `[pipeline] onRunCompleted failed after review_not_applicable decision (case ${case_.case_id}):`,
        error,
      );
      transitionError = toTransitionError(error);
    }

    return transitionError ? { decision, transition_error: transitionError } : { decision };
  }

  /**
   * Anti-gaming checks shared by both gate-confirmation paths — this method
   * and the lifecycle `pending_gate` branch in `createDecision` — since both
   * resolve the same "human gate" trust boundary, just for a different kind
   * of blocker. Previously duplicated verbatim in both branches (issue #738
   * point 4): owner self-approval prohibition, then confirmer-role check.
   */
  private async assertGateConfirmerAllowed(
    case_: Case,
    actorId: string,
    allowSelfApproval: boolean,
  ): Promise<void> {
    if (!allowSelfApproval && actorId === case_.owner_user_id) {
      throw new Error('Gate confirmation by the case owner is not allowed (anti-gaming)');
    }
    const project = await this.getProjectForRoleCheck(case_.project_id);
    const confirmerRoles = project?.lifecycle_profile?.gate_confirmer_roles ?? ['reviewer', 'tech_lead'];
    if (!this.checkConfirmerRole(actorId, project, confirmerRoles)) {
      throw new Error(`User does not have a required role (${confirmerRoles.join(', ')}) to confirm gates`);
    }
  }

  /**
   * Resolves a `gate_confirmed`/`gate_rejected` decision that targets a
   * blocked `human_confirmation` RuleResult rather than a lifecycle
   * `pending_gate`. On confirm: flips the matching blocked result(s) for
   * (case, rule) to `pass`, persists the Decision, emits a `gate_confirmed`
   * case event, and chains the pipeline so preconditions get re-evaluated
   * (the same `onRunCompleted` chain used for other case-level decisions in
   * `createDecision`). On reject: the RuleResult stays `blocked` — only the
   * rejection reason is recorded on it, and a `gate_rejected` event is
   * emitted.
   *
   * Called BEFORE the generic decision persist in `createDecision` — unlike
   * the lifecycle pending_gate branch, this method owns writing the Decision
   * itself. The Decision and every RuleResult flip it documents are written
   * in a single Firestore transaction: either all of them land, or none do.
   * Previously the Decision was persisted generically upstream and the flip
   * was a plain loop of unguarded per-result updates issued afterward — a
   * transient Firestore error on result N of M (or even an ordinary
   * validation failure, since the checks below also ran after the persist)
   * left the Decision on record for a flip that only partially happened, or
   * never happened at all (issue #738).
   *
   * The transaction also re-reads each candidate RuleResult (`tx.get`)
   * before writing, rather than blind-writing by the id list read outside
   * the transaction — this closes the concurrent-TOCTOU race: two
   * near-simultaneous `gate_confirmed` calls that both read the same blocked
   * set would, without the re-read, both commit — duplicate Decisions/events
   * for one flip. Deliberately NOT solved via the per-case pipeline lock
   * (`case-pipeline-lock.ts`): that lock is already held for the DURATION of
   * `onRunCompleted` below, which this method calls afterward, so acquiring
   * it here too would self-block on reentry. A plain Firestore transaction over the RuleResult docs
   * avoids that lock scope entirely.
   *
   * Applies `assertGateConfirmerAllowed` — the same anti-gaming checks as
   * the lifecycle pending_gate path.
   */
  private async resolveHumanConfirmationGate(
    case_: Case,
    input: CreateDecisionInput,
    actorId: string,
    allowSelfApproval: boolean,
    decisionSnapshot: DecisionSnapshot,
  ): Promise<Decision> {
    const ruleId = input.rule_id!;

    await this.assertGateConfirmerAllowed(case_, actorId, allowSelfApproval);

    const rule = await this.ruleRepository.getRuleById(ruleId).catch(() => null);
    if (!rule || rule.evaluation_mode !== 'human_confirmation') {
      throw new ArbitraError(
        `Rule ${ruleId} is not a human_confirmation rule`,
        'INVALID_GATE_RULE',
        400,
      );
    }

    const results = await this.ruleRepository.getRuleResultsByCaseAndRule(case_.case_id, ruleId);
    const blocked = results.filter((r) => r.result_status === 'blocked');
    if (blocked.length === 0) {
      throw new ArbitraError(
        `No blocked human_confirmation rule result found for rule ${ruleId} on case ${case_.case_id}`,
        'NO_BLOCKED_RULE_RESULT',
        404,
      );
    }

    const decision: Decision = {
      decision_id: generateId('decision'),
      case_id: case_.case_id,
      finding_id: input.finding_id,
      type: input.type,
      actor_id: actorId,
      rationale: input.rationale,
      snapshot: decisionSnapshot,
      created_at: new Date().toISOString(),
      rule_id: ruleId,
      // Reaching here with actorId === owner means `assertGateConfirmerAllowed`
      // above already confirmed self-approval is permitted for this cell.
      ...(actorId === case_.owner_user_id && SELF_APPROVAL_DECISION_TYPES.has(input.type)
        ? { self_approved: true }
        : {}),
      ...(input.actor_metadata !== undefined && { actor_metadata: input.actor_metadata }),
    };

    const patch: Partial<Omit<RuleResult, 'rule_result_id'>> =
      input.type === 'gate_confirmed'
        ? { result_status: 'pass', message: `Confirmed by ${actorId}: ${input.rationale}` }
        : { message: `Rejected by ${actorId}: ${input.rationale}` };

    // Persist the Decision and flip every blocked RuleResult atomically. The
    // `blocked` list above was read via a plain (non-transactional) query, so
    // it can be stale by the time this transaction runs — the transaction
    // RE-READS each candidate (`tx.get`) and only writes the ones still
    // `blocked`, rather than blind-writing the id list. This is what
    // actually closes the TOCTOU race in issue #738: Firestore's
    // optimistic-concurrency check only guards documents a transaction has
    // READ, so two concurrent `gate_confirmed` calls that both blind-wrote by
    // id (the previous shape) would both commit — duplicate Decisions/events
    // for a single flip. With the re-read, if a concurrent transaction wins
    // the race and flips a result first, Firestore retries this transaction;
    // on retry the re-read sees the already-flipped doc, `stillBlocked` drops
    // it, and if nothing is left blocked the whole thing aborts instead of
    // writing a second Decision for a gate someone else already resolved.
    await getDb().runTransaction(async (tx) => {
      const candidates = blocked.map((result) => ({
        ref: collections.ruleResults().doc(result.rule_result_id),
      }));
      const snapshots = await Promise.all(candidates.map(({ ref }) => tx.get(ref)));
      const stillBlocked = candidates.filter(
        (_, i) => snapshots[i]!.exists && snapshots[i]!.data()?.result_status === 'blocked',
      );
      if (stillBlocked.length === 0) {
        throw new ArbitraError(
          `No blocked human_confirmation rule result found for rule ${ruleId} on case ${case_.case_id}`,
          'NO_BLOCKED_RULE_RESULT',
          404,
        );
      }
      tx.set(collections.decisions().doc(decision.decision_id), decision);
      for (const { ref } of stillBlocked) {
        tx.update(ref, patch);
      }
    });

    await this.eventService.emit(
      case_.case_id,
      'decision_created',
      {
        decision_id: decision.decision_id,
        type: decision.type,
        finding_id: decision.finding_id,
        ...(decision.actor_metadata !== undefined
          ? { actor_metadata: decision.actor_metadata }
          : {}),
      },
      actorId,
    );

    if (input.type === 'gate_confirmed') {
      await this.eventService.emit(
        case_.case_id,
        'gate_confirmed',
        {
          gate_kind: 'human_confirmation_rule',
          rule_id: ruleId,
          rule_result_ids: blocked.map((r) => r.rule_result_id),
        },
        actorId,
      );

      // Chain the pipeline so any auto-transition unlocked by the now-passing
      // rule result fires in the same request (mirrors the chain below for
      // other case-level decisions).
      try {
        const adapter = new FirestorePipelineAdapter();
        const handler = new RunCompletionHandler(adapter);
        await handler.onRunCompleted(case_.case_id);
      } catch (error) {
        console.error(
          `[pipeline] onRunCompleted failed after human_confirmation gate resolution (case ${case_.case_id}):`,
          error,
        );
      }
    } else {
      await this.eventService.emit(
        case_.case_id,
        'gate_rejected',
        {
          gate_kind: 'human_confirmation_rule',
          rule_id: ruleId,
          rule_result_ids: blocked.map((r) => r.rule_result_id),
          rejected: true,
        },
        actorId,
      );
    }

    return decision;
  }

  private async getProjectForRoleCheck(projectId: string) {
    try {
      const doc = await collections.projects().doc(projectId).get();
      return doc.exists ? doc.data()! : null;
    } catch {
      return null;
    }
  }

  private checkConfirmerRole(
    actorId: string,
    project: Project | null,
    confirmerRoles: string[],
  ): boolean {
    if (!project) return false;
    // Check if user is in reviewer_pool or tech_leads based on allowed roles
    if (confirmerRoles.includes('reviewer') && project.reviewer_pool?.includes(actorId)) {
      return true;
    }
    if (confirmerRoles.includes('tech_lead') && project.tech_leads?.includes(actorId)) {
      return true;
    }
    return false;
  }

  async getDecisionsForCase(caseId: string): Promise<Decision[]> {
    const snapshot = await collections.decisions()
      .where('case_id', '==', caseId)
      .orderBy('created_at', 'desc')
      .get();
    return snapshot.docs.map((doc) => doc.data());
  }
}

/**
 * Normalize an arbitrary thrown value into the structured `transition_error`
 * payload returned to the caller. Preserves `ArbitraError.code` when present;
 * falls back to a generic `TRANSITION_FAILED` code otherwise.
 *
 * For a `TransitionError`, the bare "Invalid transition from X to Y" message
 * tells the user nothing about WHAT to do next. The error already carries the
 * unmet preconditions (each with a human-readable `reason`) in `details`; we
 * fold those into the message so both the courtroom toast and MCP callers see
 * the concrete blocker(s) — e.g. "need 2 distinct approvers, found 1" or
 * "3 unresolved high/critical findings" — instead of an opaque 409.
 */
function toTransitionError(error: unknown): NonNullable<CreateDecisionResult['transition_error']> {
  if (error instanceof ArbitraError) {
    const failed = (error.details?.failed_preconditions as FailedPrecondition[] | undefined) ?? [];
    const reasons = failed.map((p) => p.reason).filter((r): r is string => Boolean(r));
    const message = reasons.length
      ? `${error.message}. Unmet precondition${reasons.length === 1 ? '' : 's'}: ${reasons.join('; ')}.`
      : error.message;
    return { code: error.code, message };
  }
  if (error instanceof Error) {
    return { code: 'TRANSITION_FAILED', message: error.message };
  }
  return { code: 'TRANSITION_FAILED', message: String(error) };
}
