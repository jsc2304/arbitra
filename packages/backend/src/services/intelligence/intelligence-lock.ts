import { randomBytes } from 'node:crypto';
import { getDb } from '../../lib/firestore.js';

/**
 * Firestore-based lock guarding concurrent intelligence runs.
 *
 * Cloud Scheduler retries (and any accidental parallel POST) must not spawn
 * two overlapping IntelligenceService.run() invocations — both would snapshot
 * `existingSignatures` before either writes, and every detection would get
 * duplicated.
 *
 * The lock is a single Firestore document written inside a transaction. TTL
 * (`expires_at`) protects against a crashed run leaving the lock dangling:
 * if `now > expires_at` the next acquirer reclaims it.
 */

/** Dedicated collection so the lock doc never collides with business data. */
export const INTELLIGENCE_LOCKS_COLLECTION = 'intelligence_locks';
/** Single well-known document id — the scheduler has only one critical section. */
export const INTELLIGENCE_RUN_LOCK_DOC_ID = 'run:intelligence';
/** Max time a run may hold the lock before it's considered crashed. */
export const INTELLIGENCE_LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class IntelligenceLockHeldError extends Error {
  readonly code = 'LOCK_HELD';
  constructor(message = 'intelligence_run_in_progress') {
    super(message);
    this.name = 'IntelligenceLockHeldError';
  }
}

export interface IntelligenceLockRecord {
  acquired_at: string;
  expires_at: string;
  holder: string;
}

export interface IntelligenceLockHandle {
  readonly holder: string;
  release(): Promise<void>;
}

/**
 * Attempt to acquire the run lock. Resolves to a handle on success; throws
 * `IntelligenceLockHeldError` when another holder still owns a non-expired lock.
 *
 * The transaction writes only when the doc is absent or expired, so two
 * concurrent callers can't both win — Firestore serializes the transaction
 * commits and the loser either throws LOCK_HELD or retries into the new state.
 */
export async function acquireIntelligenceRunLock(
  now: Date = new Date(),
  ttlMs: number = INTELLIGENCE_LOCK_TTL_MS,
): Promise<IntelligenceLockHandle> {
  const db = getDb();
  const ref = db.collection(INTELLIGENCE_LOCKS_COLLECTION).doc(INTELLIGENCE_RUN_LOCK_DOC_ID);
  const holder = randomBytes(12).toString('hex');
  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data() as IntelligenceLockRecord | undefined;
      if (data && data.expires_at && data.expires_at > acquiredAt) {
        throw new IntelligenceLockHeldError();
      }
    }
    const record: IntelligenceLockRecord = {
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
        const data = snap.data() as IntelligenceLockRecord | undefined;
        if (data && data.holder === holder) {
          tx.delete(ref);
        }
      });
    },
  };
}
