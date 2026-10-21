import { randomBytes } from 'node:crypto';
import { getDb } from '../../lib/firestore.js';

/**
 * Firestore-based per-case lock guarding the pipeline's auto-transition
 * read-evaluate-write cycle (`RunCompletionHandler.onRunCompleted` /
 * `tryAutoTransition` in `pipeline.ts`).
 *
 * `onRunCompleted` is triggered from ~15 call sites (webhooks, evidence,
 * review/decision services, run-executor) mostly fire-and-forget. Two
 * near-simultaneous completions for the SAME case can both read the case +
 * precondition context before either writes, both pass preconditions, and
 * both execute a transition — duplicate `auto_approve` decisions/events, or
 * a divergent target status with last-write-wins on `status`. This lock
 * serializes the evaluate-and-transition cycle per `case_id` so only one
 * evaluation runs at a time; a caller that loses the race no-ops cleanly
 * instead of racing the winner.
 *
 * Deliberately a NEW sibling module rather than generalizing
 * `intelligence-lock.ts` — that lock guards a single well-known scheduler
 * critical section (single-flight, one document); this one is keyed per
 * case and acquired far more frequently, so keeping them separate avoids
 * coupling the scheduler's single-flight semantics to per-case contention.
 * The TTL-reclaim transaction pattern is otherwise identical.
 */

/** Dedicated collection so the lock doc never collides with business data. */
export const CASE_PIPELINE_LOCKS_COLLECTION = 'case_pipeline_locks';
/** Max time a caller may hold the lock before it's considered crashed/stuck. */
export const CASE_PIPELINE_LOCK_TTL_MS = parseInt(
  process.env['ARBITRA_CASE_PIPELINE_LOCK_TTL_MS'] ?? '60000',
  10,
);

export function casePipelineLockDocId(caseId: string): string {
  return `run:pipeline:${caseId}`;
}

export class CasePipelineLockHeldError extends Error {
  readonly code = 'LOCK_HELD';
  constructor(message = 'case_pipeline_evaluation_in_progress') {
    super(message);
    this.name = 'CasePipelineLockHeldError';
  }
}

export interface CasePipelineLockRecord {
  acquired_at: string;
  expires_at: string;
  holder: string;
}

export interface CasePipelineLockHandle {
  readonly holder: string;
  release(): Promise<void>;
}

/**
 * Attempt to acquire the pipeline lock for `caseId`. Resolves to a handle on
 * success; throws `CasePipelineLockHeldError` when another holder still owns
 * a non-expired lock for this case.
 *
 * The transaction writes only when the doc is absent or expired, so two
 * concurrent callers can't both win — Firestore serializes the transaction
 * commits and the loser throws LOCK_HELD.
 */
export async function acquireCasePipelineLock(
  caseId: string,
  now: Date = new Date(),
  ttlMs: number = CASE_PIPELINE_LOCK_TTL_MS,
): Promise<CasePipelineLockHandle> {
  const db = getDb();
  const ref = db.collection(CASE_PIPELINE_LOCKS_COLLECTION).doc(casePipelineLockDocId(caseId));
  const holder = randomBytes(12).toString('hex');
  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data() as CasePipelineLockRecord | undefined;
      if (data && data.expires_at && data.expires_at > acquiredAt) {
        throw new CasePipelineLockHeldError();
      }
    }
    const record: CasePipelineLockRecord = {
      acquired_at: acquiredAt,
      expires_at: expiresAt,
      holder,
    };
    tx.set(ref, record);
  });

  return {
    holder,
    async release() {
      // Only delete if we're still the holder — avoids stomping a successor
      // who reclaimed an expired lock while we were running.
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const data = snap.data() as CasePipelineLockRecord | undefined;
        if (data && data.holder === holder) {
          tx.delete(ref);
        }
      });
    },
  };
}
