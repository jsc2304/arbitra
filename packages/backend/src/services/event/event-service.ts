import type { CaseEvent, EventType } from '@arbitra/shared';
import { EventRepository } from './event-repository.js';
import { generateId } from '../../lib/ids.js';
import { EventNotifier } from '../notification/event-notifier.js';

export class EventService {
  private readonly notifier: EventNotifier;

  constructor(
    private readonly eventRepo = new EventRepository(),
    notifier?: EventNotifier,
  ) {
    this.notifier = notifier ?? new EventNotifier();
  }

  async emit(
    caseId: string,
    type: EventType,
    payload: Record<string, unknown>,
    actorId: string,
  ): Promise<CaseEvent> {
    const event: CaseEvent = {
      event_id: generateId('event'),
      case_id: caseId,
      type,
      actor_id: actorId,
      payload,
      created_at: new Date().toISOString(),
    };

    const created = await this.eventRepo.create(event);

    // Fire-and-forget: create notifications for relevant users
    this.notifier.onCaseEvent(caseId, type, payload, actorId).catch((err) => {
      console.warn(`[EventService] Notification failed for ${type} on ${caseId}:`, err);
    });

    return created;
  }

  /**
   * Stage one event write inside `transaction`. Deliberately does NOT
   * notify — a transaction can still abort after this call returns, and a
   * notification for a rolled-back transaction would be a lie. Callers that
   * own the enclosing `runTransaction` must collect the returned `CaseEvent`s
   * and pass them to `notifyCommitted` themselves, AFTER `runTransaction`
   * resolves. See `notifyCommitted` for why that split exists.
   */
  async emitInTransaction(
    transaction: FirebaseFirestore.Transaction,
    caseId: string,
    type: EventType,
    payload: Record<string, unknown>,
    actorId: string,
  ): Promise<CaseEvent> {
    const event: CaseEvent = {
      event_id: generateId('event'),
      case_id: caseId,
      type,
      actor_id: actorId,
      payload,
      created_at: new Date().toISOString(),
    };

    this.eventRepo.createInTransaction(transaction, event);
    return event;
  }

  /**
   * Fire the SAME notifier hook `emit()` uses (fire-and-forget, failures
   * logged not thrown), for events already staged via `emitInTransaction`.
   *
   * Exists to close the transactional bypass: `emitInTransaction` cannot
   * notify inline because Firestore transactions can still abort after it
   * returns, so nothing notified for a transactional event at all — a
   * silent class of never-notifying events (`case_completed`, `case_approved`,
   * `assistant_task_completed`, …) whenever they were emitted via a
   * transition inside `runTransaction` rather than the plain `emit()` path.
   *
   * Callers must call this ONLY after their enclosing `runTransaction` has
   * resolved successfully — mirroring the existing post-commit side-effect
   * pattern (`OrchestrationService.transition`'s waiver cleanup after its own
   * `runTransaction` call). An aborted transaction must never reach here.
   */
  notifyCommitted(events: CaseEvent[]): void {
    for (const event of events) {
      this.notifier.onCaseEvent(event.case_id, event.type, event.payload, event.actor_id).catch((err) => {
        console.warn(`[EventService] Post-commit notification failed for ${event.type} on ${event.case_id}:`, err);
      });
    }
  }

  async getHistory(caseId: string): Promise<CaseEvent[]> {
    return this.eventRepo.getByCaseId(caseId);
  }
}
