import type { Case, CaseEvent, Decision, Project, Repository } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';
import type { DetectorContext } from './detector-types.js';

const TERMINAL_STATUSES: Case['status'][] = ['done', 'rejected'];

/**
 * Pure helper: scan a descending-by-`created_at` list of events and return
 * the `created_at` of the first one whose payload indicates a transition
 * INTO the target status. Exported for unit tests; production callers go
 * through `FirestoreDetectorContext.getLatestStatusTransitionAt`.
 *
 * Accepts the historical payload shapes: `to_status` (current), plus
 * `target_status`, `status`, and `to` (legacy).
 */
export function findLatestTransitionFromEvents(
  events: Iterable<CaseEvent>,
  status: Case['status'],
): string | undefined {
  for (const ev of events) {
    const payload = ev.payload || {};
    const p = payload as {
      to_status?: string;
      target_status?: string;
      status?: string;
      to?: string;
    };
    if (
      p.to_status === status ||
      p.target_status === status ||
      p.status === status ||
      p.to === status
    ) {
      return ev.created_at;
    }
  }
  return undefined;
}

/**
 * Streams non-terminal cases out of Firestore in pages, so the scheduler
 * doesn't materialize the entire cases collection in memory.
 */
async function* streamCases(filter: 'non-terminal' | 'all'): AsyncIterable<Case> {
  const PAGE = 200;
  let cursor: FirebaseFirestore.QueryDocumentSnapshot<Case> | undefined;
  // Firestore `not-in` caps at 10 values; we only need 2. For 'all' we skip the filter.
  while (true) {
    let query = collections.activeCases().orderBy('case_id').limit(PAGE) as FirebaseFirestore.Query<Case>;
    if (filter === 'non-terminal') {
      query = query.where('status', 'not-in', TERMINAL_STATUSES);
    }
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) return;
    for (const doc of snap.docs) {
      yield doc.data();
    }
    if (snap.docs.length < PAGE) return;
    cursor = snap.docs[snap.docs.length - 1] ?? undefined;
    if (!cursor) return;
  }
}

/**
 * Real Firestore-backed DetectorContext used by the scheduled endpoint.
 * `listRemoteBranches` is left undefined by default — the orphan-branch
 * detector treats undefined as "integration not available, skip silently".
 */
export class FirestoreDetectorContext implements DetectorContext {
  readonly now: Date;

  constructor(now: Date = new Date()) {
    this.now = now;
  }

  listNonTerminalCases(): AsyncIterable<Case> {
    return streamCases('non-terminal');
  }

  listAllCases(): AsyncIterable<Case> {
    return streamCases('all');
  }

  async getLatestActivityAt(caseId: string): Promise<string | undefined> {
    // Activity = any case_event. Evidence, comments, decisions all emit events
    // (`evidence_registered`, `comment_added`, `decision_created`) so the
    // events collection is the authoritative "something happened on this case" feed.
    const snap = await collections
      .caseEvents()
      .where('case_id', '==', caseId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();
    const first = snap.docs[0];
    if (!first) return undefined;
    return first.data().created_at;
  }

  async getLatestStatusTransitionAt(caseId: string, status: Case['status']): Promise<string | undefined> {
    // Transition events carry `{ from_status, to_status }` in payload (see
    // OrchestrationService.transition). Query the target status server-side
    // via the nested-field path so a case with >100 unrelated events still
    // finds the transition. Falls back to the legacy payload shapes
    // (`target_status`, `status`, `to`) via a bounded paginated scan when the
    // dedicated `to_status` lookup returns nothing — this covers events
    // emitted before `to_status` was standardised.
    const direct = await collections
      .caseEvents()
      .where('case_id', '==', caseId)
      .where('payload.to_status', '==', status)
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();
    const directDoc = direct.docs[0];
    if (directDoc) return directDoc.data().created_at;

    // Legacy fallback — paginate instead of capping at a single page so
    // long-lived chatty cases still surface the transition.
    const PAGE = 200;
    let cursor: FirebaseFirestore.QueryDocumentSnapshot<CaseEvent> | undefined;
    while (true) {
      let query = collections
        .caseEvents()
        .where('case_id', '==', caseId)
        .orderBy('created_at', 'desc')
        .limit(PAGE) as FirebaseFirestore.Query<CaseEvent>;
      if (cursor) query = query.startAfter(cursor);
      const snap = await query.get();
      if (snap.empty) return undefined;
      const hit = findLatestTransitionFromEvents(
        snap.docs.map((d) => d.data()),
        status,
      );
      if (hit) return hit;
      if (snap.docs.length < PAGE) return undefined;
      cursor = snap.docs[snap.docs.length - 1] ?? undefined;
      if (!cursor) return undefined;
    }
  }

  async countRequestChanges(caseId: string): Promise<number> {
    // `decision_created` events carry `{ decision_type: 'request_changes' }` in
    // payload. We also accept the legacy 'decision_request_changes' event type.
    const snap = await collections
      .caseEvents()
      .where('case_id', '==', caseId)
      .get();
    let count = 0;
    for (const doc of snap.docs) {
      const ev = doc.data();
      if (ev.type === 'decision_request_changes') {
        count++;
        continue;
      }
      if (ev.type === 'decision_created') {
        const p = (ev.payload || {}) as { decision_type?: string; type?: string };
        if (p.decision_type === 'request_changes' || p.type === 'request_changes') {
          count++;
        }
      }
      if (ev.type === 'changes_requested') count++;
    }
    return count;
  }

  async getEventsForCase(caseId: string): Promise<CaseEvent[]> {
    const snap = await collections
      .caseEvents()
      .where('case_id', '==', caseId)
      .orderBy('created_at', 'asc')
      .get();
    return snap.docs.map((d) => d.data());
  }

  async getDecisionsForCase(caseId: string): Promise<Decision[]> {
    const snap = await collections
      .decisions()
      .where('case_id', '==', caseId)
      .get();
    return snap.docs.map((d) => d.data());
  }

  async listRepositories(): Promise<Repository[]> {
    const snap = await collections.repositories().get();
    return snap.docs.map((d) => d.data());
  }

  async listProjects(): Promise<Project[]> {
    const snap = await collections.projects().get();
    return snap.docs.map((d) => d.data());
  }

  async getExistingSignatures(): Promise<Set<string>> {
    // Phase 1 of the detector refactor: signatures live on
    // `cases.intelligence_flags[*].signature` (case-targeted detections) and
    // on `workspace_events.evidence.signature` for unresolved
    // `intelligence_nudge` rows (branch/project-targeted detections). Only
    // non-terminal cases / unresolved nudges count — a closed flag or
    // resolved nudge doesn't suppress a fresh detection.
    const out = new Set<string>();

    // 1. Flags on non-terminal cases.
    const caseSnap = await collections
      .cases()
      .where('status', 'not-in', TERMINAL_STATUSES)
      .get();
    for (const doc of caseSnap.docs) {
      const flags = doc.data().intelligence_flags;
      if (!Array.isArray(flags)) continue;
      for (const f of flags) {
        if (f && typeof f.signature === 'string' && f.signature) {
          out.add(f.signature);
        }
      }
    }

    // 2. Unresolved intelligence_nudge workspace_events.
    // `resolved_at` is set when an admin/tech_lead globally resolves the
    // event; absence means the nudge is still live.
    const eventSnap = await collections
      .workspaceEvents()
      .where('type', '==', 'intelligence_nudge')
      .get();
    for (const doc of eventSnap.docs) {
      const data = doc.data();
      if (data.resolved_at) continue;
      const sig = (data.evidence as Record<string, unknown> | undefined)?.signature;
      if (typeof sig === 'string' && sig) out.add(sig);
    }

    return out;
  }
}
