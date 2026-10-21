import { randomBytes } from 'node:crypto';
import { getDb } from '../../lib/firestore.js';

/**
 * Firestore-based single-flight lock guarding the stale-run sweep
 * (`run-sweep-service.ts`).
 *
 * Cloud Scheduler retries (and any accidental parallel POST to
 * `/api/runs/sweep`) must not run two overlapping sweeps — both would
 * snapshot the same stale-run set before either writes, and could both
 * attempt to `failRun` + retry-dispatch the same run.
 *
 * Deliberately a NEW sibling module rather than generalizing
 * `intelligence-lock.ts` — same rationale as `case-pipeline-lock.ts`: this
 * lock has its own dedicated collection/TTL/doc-id so its single-flight
 * semantics stay independent of the (also single-doc, but differently-TTL'd)
 * intelligence scheduler lock. The transaction pattern is identical.
 */

/** Dedicated collection so the lock doc never collides with business data. */
export const RUN_SWEEP_LOCKS_COLLECTION = 'run_sweep_locks';
/** Default document id — the stale-run sweep's critical section. */
export const RUN_SWEEP_LOCK_DOC_ID = 'run:sweep';
/**
 * Document id for the assistant sub-sweep's critical section. A SEPARATE key
 * rather than sharing `run:sweep`, so a long-running stale-run sweep can't
 * starve assistant recovery (an unclaimed assistant run would otherwise sit
 * unexecuted for as long as the other sweep holds the lock).
 *
 * This is not the kind of generalization the module note above rules out: that
 * concerns merging different lock SEMANTICS into one abstraction. Both sweeps
 * want the exact same single-flight semantics — same collection, same TTL, same
 * transaction — over a different critical section, which is precisely what a
 * distinct doc id is for.
 */
export const ASSISTANT_SWEEP_LOCK_DOC_ID = 'run:sweep:assistant';
/** Max time a sweep may hold the lock before it's considered crashed. Sweeps are cheap Firestore queries + updates — 2 minutes is generous. */
export const RUN_SWEEP_LOCK_TTL_MS = parseInt(
  process.env['ARBITRA_RUN_SWEEP_LOCK_TTL_MS'] ?? '120000',
  10,
);

export class RunSweepLockHeldError extends Error {
  readonly code = 'LOCK_HELD';
  constructor(message = 'run_sweep_in_progress') {
    super(message);
    this.name = 'RunSweepLockHeldError';
  }
}

export interface RunSweepLockRecord {
  acquired_at: string;
  expires_at: string;
  holder: string;
}

export interface RunSweepLockHandle {
  readonly holder: string;
  release(): Promise<void>;
}

/**
 * Attempt to acquire the sweep lock. Resolves to a handle on success; throws
 * `RunSweepLockHeldError` when another holder still owns a non-expired lock.
 *
 * The transaction writes only when the doc is absent or expired, so two
 * concurrent callers can't both win — Firestore serializes the transaction
 * commits and the loser throws LOCK_HELD.
 *
 * `lockKey` selects the critical section, defaulting to the stale-run sweep's
 * `run:sweep`. Independent sweeps that must not block each other pass their own
 * key (see `ASSISTANT_SWEEP_LOCK_DOC_ID`); contention is per-key, since each key
 * is its own lock document.
 */
export async function acquireRunSweepLock(
  now: Date = new Date(),
  ttlMs: number = RUN_SWEEP_LOCK_TTL_MS,
  lockKey: string = RUN_SWEEP_LOCK_DOC_ID,
): Promise<RunSweepLockHandle> {
  const db = getDb();
  const ref = db.collection(RUN_SWEEP_LOCKS_COLLECTION).doc(lockKey);
  const holder = randomBytes(12).toString('hex');
  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data() as RunSweepLockRecord | undefined;
      if (data && data.expires_at && data.expires_at > acquiredAt) {
        throw new RunSweepLockHeldError();
      }
    }
    const record: RunSweepLockRecord = {
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
        const data = snap.data() as RunSweepLockRecord | undefined;
        if (data && data.holder === holder) {
          tx.delete(ref);
        }
      });
    },
  };
}
