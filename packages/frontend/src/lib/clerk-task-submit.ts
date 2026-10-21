/**
 * Submitting one Clerk task, including the first-run case.
 *
 * Kept out of the component so the two rules that are easy to get wrong are
 * directly testable: provisioning happens only for the one error that it fixes,
 * and the retry reuses the caller's idempotency key.
 */

import type { AssistantTaskCreated } from './api-client';
import { isClerkCoreMissing } from './clerk-intake-refusal';

export interface ClerkTaskSubmitDeps {
  createTask(input: { text: string; idempotency_key: string }): Promise<AssistantTaskCreated>;
  provisionClerkCore(): Promise<unknown>;
}

/**
 * Create the task, provisioning the caller's Clerk core first if intake reports
 * it missing.
 *
 * The retry passes the SAME `idempotencyKey`. Any failure after intake's write
 * would otherwise turn one request into two cases; with the key, the second
 * attempt replays the receipt instead. Only `CLERK_CORE_NOT_PROVISIONED` is
 * retried — a limit refusal or a validation error is not made better by
 * provisioning, and retrying it would hide the reason from the user.
 */
export async function submitClerkTask(
  deps: ClerkTaskSubmitDeps,
  input: { text: string; idempotencyKey: string },
): Promise<AssistantTaskCreated> {
  const payload = { text: input.text, idempotency_key: input.idempotencyKey };
  try {
    return await deps.createTask(payload);
  } catch (error) {
    if (!isClerkCoreMissing(error)) throw error;
    await deps.provisionClerkCore();
    return deps.createTask(payload);
  }
}
