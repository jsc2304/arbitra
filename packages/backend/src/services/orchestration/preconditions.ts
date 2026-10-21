import type { Case, Run, Finding, RuleResult, Evidence, Decision, CaseEvent } from '@arbitra/shared';
import type { PreconditionId } from '@arbitra/shared';
import {
  isBlockingFindingStatus,
  isAuthorBlockingOrigin,
  isRefutedFinding,
  isAssistantRunType,
} from '@arbitra/shared';
import { CompletenessEvaluator } from '../evidence/completeness-evaluator.js';
import { checkFourEyes } from '../decision/four-eyes-checker.js';
import { mostRecentIterationBoundary } from './iteration-boundary.js';

export interface PreconditionResult {
  satisfied: boolean;
  reason?: string;
}

export interface PreconditionContext {
  case_: Case;
  runs: Run[];
  findings: Finding[];
  ruleResults: RuleResult[];
  evidence: Evidence[];
  decisions: Decision[];
  events: CaseEvent[];
  actorId: string;
  /**
   * Optional side-effect hook fired by the `review_run_completed` /
   * `auto_approve_criteria_met` evaluators when they detect that a case
   * is permanently un-reviewable (a `system:pipeline` comment recorded a
   * known no-diff failure) but the `review_not_applicable` flag was never
   * persisted — i.e. the case predates PR #454.
   *
   * Implementations should persist `case.review_not_applicable = true` and
   * emit a `review_marked_not_applicable` event so the heal is one-time
   * and visible in the timeline. Must be fail-soft: a Firestore hiccup
   * here MUST NOT re-block the case — the evaluator will still return
   * `{ satisfied: true }`.
   */
  onAutoHealReviewNotApplicable?: (caseId: string) => Promise<void>;
}

/**
 * Body prefixes of the `comment_added` system comments that the pipeline
 * emits when it gives up on auto-review (see pipeline.ts ~line 402 and
 * ~line 466). Anchored at the start of the body so unrelated system
 * comments (e.g. "Run ID: …") never trip the heal.
 */
const NO_DIFF_PIPELINE_COMMENT_PREFIXES = [
  'Auto-review could not start after ',
  'Auto-review skipped: no PR or branch attached',
] as const;

/**
 * True iff the case has at least one `comment_added` event from the
 * pipeline actor whose body matches one of the known no-diff failure
 * prefixes. Used as the trigger for the `review_not_applicable` auto-heal
 * for cases that hit retry-exhaustion before PR #454 added the flag.
 */
function hasNoDiffPipelineComment(events: CaseEvent[]): boolean {
  return events.some((e) => {
    if (e.type !== 'comment_added') return false;
    if (e.actor_id !== 'system:pipeline') return false;
    const body = (e.payload as { body?: unknown } | undefined)?.body;
    if (typeof body !== 'string') return false;
    return NO_DIFF_PIPELINE_COMMENT_PREFIXES.some((prefix) => body.startsWith(prefix));
  });
}

export type PreconditionFn = (ctx: PreconditionContext) => PreconditionResult | Promise<PreconditionResult>;

export interface PreconditionEvaluator {
  evaluate(id: PreconditionId): Promise<PreconditionResult>;
}

/**
 * Return only runs created after the most recent `changes_requested` event.
 * If no such event exists, all runs are considered current.
 * This prevents stale completed runs from satisfying preconditions
 * after a request_changes loop-back sends the case back to in_build.
 */
function currentIterationRuns(ctx: PreconditionContext): Run[] {
  const changesRequestedEvents = ctx.events.filter(
    (e) => e.type === 'changes_requested',
  );
  if (changesRequestedEvents.length === 0) {
    return ctx.runs;
  }
  // Find the latest changes_requested event by created_at
  const latestLoopback = changesRequestedEvents.reduce((latest, e) =>
    e.created_at > latest.created_at ? e : latest,
  );
  return ctx.runs.filter((r) => r.created_at > latestLoopback.created_at);
}

/**
 * Loopback-scoped decisions: decisions created after the most recent
 * `changes_requested` event. If no loopback has fired, all decisions are
 * current. Used by everything that should survive a phase change but reset
 * on a loopback (four-eyes counting, human-approve-documented, rejection
 * detection, etc.).
 *
 * Exported so the pipeline's `merge_not_applicable` auto-attach (issue #687)
 * can apply the exact same "current iteration" scoping as the matching
 * precondition below — attach and gate must agree on what counts as current.
 */
export function loopbackScopedDecisions(ctx: Pick<PreconditionContext, 'decisions' | 'events'>): Decision[] {
  const changesRequested = ctx.events.filter((e) => e.type === 'changes_requested');
  if (changesRequested.length === 0) {
    return ctx.decisions;
  }
  const latest = changesRequested.reduce((a, b) =>
    a.created_at > b.created_at ? a : b,
  );
  return ctx.decisions.filter((d) => d.created_at > latest.created_at);
}

/**
 * Attestation-scoped decisions: decisions created after the most recent of
 * EITHER a `changes_requested` OR a `manual_verification_requested` event —
 * see `iteration-boundary.ts`. Used only by the `manual_validation_confirmed`
 * precondition and the matching auto-attach in `decision-service.ts`.
 *
 * Why phase-scoped? `verification_pending` is the phase where Arbitra
 * explicitly asks for a manual-validation attestation. A
 * `manual_validation_confirmed` filed BEFORE the case entered that phase was
 * made under different intent and must not satisfy the precondition that
 * gates `verification_pending → approved`. Other preconditions
 * (e.g. four_eyes_if_required) deliberately do NOT reset on phase entry —
 * a prior reviewer's approve at `needs_human_decision` still counts toward
 * a two-actor four-eyes check after the case advances.
 */
function attestationScopedDecisions(ctx: PreconditionContext): Decision[] {
  const boundary = mostRecentIterationBoundary(ctx.events);
  if (boundary === null) {
    return ctx.decisions;
  }
  return ctx.decisions.filter((d) => d.created_at > boundary);
}

/**
 * Filter findings down to those that should auto-gate the case on the
 * high/critical AUTHOR path (auto-approve block, auto-escalation to
 * `needs_human_decision`, resolution requirement).
 *
 * Security / governance rationale (issue #633): a finding
 * raised against code that the author merely pulled in — a git submodule the
 * PR `git submodule add`-ed — has `origin: 'submodule'` (likewise `vendored`).
 * Such findings MUST NOT auto-escalate or block auto-approve on their own,
 * because the author did not write that defect; doing so wedged real cases
 * in `needs_human_decision` over pre-existing
 * submodule code. We do NOT hide these findings — the human reviewer still
 * sees every submodule finding in the courtroom and can act on it; they just
 * don't trip the AUTOMATIC gate.
 *
 * AUTHORED findings (origin `authored`, or — for back-compat — a missing
 * origin) are unaffected: they gate exactly as before. This keeps the gate
 * strict for the code the author actually wrote.
 *
 * Verification (issue: finding-verification-step): a finding the adversarial
 * verifier mechanically REFUTED against ground truth (`verification_status ===
 * 'refuted'`) is likewise excluded here — a proven false positive must not gate.
 * Every other verification status (confirmed / uncertain / unverified / missing)
 * keeps blocking. Filtering centrally in this one predicate means all four
 * high/critical gates (`has_high_critical_findings`, `auto_approve_criteria_met`,
 * `track_is_manual_and_no_high_critical`, `all_high_critical_resolved`) get the
 * behaviour consistently. Refuted findings remain visible/queryable — only
 * gating changes.
 */
function authorBlockingFindings(findings: Finding[]): Finding[] {
  return findings.filter(
    (f) => isAuthorBlockingOrigin(f.origin) && !isRefutedFinding(f.verification_status),
  );
}

/**
 * True iff at least one AUTHORED (non-submodule/vendored, non-refuted)
 * high/critical finding is still in a blocking status (open | accepted |
 * contested). Single source of truth for the "open high/critical" check
 * shared by `track_is_manual_and_no_high_critical` and
 * `human_review_documented_manual_pending` — both gate the manual track's
 * route into `verification_pending` and must agree on what counts as
 * blocking (a documented human review decision on an unrelated finding must
 * not open a detour around this check).
 */
function hasBlockingHighCriticalFindings(findings: Finding[]): boolean {
  return authorBlockingFindings(findings).some(
    (f) => isBlockingFindingStatus(f.status) && (f.severity === 'high' || f.severity === 'critical'),
  );
}

/**
 * True iff a completed `review_run` actually reviewed the commit currently
 * on the case (issue #1054).
 *
 * Fail-closed on both missing sides, deliberately:
 *
 * - `run.reviewed_head_sha` absent (any run created before this field
 *   existed, or a review whose diff did not come through `DiffResolver`)
 *   is treated as NOT covering the current head. A review that cannot state
 *   what commit it reviewed cannot be trusted to have reviewed the one
 *   that's there now — the whole point of this fix is that "a review
 *   happened at some point" is no longer good enough.
 * - `case_.current_head_sha` absent (the case predates the webhook that
 *   would have set it, or the pipeline never observed a commit) is ALSO
 *   treated as not covered, rather than falling back to the old
 *   any-completed-review behavior. This costs nothing that isn't already
 *   lost: `approval-pin.ts`'s `approvedCommitFor` already clears
 *   `approved_head_sha` on any transition into `approved` when
 *   `current_head_sha` is absent, and `applyApprovalCommitPin`
 *   (`commit-status-service.ts`) already fails the published
 *   `arbitra/case` check for an absent pin ("approval is not pinned to a
 *   commit — re-approve to certify this one") — so a case with no observed
 *   head cannot reach a green required check today regardless of what this
 *   function returns. Blocking it here as well just moves that failure
 *   earlier (into the precondition, before the case ever reaches
 *   `approved`) instead of leaving it to be caught downstream at
 *   status-publish time.
 *
 * IMPORTANT — this "costs nothing" argument depends on a commit status
 * being published at all, which in turn depends on the case having a PR
 * (`publishCaseCommitStatus`, `commit-status-service.ts`, returns
 * `{ published: false, reason: 'no_pr_ref' }` whenever `current_pr_ref` is
 * absent — there is no downstream red check to "move earlier" for such a
 * case). This function is therefore only safe to call directly for a
 * PR-bearing case. Callers MUST go through
 * `completedReviewSatisfiesCommitBinding` below, which applies that scoping;
 * do not call this function on its own from a precondition (issue #1054 gap 1).
 */
function reviewRunCoversCurrentHead(run: Run, case_: Case): boolean {
  if (!run.reviewed_head_sha) return false;
  if (!case_.current_head_sha) return false;
  return run.reviewed_head_sha === case_.current_head_sha;
}

/**
 * True iff `case_` has a PR reference to bind a reviewed commit against.
 *
 * The discriminator `completedReviewSatisfiesCommitBinding` uses to decide
 * whether the commit-binding requirement applies at all. Reuses the exact
 * field the `merge_not_applicable` precondition already treats as "this case
 * has a real PR" (below, `ctx.case_.current_pr_ref`) and the field
 * `publishCaseCommitStatus` (`commit-status-service.ts`) checks before
 * publishing ANY GitHub commit status for the case.
 */
function caseHasPrReference(case_: Pick<Case, 'current_pr_ref'>): boolean {
  return !!case_.current_pr_ref;
}

/**
 * True iff `completedReviewRuns` (already scoped to the current iteration by
 * the caller) satisfies the commit-binding requirement that gates
 * `review_run_completed` / `auto_approve_criteria_met` (issue #1054; #1109
 * review, finding `fnd_33656d98dc2f9ba044b0fd5281857367` — "gap 1").
 *
 * Scoped by whether `case_` has a PR reference at all:
 *
 * - PR-bearing case (`current_pr_ref` set): the binding is real and must
 *   stay strict — a PR is the only thing a GitHub commit status is ever
 *   published against (`publishCaseCommitStatus` fails closed with no PR
 *   ref), so `reviewRunCoversCurrentHead`'s fail-closed reasoning applies in
 *   full: nothing is lost by blocking here, because the case could never
 *   reach a green required check with an unreviewed commit anyway. A
 *   completed review that does not cover the current head must keep failing
 *   this gate.
 * - No-PR case (`current_pr_ref` absent — the `merge_not_applicable` class:
 *   work with no diff and no PR that will ever arrive, though a
 *   `current_branch` may still be set and reviewed via `DiffResolver`'s
 *   branch-compare strategy): that reasoning does NOT hold. No commit
 *   status is EVER published for such a case (`publishCaseCommitStatus`
 *   returns `{ published: false, reason: 'no_pr_ref' }`), so there is no
 *   downstream red check this gate would be "moving earlier" — blocking here
 *   is a pure new block, and one with no way out: the `review_not_applicable`
 *   human escape hatch (`decision-service.ts`'s
 *   `createReviewNotApplicableDecision`) refuses once ANY completed review
 *   run exists for the current iteration, regardless of commit binding
 *   (`REVIEW_NOT_APPLICABLE_RUN_EXISTS`). Without this fallback, a no-PR
 *   case whose one completed review went stale, or whose head was simply
 *   never observed by a webhook, would be stranded in `in_review`
 *   permanently. Falls back to the pre-#1054 semantics instead: any
 *   completed review_run for the current iteration satisfies the
 *   requirement.
 */
function completedReviewSatisfiesCommitBinding(completedReviewRuns: Run[], case_: Case): boolean {
  if (completedReviewRuns.length === 0) return false;
  if (!caseHasPrReference(case_)) return true;
  return completedReviewRuns.some((r) => reviewRunCoversCurrentHead(r, case_));
}

/**
 * The case's most recent assistant run, or undefined if it has none.
 *
 * Covers both assistant run types (not just `assistant_task_run`): the run
 * types that reach the hold/terminal-failure paths are exactly the ones
 * `isAssistantRunType` selects, so the scope must be able to name any of them
 * as "the attempt this hold belongs to".
 */
function latestAssistantRun(ctx: PreconditionContext): Run | undefined {
  const assistantRuns = ctx.runs.filter((run) => isAssistantRunType(run.run_type));
  if (assistantRuns.length === 0) return undefined;
  return assistantRuns.reduce((latest, run) => (run.created_at > latest.created_at ? run : latest));
}

const preconditionFns: Record<PreconditionId, PreconditionFn> = {
  has_minimum_fields: (ctx) => {
    const c = ctx.case_;
    if (!c.title || !c.project_id) {
      return { satisfied: false, reason: 'title and project_id are required' };
    }
    return { satisfied: true };
  },

  has_scope_and_track: (ctx) => {
    const c = ctx.case_;
    if (!c.validation_track || !c.risk_level) {
      return { satisfied: false, reason: 'validation_track and risk_level must be set' };
    }
    return { satisfied: true };
  },

  exploration_run_completed: (ctx) => {
    const runs = currentIterationRuns(ctx);
    const explorationRun = runs.find(
      (r) => r.run_type === 'exploration_run' && r.status === 'completed',
    );
    if (!explorationRun) {
      return { satisfied: false, reason: 'No completed exploration run found' };
    }
    return { satisfied: true };
  },

  has_artifact_ref: (ctx) => {
    // Check if there's any artifact or spec reference
    const c = ctx.case_;
    if (!c.current_branch && !c.current_pr_ref) {
      return { satisfied: false, reason: 'No branch or PR reference set' };
    }
    return { satisfied: true };
  },

  build_run_completed: (ctx) => {
    const runs = currentIterationRuns(ctx);
    const buildRuns = runs.filter((r) => r.run_type === 'build_run');
    if (buildRuns.length === 0) {
      return { satisfied: false, reason: 'No build_run completed — agent must signal build completion via POST /api/runs' };
    }
    const completed = buildRuns.some((r) => r.status === 'completed');
    if (!completed) {
      return { satisfied: false, reason: 'Build run not yet completed' };
    }
    return { satisfied: true };
  },

  has_diff_and_test_strategy: (ctx) => {
    const c = ctx.case_;
    if (!c.current_branch && !c.current_pr_ref) {
      return { satisfied: false, reason: 'No diff/commit reference found' };
    }
    return { satisfied: true };
  },

  rule_runs_completed: (ctx) => {
    const runs = currentIterationRuns(ctx);
    const ruleRuns = runs.filter((r) => r.run_type === 'rule_run');
    if (ruleRuns.length === 0) {
      return { satisfied: true }; // No rules configured = pass
    }
    const allDone = ruleRuns.every(
      (r) => r.status === 'completed' || r.status === 'failed',
    );
    if (!allDone) {
      return { satisfied: false, reason: 'Not all rule runs have completed' };
    }
    return { satisfied: true };
  },

  required_evidence_satisfied: async (ctx) => {
    // Use CompletenessEvaluator for project-aware policy lookup
    // (checks project-specific policy first, falls back to defaults)
    const evaluator = new CompletenessEvaluator();
    const result = await evaluator.evaluate(ctx.case_, ctx.evidence);
    if (!result.satisfied) {
      return {
        satisfied: false,
        reason: result.missing.length > 0
          ? `Missing required evidence: ${result.missing.join(', ')}`
          : 'Evidence requirements not satisfied',
      };
    }
    return { satisfied: true };
  },

  review_run_completed: async (ctx) => {
    // Bypass: if the pipeline marked the case as not eligible for auto-review
    // (e.g. no PR/branch, or 3× diff-fetch failure), an actual review_run is
    // not required. The system has already documented why no review ran via
    // a system comment; do not block approval here.
    if (ctx.case_.review_not_applicable) {
      return { satisfied: true, reason: 'review_not_applicable' };
    }
    const runs = currentIterationRuns(ctx);
    const completedReviewRuns = runs.filter(
      (r) => r.run_type === 'review_run' && r.status === 'completed',
    );
    if (completedReviewSatisfiesCommitBinding(completedReviewRuns, ctx.case_)) {
      return { satisfied: true };
    }
    // A completed review_run exists for this iteration, but none of them
    // reviewed the commit currently on the case — the trivial-commit bypass
    // (issue #1054): push a throwaway commit, get it cleanly reviewed, then
    // push the real change before approval. Do NOT fall through to the
    // auto-heal below — that heal is for "no review ran at all" (a genuine
    // no-diff-source case), not "a review ran but it's stale". (Only reached
    // for a PR-bearing case — `completedReviewSatisfiesCommitBinding` already
    // returned `true` above for a no-PR case with any completed review.)
    if (completedReviewRuns.length > 0) {
      return {
        satisfied: false,
        reason: 'The completed review does not cover the current commit — a fresh review is required before approval',
      };
    }
    // Auto-heal: cases that hit retry-exhaustion before PR #454 shipped have
    // a pipeline-failure comment but no `review_not_applicable` flag. Detect
    // the comment, treat the precondition as satisfied, and lazily persist
    // the flag so subsequent evaluations short-circuit on the bypass above.
    if (hasNoDiffPipelineComment(ctx.events)) {
      if (ctx.onAutoHealReviewNotApplicable) {
        try {
          await ctx.onAutoHealReviewNotApplicable(ctx.case_.case_id);
        } catch (err) {
          // Fail-soft — never re-block the case on a write hiccup.
          console.warn(
            `[preconditions] Auto-heal persist failed for ${ctx.case_.case_id}:`,
            err,
          );
        }
      }
      return { satisfied: true, reason: 'review_not_applicable_auto_healed' };
    }
    return { satisfied: false, reason: 'No completed LLM review run — at least one review is required before approval (or the pipeline must mark review_not_applicable)' };
  },

  auto_approve_criteria_met: async (ctx) => {
    // High/critical risk cases must never auto-approve — spec requires a second
    // human confirmation regardless of track or finding severity. The matching
    // transition `in_review → needs_human_decision` (track_is_direct_and_high_critical_risk)
    // routes such cases into the human-decision path instead.
    const risk = ctx.case_.risk_level;
    if (risk === 'high' || risk === 'critical') {
      return { satisfied: false, reason: 'Auto-approve not allowed for high/critical risk — human decision required' };
    }

    // Track whether the review-run sub-clause was satisfied via the
    // `review_not_applicable` bypass so we can surface that as the final
    // `reason` (telemetry / phase rendering distinguishes a true-because-
    // bypassed result from a true-because-all-criteria-passed result).
    // Initialized `false` and set only inside the actual bypass/heal
    // fall-through branch below — NOT from the case flag at init. A stale
    // `review_not_applicable` flag coexisting with a completed current-iteration
    // review_run must report the normal-approval reason, not the bypass reason.
    let bypassedViaReviewNotApplicable = false;

    // 0. At least one completed review_run is mandatory (current iteration only),
    //    unless the pipeline marked the case as review_not_applicable (e.g.
    //    no PR/branch, or 3× diff-fetch failure). Mirrors `review_run_completed`:
    //    auto-heal pre-#454 cases on the fly when a no-diff pipeline comment
    //    exists so we don't permanently block them.
    const runs = currentIterationRuns(ctx);
    const completedReviewRuns = runs.filter(
      (r) => r.run_type === 'review_run' && r.status === 'completed',
    );
    const hasCompletedReview = completedReviewSatisfiesCommitBinding(completedReviewRuns, ctx.case_);
    if (ctx.case_.review_not_applicable) {
      // The case flag bypasses the mandatory-review requirement. But if a real
      // completed review_run already exists for the current iteration, the
      // review-run sub-clause is satisfied by that real review — NOT by the
      // bypass — so we leave `bypassedViaReviewNotApplicable` false and report
      // the normal-approval reason. The bypass reason is reserved for the true
      // no-review case (stale-flag/race guard, see #632).
      if (!hasCompletedReview) {
        bypassedViaReviewNotApplicable = true;
      }
    } else if (!hasCompletedReview) {
      // A completed review_run may still exist here — it just doesn't cover
      // the current commit (issue #1054's trivial-commit bypass). That is
      // NOT the same situation the auto-heal below exists for (no review at
      // all, e.g. no diff source ever resolved), so it must not fall
      // through to the heal — a fresh, commit-matching review is required.
      // (Only reached for a PR-bearing case — `completedReviewSatisfiesCommitBinding`
      // already returned `true` above for a no-PR case with any completed review.)
      if (completedReviewRuns.length > 0) {
        return {
          satisfied: false,
          reason: 'The completed review does not cover the current commit — cannot auto-approve without a fresh review',
        };
      }
      if (hasNoDiffPipelineComment(ctx.events)) {
        if (ctx.onAutoHealReviewNotApplicable) {
          try {
            await ctx.onAutoHealReviewNotApplicable(ctx.case_.case_id);
          } catch (err) {
            console.warn(
              `[preconditions] Auto-heal persist failed for ${ctx.case_.case_id}:`,
              err,
            );
          }
        }
        // Fall through — review-run sub-clause is satisfied via heal.
        bypassedViaReviewNotApplicable = true;
      } else {
        return { satisfied: false, reason: 'No completed LLM review run — cannot auto-approve without review' };
      }
    }

    // 1. No still-blocking AUTHORED findings with severity high/critical.
    // Uses the shared `isBlockingFindingStatus` (open | accepted | contested)
    // rather than a bare `=== 'open'` so a contested/accepted authored
    // high/critical finding keeps blocking auto-approve — matching
    // `all_high_critical_resolved`, the `DecisionService` guard, and the
    // frontend `isBlocking` (issue #648). Submodule/vendored-origin findings
    // are excluded (see `authorBlockingFindings`): a `git submodule add` must
    // not block auto-approve on pre-existing code the author didn't write.
    const highCriticalOpen = authorBlockingFindings(ctx.findings).filter(
      (f) => isBlockingFindingStatus(f.status) && (f.severity === 'high' || f.severity === 'critical'),
    );
    if (highCriticalOpen.length > 0) {
      return { satisfied: false, reason: `${highCriticalOpen.length} open high/critical findings` };
    }

    // 2. All rule results = pass or not_applicable
    const failedRules = ctx.ruleResults.filter(
      (r) => r.result_status !== 'pass' && r.result_status !== 'not_applicable',
    );
    if (failedRules.length > 0) {
      return { satisfied: false, reason: `${failedRules.length} rule results not passing` };
    }

    // 3. No unconfirmed rule_override_conflict findings
    const unconfirmedOverrides = ctx.findings.filter(
      (f) => f.category === 'rule_override_conflict' && f.status === 'open',
    );
    if (unconfirmedOverrides.length > 0) {
      return { satisfied: false, reason: 'Unconfirmed rule override conflicts exist' };
    }

    // 4. No severity_contested findings
    const contestedFindings = ctx.findings.filter(
      (f) => f.severity_contested && f.status === 'open',
    );
    if (contestedFindings.length > 0) {
      return { satisfied: false, reason: 'Severity-contested findings exist' };
    }

    // 5. validation_track != manual OR manual validation confirmed (current iteration)
    if (ctx.case_.validation_track === 'manual') {
      const currentDecisions = loopbackScopedDecisions(ctx);
      const manualConfirmed = currentDecisions.some(
        (d) => d.type === 'manual_validation_confirmed',
      );
      if (!manualConfirmed) {
        return { satisfied: false, reason: 'Manual validation not yet confirmed' };
      }
    }

    if (bypassedViaReviewNotApplicable) {
      return { satisfied: true, reason: 'review_not_applicable' };
    }
    return { satisfied: true };
  },

  has_high_critical_findings: (ctx) => {
    // Drives the auto-escalation `in_review → needs_human_decision`. Count only
    // AUTHORED high/critical findings — a case that merely `git submodule add`s
    // code must not auto-escalate on pre-existing submodule findings the author
    // didn't write (issue #633). Submodule findings remain
    // visible to the human reviewer; they just don't auto-escalate.
    // Uses the shared `isBlockingFindingStatus` (open | accepted | contested),
    // not a bare `=== 'open'`, so a contested/accepted authored high/critical
    // finding still escalates rather than silently dropping out (issue #648).
    const highCritical = authorBlockingFindings(ctx.findings).filter(
      (f) => isBlockingFindingStatus(f.status) && (f.severity === 'high' || f.severity === 'critical'),
    );
    if (highCritical.length === 0) {
      return { satisfied: false, reason: 'No high/critical findings present' };
    }
    return { satisfied: true };
  },

  track_is_manual_and_no_high_critical: (ctx) => {
    if (ctx.case_.validation_track !== 'manual') {
      return { satisfied: false, reason: 'Case is not on manual track' };
    }
    // Only AUTHORED high/critical findings block the manual-track route to
    // verification_pending. Submodule/vendored findings do not (see #633):
    // mirrors `has_high_critical_findings` so the two `in_review` exits stay
    // consistent — a submodule-add manual-track case should proceed to manual
    // verification rather than auto-escalate on pre-existing submodule code.
    // Uses the shared `isBlockingFindingStatus` (open | accepted | contested),
    // not a bare `=== 'open'`, so a contested/accepted authored high/critical
    // finding still blocks this gate (issue #648).
    if (hasBlockingHighCriticalFindings(ctx.findings)) {
      return { satisfied: false, reason: 'Open high/critical findings exist' };
    }
    return { satisfied: true };
  },

  track_is_direct_and_high_critical_risk: (ctx) => {
    // Used by the `in_review → needs_human_decision` fallback transition so that
    // Direct Track high/critical risk cases always land in the human-decision
    // path even when the LLM reviewer produced no high/critical findings.
    if (ctx.case_.validation_track !== 'direct') {
      return { satisfied: false, reason: 'Case is not on direct track' };
    }
    const risk = ctx.case_.risk_level;
    if (risk !== 'high' && risk !== 'critical') {
      return { satisfied: false, reason: 'Case is not high/critical risk' };
    }
    return { satisfied: true };
  },

  human_approve_documented: (ctx) => {
    const decisions = loopbackScopedDecisions(ctx);
    const approveDecision = decisions.find((d) => d.type === 'approve');
    if (!approveDecision) {
      return { satisfied: false, reason: 'No human approve decision documented' };
    }
    return { satisfied: true };
  },

  all_high_critical_resolved: (ctx) => {
    // Gates `needs_human_decision → approved`. Require only AUTHORED high/critical
    // findings to be resolved — a human who reaches this gate should not be
    // forced to resolve pre-existing submodule/vendored findings the author
    // didn't write (issue #633). Those findings stay visible in the courtroom;
    // the human can still address them, but they don't block the approval gate.
    const unresolvedHighCritical = authorBlockingFindings(ctx.findings).filter(
      (f) =>
        (f.severity === 'high' || f.severity === 'critical') &&
        isBlockingFindingStatus(f.status),
    );
    if (unresolvedHighCritical.length > 0) {
      return { satisfied: false, reason: `${unresolvedHighCritical.length} unresolved high/critical findings` };
    }
    return { satisfied: true };
  },

  human_request_changes: (ctx) => {
    const decisions = loopbackScopedDecisions(ctx);
    const requestChanges = decisions.find((d) => d.type === 'request_changes');
    if (!requestChanges) {
      return { satisfied: false, reason: 'No request_changes decision documented' };
    }
    return { satisfied: true };
  },

  human_review_documented_manual_pending: (ctx) => {
    if (ctx.case_.validation_track !== 'manual') {
      return { satisfied: false, reason: 'Case is not on manual track' };
    }
    // Security fix: a manual-track case with an
    // open AUTHOR-blocking high/critical finding must not reach
    // `verification_pending` via this human-decision detour. Previously this
    // precondition only checked that SOME review decision existed — a
    // finding-level `approve` on any (even unrelated) finding satisfied it,
    // letting `verification_pending → approved` (gated only by
    // `manual_validation_confirmed` + `four_eyes_if_required`) skip the
    // high/critical gate entirely. Reuses the exact predicate that already
    // gates the auto-triggered `in_review → verification_pending` edge
    // (`track_is_manual_and_no_high_critical`) so both routes into
    // `verification_pending` agree on what "no open high/critical" means.
    if (hasBlockingHighCriticalFindings(ctx.findings)) {
      return { satisfied: false, reason: 'Open high/critical findings exist — cannot proceed to manual verification' };
    }
    const decisions = loopbackScopedDecisions(ctx);
    const hasReviewDecision = decisions.some(
      (d) => d.type === 'approve' || d.type === 'request_changes',
    );
    if (!hasReviewDecision) {
      return { satisfied: false, reason: 'No human review decision documented' };
    }
    return { satisfied: true };
  },

  explicit_rejection: (ctx) => {
    const decisions = loopbackScopedDecisions(ctx);
    const rejectDecision = decisions.find((d) => d.type === 'reject');
    if (!rejectDecision) {
      return { satisfied: false, reason: 'No explicit rejection decision' };
    }
    return { satisfied: true };
  },

  manual_validation_confirmed: (ctx) => {
    // Phase-scoped: requires a fresh attestation since entering verification_pending,
    // not a stale one from in_review. See `attestationScopedDecisions`.
    const decisions = attestationScopedDecisions(ctx);
    const confirmed = decisions.find(
      (d) => d.type === 'manual_validation_confirmed',
    );
    if (!confirmed) {
      return { satisfied: false, reason: 'Manual validation not yet confirmed' };
    }
    return { satisfied: true };
  },

  four_eyes_if_required: async (ctx) => {
    // Use only decisions from the current iteration so stale approvals
    // from before a request_changes loopback don't satisfy four-eyes.
    // Resolve the project's evidence-policy flags (four_eyes_required,
    // allow_self_approval) for this case's (risk, track) cell and feed
    // them into the canonical four-eyes checker. Previously this ignored
    // the policy and hardcoded "required for high/critical only", which
    // blocked cases on projects that had explicitly disabled four-eyes.
    const decisions = loopbackScopedDecisions(ctx);
    let policy: { four_eyes_required: boolean; allow_self_approval: boolean };
    try {
      const evaluator = new CompletenessEvaluator();
      const rule = await evaluator.getEffectivePolicyRule(ctx.case_);
      policy = {
        four_eyes_required: rule.four_eyes_required,
        allow_self_approval: rule.allow_self_approval,
      };
    } catch {
      // Fail-safe: if policy resolution breaks (e.g. Firestore hiccup),
      // default to strict four-eyes so we never silently open a hole.
      policy = { four_eyes_required: true, allow_self_approval: false };
    }
    const result = checkFourEyes(ctx.case_, decisions, policy);
    return result.satisfied
      ? { satisfied: true }
      : { satisfied: false, reason: result.reason };
  },

  all_steps_completed: (ctx) => {
    // For approved -> pending_merge: verify all mandatory steps are documented (current iteration)
    const decisions = loopbackScopedDecisions(ctx);
    const hasDecision = decisions.some(
      (d) =>
        d.type === 'approve' ||
        d.type === 'auto_approve' ||
        d.type === 'manual_validation_confirmed',
    );
    if (!hasDecision) {
      return { satisfied: false, reason: 'No approval decision found' };
    }
    return { satisfied: true };
  },

  all_steps_completed_or_not_high_critical_risk: (ctx) => {
    // Issue #1000: gates the four unscoped `in_build|in_validation|in_review|
    // approved -> done` auto-close-on-merge shortcuts (AND-combined with
    // `pr_merged` in status-transitions.ts) so a merged PR cannot bypass
    // evidence/review/approval for an escalated or otherwise high/critical-
    // risk case — that fast path exists as a convenience for Observed Cases
    // and low-risk work, not as a way past the governed gates.
    //
    // Deliberately the INVERSE risk polarity of
    // `track_is_direct_and_high_critical_risk` above (which is satisfied
    // when risk IS high/critical AND the track IS direct) and, unlike that
    // function, does NOT restrict to `validation_track === 'direct'`: an
    // escalated case's track can be anything —
    // case-escalation-service.ts's escalation path only ever flips
    // `case_type` (off `observed`) and `risk_level`, never
    // `validation_track`. Restricting to Direct Track here would let a
    // Manual Track escalated case sail straight through.
    //
    // A low/medium-risk case (the vast majority of Observed Cases and
    // low-risk manual work) is satisfied unconditionally — today's
    // behavior is unchanged for it. A high/critical-risk case additionally
    // needs `all_steps_completed` (an approve / auto_approve /
    // manual_validation_confirmed decision already documented) — reused
    // as-is, not duplicated, so the two gates can never drift apart.
    const risk = ctx.case_.risk_level;
    if (risk !== 'high' && risk !== 'critical') {
      return { satisfied: true };
    }
    return preconditionFns.all_steps_completed(ctx);
  },

  pr_merged: (ctx) => {
    // For pending_merge -> done: PR must have been merged (triggered by GitHub webhook)
    const merged = ctx.events.some((e) => e.type === 'pr_merged');
    if (!merged) {
      return { satisfied: false, reason: 'PR has not been merged yet' };
    }
    return { satisfied: true };
  },

  merge_not_applicable: (ctx) => {
    // Merge-not-applicable track (issue #687): completes a case whose
    // implementation lives outside any repository (ops configuration — no
    // diff, no PR will ever arrive).
    //
    // Hard guard: a case WITH a PR reference must go through the `pr_merged`
    // gate — this precondition is NOT a bypass for real PRs. A recorded
    // branch alone does not block (the human may know the branch is a
    // sentinel or abandoned), but the explicit decision below is required.
    if (ctx.case_.current_pr_ref) {
      return {
        satisfied: false,
        reason: 'Case has a PR reference — the pr_merged gate applies; merge_not_applicable cannot bypass a real PR',
      };
    }
    // Loopback-scoped: a merge_not_applicable from before the most recent
    // `changes_requested` loopback does not count — the new iteration may
    // well produce a PR. Mirrors the scoping of the pipeline auto-attach.
    const decisions = loopbackScopedDecisions(ctx);
    const candidates = decisions.filter((d) => d.type === 'merge_not_applicable');
    if (candidates.length === 0) {
      return {
        satisfied: false,
        reason: 'No merge_not_applicable decision recorded — record one via create_decision to complete a case without a PR',
      };
    }
    // Crash-window guard: a SYSTEM-attached decision (`system:pipeline`)
    // asserted "no PR ref AND no branch" at attach time — that is the
    // auto-skip discriminator. If the auto-transition crashed after the
    // attach and a branch was recorded later, the stale system decision
    // must NOT satisfy the gate: the PR may still arrive via webhook
    // branch-matching. Human-recorded decisions stay branch-tolerant —
    // they are the intended recovery path for sentinel/abandoned branches.
    const valid = candidates.some(
      (d) => d.actor_id !== 'system:pipeline' || !ctx.case_.current_branch,
    );
    if (!valid) {
      return {
        satisfied: false,
        reason: 'Auto-attached merge_not_applicable is stale — a branch was recorded after attach; record an explicit merge_not_applicable decision if the branch will never produce a PR',
      };
    }
    return { satisfied: true };
  },

  pr_closed_before_exploration: (ctx) => {
    // Auto-reject orphan: PR closed unmerged while the case is still in `open`
    // and exploration never started. Satisfied iff:
    //   1. case status is currently `open`,
    //   2. at least one `pr_closed` event exists,
    //   3. no exploration-track lifecycle event has fired yet
    //      (exploration_requested / exploration_completed / case_ready_for_build).
    // We deliberately do NOT also require `pr_merged` to be absent — a closed
    // PR is the trigger; merged PRs in `open` are caught by the anomaly path
    // upstream and never reach this transition.
    if (ctx.case_.status !== 'open') {
      return { satisfied: false, reason: 'Case is not in open status' };
    }
    const hasPrClosed = ctx.events.some((e) => e.type === 'pr_closed');
    if (!hasPrClosed) {
      return { satisfied: false, reason: 'No pr_closed event recorded' };
    }
    const explorationStarted = ctx.events.some(
      (e) =>
        e.type === 'exploration_requested'
        || e.type === 'exploration_completed'
        || e.type === 'case_ready_for_build',
    );
    if (explorationStarted) {
      return { satisfied: false, reason: 'Exploration already started' };
    }
    return { satisfied: true };
  },

  /**
   * Intentionally unsatisfiable until the unclaimed-run claim path exists.
   * POST /api/runs creates and immediately completes non-review runs, and no
   * API currently persists `running` for a new run type. The claim/dispatch
   * path is a separate, later change.
   */
  assistant_run_claimed: (ctx) => {
    const claimed = ctx.runs.some(
      (run) => run.run_type === 'assistant_task_run' && run.status === 'running',
    );
    if (!claimed) {
      return { satisfied: false, reason: 'No running assistant_task_run found' };
    }
    return { satisfied: true };
  },

  /**
   * The case's latest assistant attempt failed for a reason no retry can
   * change, and that verdict is recorded on both the case and the timeline.
   *
   * Three requirements, all needed:
   *  - the terminal wait reason on the case (written only by
   *    `RunCompletionHandler.documentAssistantTerminalFailure`),
   *  - the hold scoped to the case's most recent assistant run, and that run
   *    actually being `failed` — otherwise a stale verdict from an earlier
   *    attempt would reject a case that is currently working,
   *  - an `assistant_task_abandoned` event naming the same run, so the reason
   *    a case ended as `rejected` is readable from the timeline rather than
   *    only from a run document.
   */
  assistant_terminal_failure_documented: (ctx) => {
    const assistant = ctx.case_.assistant_context;
    if (assistant?.wait_reason !== 'failed_permanently') {
      return { satisfied: false, reason: 'No terminal assistant failure is documented on the case' };
    }
    const latest = latestAssistantRun(ctx);
    if (!latest) {
      return { satisfied: false, reason: 'Case has no assistant run to attribute the terminal failure to' };
    }
    if (assistant.wait_run_id !== latest.run_id) {
      return {
        satisfied: false,
        reason: `Terminal failure documents assistant run ${assistant.wait_run_id ?? 'unknown'}, which is not the most recent one (${latest.run_id})`,
      };
    }
    if (latest.status !== 'failed') {
      return {
        satisfied: false,
        reason: `Most recent assistant run ${latest.run_id} is ${latest.status}, not failed`,
      };
    }
    const documented = ctx.events.some(
      (event) => event.type === 'assistant_task_abandoned'
        && (event.payload as { run_id?: unknown }).run_id === latest.run_id,
    );
    if (!documented) {
      return {
        satisfied: false,
        reason: `No assistant_task_abandoned event documents assistant run ${latest.run_id}`,
      };
    }
    return { satisfied: true };
  },

  /**
   * The case's latest assistant attempt produced a result.
   *
   * Scoped over the same runs as `assistant_terminal_failure_documented`
   * (`latestAssistantRun`, i.e. both assistant run types) rather than over
   * `assistant_task_run` alone. Both edges out of `in_build` are `auto_trigger`
   * and `tryAutoTransition` takes the first satisfied candidate, so two
   * different notions of "the latest attempt" would let a completed task run
   * plus a newer failed action run satisfy `done` AND `rejected` at once, with
   * matrix order silently deciding the outcome. One run, one status, one edge.
   */
  assistant_result_evidence_present: (ctx) => {
    const latestRun = latestAssistantRun(ctx);
    if (!latestRun) {
      return { satisfied: false, reason: 'No assistant run found' };
    }
    if (latestRun.status !== 'completed') {
      return {
        satisfied: false,
        reason: `Most recent assistant run ${latestRun.run_id} is ${latestRun.status}, not completed`,
      };
    }

    const resultEvidence = ctx.evidence.some(
      (evidence) => evidence.type === 'task_result'
        && evidence.run_id === latestRun.run_id
        && typeof evidence.artifact_ref === 'string'
        && evidence.artifact_ref.trim().length > 0,
    );
    if (!resultEvidence) {
      return {
        satisfied: false,
        reason: `No task_result evidence linked to assistant run ${latestRun.run_id} with an artifact reference found`,
      };
    }
    return { satisfied: true };
  },

  assistant_no_active_run: (ctx) => {
    const activeRun = ctx.runs.some(
      (run) => run.status === 'pending' || run.status === 'running',
    );
    if (activeRun) {
      return { satisfied: false, reason: 'An assistant run is still pending or running' };
    }
    return { satisfied: true };
  },

  /**
   * `open → in_build` for the `observed` case-type slice (issue #986).
   *
   * `ensureObservedCaseForSignal` only ever creates a case AFTER the
   * activity it records already happened (a session signal or PR arrived
   * for a branch with no case) — unlike the assistant slice, there is no
   * separate "run got claimed" moment to wait for. This precondition is
   * therefore a scope re-assertion, not a wait condition: it is only ever
   * evaluated for a case in scope (`case_types: ['observed']` on the
   * transition), so it exists to make the lifecycle self-documenting and to
   * fail loudly rather than silently if the matrix or scoping is ever
   * mis-edited such that this precondition gets evaluated for a case whose
   * `case_type` is not actually `'observed'`.
   */
  observed_case_signal_present: (ctx) => {
    if (ctx.case_.case_type !== 'observed') {
      return { satisfied: false, reason: 'Case is not an Observed Case' };
    }
    return { satisfied: true };
  },
};

export function createPreconditionEvaluator(ctx: PreconditionContext): PreconditionEvaluator {
  return {
    async evaluate(id: PreconditionId): Promise<PreconditionResult> {
      const fn = preconditionFns[id];
      if (!fn) {
        return { satisfied: false, reason: `Unknown precondition: ${id}` };
      }
      return await fn(ctx);
    },
  };
}
