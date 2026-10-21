import type { CaseStatus } from '../types/case.js';
import { ArbitraError } from './arbitra-error.js';

export interface FailedPrecondition {
  id: string;
  reason: string;
}

export class TransitionError extends ArbitraError {
  constructor(
    public readonly fromStatus: CaseStatus,
    public readonly toStatus: CaseStatus,
    public readonly failedPreconditions: FailedPrecondition[],
  ) {
    const needsRejectionDecision =
      toStatus === 'rejected' &&
      failedPreconditions.some((p) => p.id === 'explicit_rejection');
    const hint = needsRejectionDecision
      ? " — to reject this case, call `create_decision(type='reject', rationale=...)` instead; direct transitions to `rejected` require a formal decision."
      : '';
    super(
      `Invalid transition from '${fromStatus}' to '${toStatus}'${hint}`,
      'INVALID_CASE_TRANSITION',
      409,
      {
        from_status: fromStatus,
        to_status: toStatus,
        failed_preconditions: failedPreconditions,
      },
    );
    this.name = 'TransitionError';
  }
}
