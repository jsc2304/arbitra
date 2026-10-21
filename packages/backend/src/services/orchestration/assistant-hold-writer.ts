import type { AssistantWaitReason, Case, EventType } from '@arbitra/shared';
import type { PipelineAdapter } from './pipeline-adapter.js';

/**
 * The case-side half of an assistant hold: why the lifecycle is holding, and
 * which attempt put it there. The run scope is not optional here even though
 * the field is optional on the case — every NEW hold records it, and the
 * optionality exists only for holds written before the scope did (see
 * `AssistantContext.wait_run_id`).
 */
export interface AssistantHoldWrite {
  wait_reason: AssistantWaitReason;
  run_id: string;
  attempt: number;
}

/**
 * Persist both halves of an assistant hold — the case fields and the event
 * that documents them.
 *
 * The hold preconditions require both, so a re-evaluation that observes only
 * one half either parks a case on an undocumented hold or leaves it with no
 * edge out at all. The Firestore adapter writes them in one transaction
 * (`documentAssistantHold`); the sequential fallback keeps test doubles and
 * non-Firestore adapters working, and preserves the persist-before-re-evaluate
 * ordering that matters most: the case write lands before any caller triggers
 * the pipeline.
 */
export async function writeAssistantHold(
  adapter: PipelineAdapter,
  caseId: string,
  hold: AssistantHoldWrite,
  event: { type: EventType; payload: Record<string, unknown> },
  actorId: string,
): Promise<void> {
  if (adapter.documentAssistantHold) {
    await adapter.documentAssistantHold(caseId, hold, event, actorId);
    return;
  }

  const case_ = await adapter.getCase(caseId);
  await adapter.updateCase(caseId, {
    assistant_context: {
      ...(case_.assistant_context ?? {}),
      wait_reason: hold.wait_reason,
      wait_run_id: hold.run_id,
      wait_attempt: hold.attempt,
    } as NonNullable<Case['assistant_context']>,
  });
  await adapter.emitEvent(caseId, event.type, event.payload, actorId);
}
