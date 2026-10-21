import type { CaseStatus, CaseType } from '@arbitra/shared';
import {
  getTransitionsFrom,
  findTransitions,
  type TransitionDefinition,
} from '@arbitra/shared';
import { TransitionError, type FailedPrecondition } from '@arbitra/shared';
import type { PreconditionEvaluator } from './preconditions.js';

export class StateMachine {
  getValidTransitions(status: CaseStatus, caseType?: CaseType): TransitionDefinition[] {
    return getTransitionsFrom(status, caseType);
  }

  /**
   * Validate a (from, to) transition against the matrix. Some pairs have
   * multiple variants with alternative precondition sets (e.g.
   * `pending_merge → done` via `pr_merged` OR via `merge_not_applicable`).
   * The transition is valid when ANY variant's preconditions are fully
   * satisfied; the first satisfied variant (matrix order) is returned so
   * its `events` drive what gets emitted. When none is satisfied, the
   * TransitionError aggregates the failed preconditions across all
   * variants (deduplicated by id) so the caller sees every unmet gate.
   */
  async validateTransition(
    currentStatus: CaseStatus,
    targetStatus: CaseStatus,
    evaluator: PreconditionEvaluator,
    caseType?: CaseType,
  ): Promise<TransitionDefinition> {
    const transitions = findTransitions(currentStatus, targetStatus, caseType);

    if (transitions.length === 0) {
      throw new TransitionError(currentStatus, targetStatus, [
        { id: 'no_transition_defined', reason: `No transition defined from '${currentStatus}' to '${targetStatus}'` },
      ]);
    }

    const aggregatedFailures = new Map<string, FailedPrecondition>();

    for (const transition of transitions) {
      const failedPreconditions: FailedPrecondition[] = [];

      for (const preconditionId of transition.preconditions) {
        const result = await evaluator.evaluate(preconditionId);
        if (!result.satisfied) {
          failedPreconditions.push({
            id: preconditionId,
            reason: result.reason ?? `Precondition '${preconditionId}' not satisfied`,
          });
        }
      }

      if (failedPreconditions.length === 0) {
        return transition;
      }

      for (const failure of failedPreconditions) {
        if (!aggregatedFailures.has(failure.id)) {
          aggregatedFailures.set(failure.id, failure);
        }
      }
    }

    throw new TransitionError(currentStatus, targetStatus, [...aggregatedFailures.values()]);
  }
}
