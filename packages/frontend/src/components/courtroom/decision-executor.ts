/**
 * Submission orchestration for the courtroom decision cluster. Owns the
 * post-API path (toasting, transition_error handling, KnowledgeCapturePrompt
 * trigger) so it can be unit-tested without a DOM.
 *
 * Pure-ish: takes the api client + side-effect callbacks as deps, returns an
 * async function the caller invokes.
 */

import type { CaseStatus, DecisionType } from '@arbitra/shared';
import type { BlockerCounts } from '../../lib/finding-selectors';
import { getDecisionOptions } from './decision-options';

export interface DecisionExecutorInput {
  type: DecisionType;
  rationale: string;
  finding_id: string | undefined;
}

export type DecisionExecutorResult =
  | { ok: true }
  | { ok: false; message: string };

export interface DecisionResponse {
  decision_id: string;
  transition_error?: { message: string } | null;
}

export interface DecisionExecutorDeps {
  caseId: string;
  caseStatus: CaseStatus | undefined;
  blockerCounts: BlockerCounts;
  submitDecision: (
    caseId: string,
    body: { case_id: string; type: DecisionType; rationale: string; finding_id?: string },
  ) => Promise<DecisionResponse>;
  addToast: (
    type: 'success' | 'error' | 'info',
    message: string,
    description?: string,
  ) => void;
  onSuccess: (args: {
    decisionId: string;
    decisionType: DecisionType;
    rationale: string;
  }) => void;
}

/**
 * Builds the orchestrator invoked by RationaleForm's `onExecute`.
 *
 * Behavior (locked by tests in `decision-executor.test.tsx`):
 *
 *   - Calls `submitDecision`. On error → returns `{ ok: false, message }`
 *     and emits an `error` toast with the same message.
 *   - On success without `transition_error` → emits a `success` toast with
 *     the option's user-facing label.
 *   - On success WITH `transition_error`:
 *       - If the decision was an approve while
 *         caseStatus === 'needs_human_decision' AND there are open blockers,
 *         the toast description copy is the PR #475 blocking-findings copy
 *         ("Resolve or waive N blocking finding(s)…").
 *       - Otherwise, the description falls back to the server message +
 *         the audit-trail explainer.
 *   - Always fires `onSuccess` (the KnowledgeCapturePrompt trigger) on a
 *     2xx response — `transition_error` is a soft failure, not an
 *     orchestration abort.
 */
export function createDecisionExecutor(deps: DecisionExecutorDeps) {
  const { caseId, caseStatus, blockerCounts, submitDecision, addToast, onSuccess } = deps;

  return async function execute(
    input: DecisionExecutorInput,
  ): Promise<DecisionExecutorResult> {
    try {
      const decision = await submitDecision(caseId, {
        case_id: caseId,
        type: input.type,
        rationale: input.rationale,
        finding_id: input.finding_id,
      });

      const options = getDecisionOptions(caseStatus, Boolean(input.finding_id));
      const submittedLabel =
        options.find((o) => o.value === input.type)?.label ?? input.type;

      if (decision.transition_error) {
        const isBlockingApprove =
          input.type === 'approve' &&
          caseStatus === 'needs_human_decision' &&
          blockerCounts.total > 0;
        const description = isBlockingApprove
          ? `Resolve or waive ${blockerCounts.total} blocking finding${
              blockerCounts.total === 1 ? '' : 's'
            } (${blockerCounts.critical} critical, ${blockerCounts.high} high) before approving.`
          : `${decision.transition_error.message} The decision is in the audit trail; the case stays in its current status until the precondition is met.`;
        addToast(
          'info',
          `Decision "${submittedLabel}" recorded but case status did not change`,
          description,
        );
      } else {
        addToast('success', `Decision "${submittedLabel}" submitted successfully`);
      }

      onSuccess({
        decisionId: decision.decision_id,
        decisionType: input.type,
        rationale: input.rationale,
      });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to submit decision';
      addToast('error', message);
      return { ok: false, message };
    }
  };
}
