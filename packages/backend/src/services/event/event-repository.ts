import type { CaseEvent } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';

export class EventRepository {
  /**
   * `case_events` is append-only (Spec 03): `.create()` throws ALREADY_EXISTS
   * on a duplicate `event_id` instead of silently overwriting the existing
   * audit record. Event ids are freshly generated per emit (event-service.ts
   * `generateId('event')`), so a collision here surfaces a real bug rather
   * than tolerating one.
   */
  async create(event: CaseEvent): Promise<CaseEvent> {
    await collections.caseEvents().doc(event.event_id).create(event);
    return event;
  }

  createInTransaction(
    transaction: FirebaseFirestore.Transaction,
    event: CaseEvent,
  ): void {
    const ref = collections.caseEvents().doc(event.event_id);
    transaction.create(ref, event);
  }

  async getByCaseId(caseId: string): Promise<CaseEvent[]> {
    const snapshot = await collections.caseEvents()
      .where('case_id', '==', caseId)
      .orderBy('created_at', 'asc')
      .get();

    return snapshot.docs.map((doc) => doc.data());
  }
}
