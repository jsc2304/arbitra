/**
 * Turning an intake refusal into something the user can act on.
 *
 * `POST /api/assistant/tasks` refuses for three reasons that are NOT generic
 * failures, and each carries the facts needed to resolve it (see
 * `AssistantIntakeService.assertWithinPerUserLimits`):
 *
 *  - `active_per_user` (429) — the caller's concurrent-task slots are full, and
 *    `details.case_ids` names the cases holding them. A stuck task looks exactly
 *    like a busy one from outside, so naming them is the whole point.
 *  - `daily` (429) — the daily allowance is used up; it resets at 00:00 UTC.
 *  - `input_chars` (429) — the request is longer than the configured maximum,
 *    which the message states.
 *
 * `CLERK_CORE_NOT_PROVISIONED` (409) is deliberately absent: the caller
 * provisions and retries instead of showing it.
 */

import { ApiError } from './api-client';

export interface ClerkIntakeRefusal {
  message: string;
  /** Cases currently occupying the caller's active-task slots. */
  blockingCaseIds: string[];
}

export function describeIntakeRefusal(error: unknown): ClerkIntakeRefusal {
  if (!(error instanceof ApiError)) {
    return {
      message: error instanceof Error ? error.message : 'The request could not be submitted.',
      blockingCaseIds: [],
    };
  }

  const details = error.details ?? {};
  const limit = typeof details['limit'] === 'string' ? details['limit'] : null;

  if (limit === 'active_per_user') {
    const caseIds = Array.isArray(details['case_ids'])
      ? details['case_ids'].filter((id): id is string => typeof id === 'string')
      : [];
    return {
      message: caseIds.length > 0
        ? `${error.message} These are holding your slots:`
        : error.message,
      blockingCaseIds: caseIds,
    };
  }

  if (limit === 'daily') {
    return {
      message: `${error.message} The daily count resets at 00:00 UTC.`,
      blockingCaseIds: [],
    };
  }

  return { message: error.message, blockingCaseIds: [] };
}

/** True when the caller has no Clerk core yet — provision, then retry. */
export function isClerkCoreMissing(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'CLERK_CORE_NOT_PROVISIONED';
}
