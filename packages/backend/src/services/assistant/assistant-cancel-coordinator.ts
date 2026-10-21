import { collections } from '../../lib/firestore.js';

/**
 * Raised only for the persisted #782 cancellation fence. Keeping a named
 * sentinel lets the loop retain its trace instead of misclassifying an abort
 * as a provider failure or a budget overrun.
 */
export class AssistantRunCancelledError extends Error {
  constructor(
    public readonly runId: string,
    public readonly revision: number,
  ) {
    super(`Assistant run ${runId} was cancelled at revision ${revision}`);
    this.name = 'AssistantRunCancelledError';
  }
}

export function isAssistantRunCancelledError(error: unknown): error is AssistantRunCancelledError {
  return error instanceof Error && error.name === 'AssistantRunCancelledError';
}

/**
 * Process-local fast path. Cloud Run instances do not share this Map, so every
 * model/tool boundary also calls `assertAssistantRunNotCancelled`, which reads
 * the durable Run fence. The local controller only shortens an already
 * in-flight call on the instance that accepted the cancellation request.
 */
const activeControllers = new Map<string, Set<AbortController>>();

export interface AssistantRunCancellationRegistration {
  readonly signal: AbortSignal;
  release(): void;
}

export function registerAssistantRunCancellation(
  runId: string,
): AssistantRunCancellationRegistration {
  const controller = new AbortController();
  const controllers = activeControllers.get(runId) ?? new Set<AbortController>();
  controllers.add(controller);
  activeControllers.set(runId, controllers);

  let released = false;
  return {
    signal: controller.signal,
    release: () => {
      if (released) return;
      released = true;
      const current = activeControllers.get(runId);
      current?.delete(controller);
      if (current?.size === 0) activeControllers.delete(runId);
    },
  };
}

export function abortAssistantRunInProcess(runId: string, revision: number): number {
  const controllers = activeControllers.get(runId);
  if (!controllers) return 0;
  const reason = new AssistantRunCancelledError(runId, revision);
  for (const controller of controllers) controller.abort(reason);
  return controllers.size;
}

/**
 * Durable boundary check. Firestore document reads are strongly consistent;
 * once the cancellation transaction commits, a later boundary cannot start a
 * new model call or read tool on another instance.
 */
export async function assertAssistantRunNotCancelled(
  runId: string,
  expectedRevision = 0,
): Promise<void> {
  const snap = await collections.runs().doc(runId).get();
  const run = snap.data();
  const revision = run?.assistant_cancel_intent?.revision ?? 0;
  if (run?.status === 'cancelled' || revision > expectedRevision) {
    throw new AssistantRunCancelledError(runId, Math.max(1, revision));
  }
}
