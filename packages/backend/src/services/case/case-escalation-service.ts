import type { Case } from '@arbitra/shared';
import { meetsEscalationThreshold } from '@arbitra/shared';
import { detectCaseFields } from '../case-detection/case-detection-service.js';
import { CompletenessEvaluator } from '../evidence/completeness-evaluator.js';
import { EventService } from '../event/event-service.js';
import { CaseRepository } from './case-repository.js';

/** System actor stamped on everything this service writes. */
const SYSTEM_ACTOR = 'system:case-escalation';

export interface EscalationSignalInput {
  /** Branch name, if different from `case_.current_branch` (rare — kept for symmetry with detectCaseFields). */
  branch?: string;
  /** Changed file paths from the PR, when available. */
  changedFiles?: string[];
  /** PR title, when available. */
  prTitle?: string;
  /** PR body/description, when available. */
  prBody?: string;
}

export interface EscalationDependencies {
  eventService?: EventService;
  caseRepo?: CaseRepository;
  completenessEvaluator?: CompletenessEvaluator;
}

export interface EscalationResult {
  /** The case as it stands after this evaluation (updated in place if anything changed). */
  case: Case;
  /** True iff this call escalated the case out of the `observed` lifecycle. */
  escalated: boolean;
  /** True iff `risk_level` changed (whether or not that triggered escalation). */
  riskChanged: boolean;
}

/**
 * Re-evaluates risk for an Observed Case against freshly available PR signal
 * (changed files, title, body) and, when the project's escalation policy
 * demands it, flips the case out of the shortened Observed lifecycle into
 * the full engineering lifecycle (issue #987 / ADR-0001).
 *
 * WHEN risk is assessed: NOT at case creation. `ensureObservedCaseForSignal`
 * (#986) only has a branch name at that point — too thin a signal to
 * classify risk (no changed files, no PR title/body). The first point real
 * signal exists is PR enrichment — `WebhookService.updateCaseWithPR`, fired
 * on `pull_request.opened`/`synchronize`/`push` — so that is the seam this
 * function is called from.
 *
 * Re-evaluation: it is safe, and intended, to call this on EVERY PR
 * enrichment event for the case's lifetime while it remains `observed`. Each
 * call re-runs `detectCaseFields` against the latest signal, so a risk level
 * that changes as more/different files land on the branch is re-assessed
 * every time — this is what satisfies "re-evaluate if risk level changes"
 * without a separate mechanism.
 *
 * Idempotent + manual-case-safe: the ONLY `case_type` this ever acts on is
 * `'observed'` (see the guard below). Once escalated, the case's `case_type`
 * is no longer `'observed'`, so a later re-evaluation call is a pure no-op —
 * escalation never runs twice, and it never runs on a case that was created
 * manually (which never had `case_type: 'observed'` to begin with).
 *
 * Escalation mechanics: on escalation this flips `case_type` from
 * `'observed'` to the case type `detectCaseFields` infers from the branch
 * (falls back to `'other'`), and updates `risk_level`/`risk_level_reason`.
 * It deliberately does NOT touch `status` — the case is already sitting at
 * whatever status the shortened lifecycle put it at (`in_build`, per the
 * `open → in_build` `observed_case_signal_present` transition). Once
 * `case_type` is no longer in `SCOPED_CASE_TYPES`
 * (`status-transitions.ts`), the case is invisible to the `observed`-scoped
 * matrix rows and visible to the unscoped engineering-lifecycle ones
 * instead — so it re-enters the SAME `in_build → in_validation → in_review →
 * …` path every other case follows, gated by the SAME preconditions
 * (`required_evidence_satisfied`, `review_run_completed`,
 * `auto_approve_criteria_met`, …). No new transition-matrix rows or
 * special-casing were needed for this — the case-type scoping mechanism
 * `status-transitions.ts` already had is the whole seam.
 */
export async function evaluateObservedCaseEscalation(
  case_: Case,
  signal: EscalationSignalInput,
  deps: EscalationDependencies = {},
): Promise<EscalationResult> {
  // Idempotency + manual-case guard: escalation only ever acts on a case
  // still in the `observed` lifecycle. An already-escalated case (any other
  // case_type) and a manually created case (never 'observed') both no-op here.
  if (case_.case_type !== 'observed') {
    return { case: case_, escalated: false, riskChanged: false };
  }

  const eventService = deps.eventService ?? new EventService();
  const caseRepo = deps.caseRepo ?? new CaseRepository();
  const completenessEvaluator = deps.completenessEvaluator ?? new CompletenessEvaluator();

  const detection = detectCaseFields({
    git_context: { branch: signal.branch ?? case_.current_branch },
    changed_files: signal.changedFiles,
    pr_title: signal.prTitle,
    pr_body: signal.prBody,
  });

  // `detectCaseFields` falls back to a `medium` GUESS (`detectRiskLevel`'s
  // "no file paths available for analysis" branch) whenever no changed-file
  // list is available — e.g. a `push` payload that never carried
  // `changed_files`. That guess is real enough to use for THIS call's
  // threshold decision (a guess of "medium" can still legitimately trigger
  // escalation), but persisting it as the case's `risk_level` on a
  // non-escalating call would silently overwrite whatever a human or an
  // earlier real-signal detection assessed — see issue #1020. Only a
  // detection actually grounded in file paths is trustworthy enough to
  // persist outside of escalation.
  const hasFileSignal = Array.isArray(signal.changedFiles) && signal.changedFiles.length > 0;

  const riskChanged = detection.risk_level !== case_.risk_level;
  const threshold = await completenessEvaluator.getEscalationThreshold(case_);
  const shouldEscalate = meetsEscalationThreshold(detection.risk_level, threshold);

  if (!shouldEscalate) {
    if (!riskChanged || !hasFileSignal) {
      // Either nothing changed, or the only thing that "changed" is an
      // ungrounded guess (no file signal) — never a silent write. No case
      // event either: nothing was decided, so there's nothing to record.
      return { case: case_, escalated: false, riskChanged: false };
    }
    const updates: Partial<Case> = {
      risk_level: detection.risk_level,
      updated_at: new Date().toISOString(),
    };
    await caseRepo.update(case_.case_id, updates);
    await eventService.emit(
      case_.case_id,
      'risk_level_changed',
      { from: case_.risk_level, to: detection.risk_level, reason: detection.risk_level_reason },
      SYSTEM_ACTOR,
    );
    return { case: { ...case_, ...updates }, escalated: false, riskChanged: true };
  }

  const updates: Partial<Case> = {
    case_type: detection.case_type,
    risk_level: detection.risk_level,
    updated_at: new Date().toISOString(),
  };
  await caseRepo.update(case_.case_id, updates);
  await eventService.emit(
    case_.case_id,
    'case_escalated',
    {
      from_case_type: 'observed',
      to_case_type: detection.case_type,
      // Issue #1029: the risk level the case had immediately before this
      // evaluation, alongside the new `risk_level` below — without it the
      // timeline shows only the destination, not the transition.
      from_risk_level: case_.risk_level,
      risk_level: detection.risk_level,
      risk_level_reason: detection.risk_level_reason,
      threshold,
      rule: `risk_level (${detection.risk_level}) >= project escalation threshold (${threshold})`,
    },
    SYSTEM_ACTOR,
  );

  return { case: { ...case_, ...updates }, escalated: true, riskChanged };
}
