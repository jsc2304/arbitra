import type { CaseStatus, CaseType } from '../types/case.js';
import type { EventType } from '../types/event.js';

export type PreconditionId =
  | 'has_minimum_fields'
  | 'has_scope_and_track'
  | 'exploration_run_completed'
  | 'has_artifact_ref'
  | 'has_diff_and_test_strategy'
  | 'build_run_completed'
  | 'rule_runs_completed'
  | 'required_evidence_satisfied'
  | 'review_run_completed'
  | 'auto_approve_criteria_met'
  | 'has_high_critical_findings'
  | 'track_is_manual_and_no_high_critical'
  | 'track_is_direct_and_high_critical_risk'
  | 'human_approve_documented'
  | 'all_high_critical_resolved'
  | 'human_request_changes'
  | 'human_review_documented_manual_pending'
  | 'explicit_rejection'
  | 'manual_validation_confirmed'
  | 'four_eyes_if_required'
  | 'all_steps_completed'
  | 'pr_merged'
  | 'merge_not_applicable'
  | 'pr_closed_before_exploration'
  | 'assistant_run_claimed'
  | 'assistant_terminal_failure_documented'
  | 'assistant_result_evidence_present'
  | 'assistant_no_active_run'
  | 'observed_case_signal_present'
  | 'all_steps_completed_or_not_high_critical_risk';

export interface TransitionDefinition {
  from: CaseStatus | 'any';
  to: CaseStatus;
  preconditions: PreconditionId[];
  events: EventType[];
  case_types?: CaseType[];
  /** Whether this transition can be triggered automatically by the pipeline (no human action required) */
  auto_trigger?: boolean;
}

/**
 * Case types that run a shortened, isolated lifecycle slice instead of the
 * full governed engineering matrix. Exported (not just used by `isInScope`
 * below) so other seams that need the same "is this a normal, fully-governed
 * case?" test — e.g. `commit-status-service.ts`'s Enforced-Case guard
 * (issue #988) — share this single definition instead of re-deriving it.
 */
export const SCOPED_CASE_TYPES: ReadonlySet<CaseType> = new Set(['assistant_task', 'observed']);

function isInScope(t: TransitionDefinition, caseType?: CaseType): boolean {
  if (t.case_types) return caseType !== undefined && t.case_types.includes(caseType);
  return caseType === undefined || !SCOPED_CASE_TYPES.has(caseType);
}

export const TRANSITION_MATRIX: TransitionDefinition[] = [
  {
    from: 'open',
    to: 'exploration',
    preconditions: ['has_minimum_fields', 'has_scope_and_track'],
    events: ['exploration_requested'],
  },
  {
    from: 'exploration',
    to: 'ready_for_build',
    preconditions: ['exploration_run_completed'],
    events: ['exploration_completed', 'case_ready_for_build'],
    auto_trigger: true,
  },
  {
    from: 'ready_for_build',
    to: 'in_build',
    preconditions: [],
    events: ['build_started'],
  },
  {
    from: 'in_build',
    to: 'in_validation',
    preconditions: ['has_diff_and_test_strategy', 'build_run_completed', 'required_evidence_satisfied'],
    events: ['validation_requested', 'validation_started'],
    auto_trigger: true,
  },
  {
    from: 'in_validation',
    to: 'in_review',
    preconditions: ['rule_runs_completed', 'required_evidence_satisfied'],
    events: ['review_requested', 'review_started'],
    auto_trigger: true,
  },
  {
    from: 'in_validation',
    to: 'in_build',
    preconditions: ['human_request_changes'],
    events: ['human_decision_recorded', 'changes_requested'],
  },
  {
    from: 'in_review',
    to: 'approved',
    preconditions: ['review_run_completed', 'auto_approve_criteria_met'],
    events: ['auto_approve_decision', 'case_approved'],
    auto_trigger: true,
  },
  {
    from: 'in_review',
    to: 'needs_human_decision',
    preconditions: ['review_run_completed', 'has_high_critical_findings'],
    events: ['human_decision_requested'],
    auto_trigger: true,
  },
  {
    // Direct Track high/critical risk cases must always go through human decision,
    // even when the LLM review surfaced no high/critical findings — otherwise a
    // high-risk case with only low-severity issues would auto-approve without any
    // human confirmation (violating the four-eyes principle for high/critical).
    from: 'in_review',
    to: 'needs_human_decision',
    preconditions: ['review_run_completed', 'track_is_direct_and_high_critical_risk'],
    events: ['human_decision_requested'],
    auto_trigger: true,
  },
  {
    from: 'in_review',
    to: 'verification_pending',
    preconditions: ['review_run_completed', 'track_is_manual_and_no_high_critical'],
    events: ['manual_verification_requested'],
    auto_trigger: true,
  },
  {
    from: 'needs_human_decision',
    to: 'approved',
    preconditions: ['human_approve_documented', 'all_high_critical_resolved', 'required_evidence_satisfied', 'four_eyes_if_required'],
    events: ['human_decision_recorded', 'case_approved'],
  },
  {
    from: 'needs_human_decision',
    to: 'in_build',
    preconditions: ['human_request_changes'],
    events: ['human_decision_recorded', 'changes_requested'],
  },
  {
    // Belt-and-suspenders: `all_high_critical_resolved`
    // is redundant with the high/critical check now embedded in
    // `human_review_documented_manual_pending` (preconditions.ts), but keeping
    // both means a future edge/precondition edit can't silently reopen the
    // manual-track bypass that let cases reach `approved` with open
    // high/critical findings via this detour.
    from: 'needs_human_decision',
    to: 'verification_pending',
    preconditions: ['human_review_documented_manual_pending', 'all_high_critical_resolved'],
    events: ['human_decision_recorded', 'manual_verification_requested'],
  },
  {
    from: 'needs_human_decision',
    to: 'rejected',
    preconditions: ['explicit_rejection'],
    events: ['case_rejected'],
  },
  {
    // `all_high_critical_resolved` added as belt-and-suspenders alongside the
    // `human_review_documented_manual_pending` fix — see comment on the
    // `needs_human_decision → verification_pending` edge above.
    from: 'verification_pending',
    to: 'approved',
    preconditions: ['manual_validation_confirmed', 'four_eyes_if_required', 'all_high_critical_resolved'],
    events: ['manual_validation_confirmed', 'case_approved'],
  },
  {
    from: 'verification_pending',
    to: 'in_build',
    preconditions: ['human_request_changes'],
    events: ['human_decision_recorded', 'changes_requested'],
  },
  // ── Merge-not-applicable track (issue #687) ───────────────────────
  // Cases whose implementation happens outside any repository (ops
  // configuration — no diff, no PR) can never satisfy `pr_merged`.
  // When such a case is approved AND truly repo-less (no PR ref and no
  // branch), the pipeline auto-attaches a `merge_not_applicable` decision
  // (system actor) and routes straight to `done` via this transition —
  // listed BEFORE `approved → pending_merge` so it wins the auto-trigger
  // fanout when its preconditions hold. The `merge_not_applicable`
  // precondition is decision-gated and hard-fails for cases with a PR ref,
  // so the `pr_merged` gate is never weakened for real PRs.
  {
    from: 'approved',
    to: 'done',
    preconditions: ['all_steps_completed', 'merge_not_applicable'],
    events: ['merge_skipped_not_applicable', 'case_completed'],
    auto_trigger: true,
  },
  {
    from: 'approved',
    to: 'pending_merge',
    preconditions: ['all_steps_completed'],
    events: ['merge_ready'],
    auto_trigger: true,
  },
  {
    from: 'pending_merge',
    to: 'done',
    preconditions: ['pr_merged'],
    events: ['case_completed'],
    auto_trigger: true,
  },
  // Recovery path for cases already stuck in `pending_merge` with no PR
  // (issue #687): a human records a `merge_not_applicable` decision
  // (`create_decision(type='merge_not_applicable')`) and the case completes.
  // Not auto-triggered — the decision API drives this transition explicitly.
  // Kept AFTER the `pr_merged` variant so `findTransition` (single-match
  // callers like gate confirmation) keeps resolving the canonical merge
  // route first; multi-variant validation uses `findTransitions`.
  {
    from: 'pending_merge',
    to: 'done',
    preconditions: ['merge_not_applicable'],
    events: ['human_decision_recorded', 'case_completed'],
  },
  {
    from: 'pending_merge',
    to: 'rejected',
    preconditions: ['explicit_rejection'],
    events: ['case_rejected'],
  },
  {
    from: 'pending_merge',
    to: 'in_build',
    preconditions: ['human_request_changes'],
    events: ['human_decision_recorded', 'changes_requested'],
  },
  // ── Auto-close on PR merge ─────────────────────────────────────────
  // When a GitHub webhook reports a merged PR while the case is still in an
  // intermediate status (not yet at pending_merge), short-circuit directly to
  // `done`. Prevents orphan cases getting stuck at intermediate gates after
  // the PR is already merged. Anomaly / human-gated source statuses
  // (verification_pending, needs_human_decision, open, exploration,
  // ready_for_build) deliberately do NOT auto-close — the webhook service
  // emits a `case_anomaly_merge_on_gated_status` event instead.
  //
  // Issue #1000: `pr_merged` alone used to be the whole gate, which let an
  // escalated case (case_type flipped off `observed` by
  // case-escalation-service.ts, still sitting at one of these statuses with
  // no build_run and no approval documented) auto-close past every
  // evidence/review/approval requirement the moment its PR merged — the
  // default outcome for the observed→escalated path, not an edge case.
  // `all_steps_completed_or_not_high_critical_risk` (AND-combined with
  // `pr_merged`, same array-of-ids pattern the rest of this matrix uses)
  // closes that hole: a low-risk case still short-circuits exactly as
  // before, but a high/critical-risk case must have an approval decision
  // documented first or it does NOT take this shortcut — the webhook
  // service routes that case into the same `case_anomaly_merge_on_gated_status`
  // path as a human-gated source status instead.
  {
    from: 'in_build',
    to: 'done',
    preconditions: ['pr_merged', 'all_steps_completed_or_not_high_critical_risk'],
    events: ['case_auto_closed_on_merge', 'case_completed'],
    auto_trigger: true,
  },
  {
    from: 'in_validation',
    to: 'done',
    preconditions: ['pr_merged', 'all_steps_completed_or_not_high_critical_risk'],
    events: ['case_auto_closed_on_merge', 'case_completed'],
    auto_trigger: true,
  },
  {
    from: 'in_review',
    to: 'done',
    preconditions: ['pr_merged', 'all_steps_completed_or_not_high_critical_risk'],
    events: ['case_auto_closed_on_merge', 'case_completed'],
    auto_trigger: true,
  },
  {
    from: 'approved',
    to: 'done',
    preconditions: ['pr_merged', 'all_steps_completed_or_not_high_critical_risk'],
    events: ['case_auto_closed_on_merge', 'case_completed'],
    auto_trigger: true,
  },
  // Auto-reject orphan: PR opened against a freshly created `open` case is
  // closed unmerged before exploration ever started. Keeps the case from
  // sitting in `open` forever after the agent abandons the branch. Distinct
  // precondition (no explicit human decision yet) so it doesn't widen any
  // other rejection path.
  //
  // Note on bypass: this is the only `→ rejected` transition not gated by
  // `explicit_rejection`. A direct `transition_case(open, rejected)` call
  // will succeed iff `pr_closed_before_exploration` evaluates true (case in
  // `open` ∧ `pr_closed` event present ∧ no exploration-track event). That
  // is the intended behavior — the precondition itself enforces "this is an
  // abandoned-PR orphan, not a live case." The webhook's
  // `AUTO_REJECT_ORPHAN_ON_PR_CLOSED` flag gates the *automatic trigger*,
  // not the transition.
  {
    from: 'open',
    to: 'rejected',
    preconditions: ['pr_closed_before_exploration'],
    events: ['case_rejected'],
    auto_trigger: true,
  },
  // Rejection is allowed from exploration onwards (not from 'open' on the
  // explicit-rejection path — open cases are simply deleted there).
  // needs_human_decision → rejected is defined explicitly above with the same preconditions.
  {
    from: 'exploration',
    to: 'rejected',
    preconditions: ['explicit_rejection'],
    events: ['case_rejected'],
  },
  {
    from: 'ready_for_build',
    to: 'rejected',
    preconditions: ['explicit_rejection'],
    events: ['case_rejected'],
  },
  {
    from: 'in_build',
    to: 'rejected',
    preconditions: ['explicit_rejection'],
    events: ['case_rejected'],
  },
  {
    from: 'in_validation',
    to: 'rejected',
    preconditions: ['explicit_rejection'],
    events: ['case_rejected'],
  },
  {
    from: 'in_review',
    to: 'rejected',
    preconditions: ['explicit_rejection'],
    events: ['case_rejected'],
  },
  {
    from: 'in_review',
    to: 'in_build',
    preconditions: ['human_request_changes'],
    events: ['human_decision_recorded', 'changes_requested'],
  },
  {
    from: 'verification_pending',
    to: 'rejected',
    preconditions: ['explicit_rejection'],
    events: ['case_rejected'],
  },
  // ── Assistant task lifecycle ───────────────────────────────────────
  // Assistant tasks deliberately bypass the engineering lifecycle. The
  // case-type scope keeps this matrix slice isolated in both directions.
  {
    from: 'open',
    to: 'in_build',
    preconditions: ['assistant_run_claimed'],
    events: ['assistant_task_started'],
    case_types: ['assistant_task'],
    auto_trigger: true,
  },
  {
    from: 'in_build',
    to: 'done',
    preconditions: ['assistant_result_evidence_present'],
    events: ['assistant_task_completed', 'case_completed'],
    case_types: ['assistant_task'],
    auto_trigger: true,
  },
  {
    from: 'open',
    to: 'rejected',
    preconditions: ['assistant_no_active_run'],
    events: ['assistant_task_cancelled'],
    case_types: ['assistant_task'],
  },
  {
    from: 'in_build',
    to: 'rejected',
    preconditions: ['assistant_no_active_run'],
    events: ['assistant_task_cancelled'],
    case_types: ['assistant_task'],
  },
  // `needs_human_decision → rejected` (assistant_task scope) removed
  // (following PR 805): assistant tasks have no route into
  // `needs_human_decision` at all — every transition into that status is part
  // of the unscoped engineering lifecycle slice, which `isInScope` excludes
  // for `assistant_task`. The edge was dead on arrival for the cancellation
  // flow; see `AssistantCancellationService`'s `CANCELLABLE_CASE_STATUSES`.
  //
  // Terminal failure. An attempt that failed for a reason no retry can change
  // has no route to `done` and nothing a human can supply would change that,
  // so the case ends as `rejected`: honest (the task was not done), terminal
  // (it stops consuming one of the requester's active-task slots), and visible.
  // `done` would be a lie, and `needs_human_decision` is a second sink — the
  // events that would resume from it have no emitter.
  //
  // BOTH non-terminal statuses need the edge: the transition to `in_build` is
  // step 4 of the executor, and the checks before it (missing/empty/oversized
  // input, an unknown or non-member requester, the transition itself failing)
  // all fail with the case still `open`.
  //
  // Kept AFTER the `assistant_no_active_run` cancel routes so `findTransition`
  // keeps resolving cancellation as the canonical `→ rejected` route for these
  // pairs. The pipeline's auto fanout uses `getAutoTransitionsFrom` and takes the
  // first satisfied candidate, so order would otherwise decide outcomes; it does
  // not, because `assistant_terminal_failure_documented` is exclusive with
  // `assistant_result_evidence_present` via the status of the
  // one run both of them judge (`failed` vs `completed`). Retry exhaustion uses
  // this same terminal verdict; assistant tasks have no clarification/resume
  // edge because the corresponding input events never had an emitter.
  {
    from: 'open',
    to: 'rejected',
    preconditions: ['assistant_terminal_failure_documented'],
    events: ['case_rejected'],
    case_types: ['assistant_task'],
    auto_trigger: true,
  },
  {
    from: 'in_build',
    to: 'rejected',
    preconditions: ['assistant_terminal_failure_documented'],
    events: ['case_rejected'],
    case_types: ['assistant_task'],
    auto_trigger: true,
  },
  // ── Observed Case lifecycle (issue #986 / ADR-0001) ──────────────────
  // Modeled on the assistant_task slice directly above: a shortened,
  // fully auto-triggered lifecycle isolated from the engineering matrix by
  // `case_types` scoping (`SCOPED_CASE_TYPES` includes 'observed'). Observed
  // Cases are auto-created from Session Signals / PR webhooks when no case
  // is bound to a (repository, branch) pair yet (`ensureObservedCaseForSignal`)
  // — by the time this transition is evaluated the case already reflects
  // real, already-happened activity, so there is nothing further to wait on:
  // the precondition only re-asserts the case is actually in scope.
  {
    from: 'open',
    to: 'in_build',
    preconditions: ['observed_case_signal_present'],
    events: ['observed_case_started'],
    case_types: ['observed'],
    auto_trigger: true,
  },
  // `in_build → done` reuses the same `pr_merged` precondition and event
  // pair as the unscoped auto-close-on-merge transition above — this IS
  // that mechanism, just re-declared under the 'observed' scope so it stays
  // reachable once 'observed' is a SCOPED_CASE_TYPES member (an unscoped
  // transition is invisible to a scoped case_type — see `isInScope`).
  {
    from: 'in_build',
    to: 'done',
    preconditions: ['pr_merged'],
    events: ['case_auto_closed_on_merge', 'case_completed'],
    case_types: ['observed'],
    auto_trigger: true,
  },
];

export function getTransitionsFrom(
  status: CaseStatus,
  caseType?: CaseType,
): TransitionDefinition[] {
  return TRANSITION_MATRIX.filter((t) => t.from === status && isInScope(t, caseType));
}

export function getAutoTransitionsFrom(
  status: CaseStatus,
  caseType?: CaseType,
): TransitionDefinition[] {
  return TRANSITION_MATRIX.filter(
    (t) => t.from === status && t.auto_trigger === true && isInScope(t, caseType),
  );
}

export function findTransition(
  from: CaseStatus,
  to: CaseStatus,
  caseType?: CaseType,
): TransitionDefinition | undefined {
  return TRANSITION_MATRIX.find(
    (t) => t.from === from && t.to === to && isInScope(t, caseType),
  );
}

/**
 * All transition definitions for a (from, to) pair, in matrix order.
 *
 * Some pairs intentionally have multiple variants with alternative
 * precondition sets (e.g. `pending_merge → done` via `pr_merged` OR via
 * `merge_not_applicable`, `in_review → needs_human_decision` via blocking
 * findings OR via Direct-Track high/critical risk). Validation must accept
 * the transition when ANY variant's preconditions are fully satisfied —
 * use this instead of `findTransition` wherever that semantics matters.
 */
/**
 * Ordered list of statuses on the successful "happy path" from `open` to
 * `done` for a scoped case type (issue #1018) — the single source of truth
 * for any UI that needs to render a shortened lifecycle rail instead of the
 * full engineering one. Derived by breadth-first search over
 * `TRANSITION_MATRIX` rather than hardcoded, so a future edit to the
 * `observed` or `assistant_task` matrix slice (or a new scoped case type)
 * is reflected automatically without a second rail definition to keep in
 * sync.
 *
 * `rejected` is the alternate terminal and is deliberately excluded — this
 * function only ever returns the successful path. Only meaningful for
 * `SCOPED_CASE_TYPES` (currently `'assistant_task'` and `'observed'`): the
 * unscoped engineering matrix has real branch statuses (e.g.
 * `needs_human_decision`) that a plain BFS main line does not model, so
 * frontend rendering of that lifecycle keeps its own curated stage list.
 */
export function lifecycleStationsForCaseType(caseType: CaseType): CaseStatus[] {
  const queue: CaseStatus[][] = [['open']];
  const visited = new Set<CaseStatus>(['open']);

  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1]!;
    if (current === 'done') return path;

    for (const transition of getTransitionsFrom(current, caseType)) {
      if (transition.to === 'rejected') continue;
      if (visited.has(transition.to)) continue;
      visited.add(transition.to);
      queue.push([...path, transition.to]);
    }
  }

  throw new Error(
    `lifecycleStationsForCaseType: no successful 'open' → 'done' path in the transition matrix for case_type '${caseType}'.`,
  );
}

export function findTransitions(
  from: CaseStatus,
  to: CaseStatus,
  caseType?: CaseType,
): TransitionDefinition[] {
  return TRANSITION_MATRIX.filter(
    (t) => t.from === from && t.to === to && isInScope(t, caseType),
  );
}

/**
 * Case statuses that represent a completed lifecycle — no further
 * automated processing (webhooks, pipeline runs) should occur.
 */
export const TERMINAL_CASE_STATUSES: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  'done',
  'rejected',
]);
