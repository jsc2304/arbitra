import { FieldValue } from 'firebase-admin/firestore';
import type { Finding, FindingStatus } from '@arbitra/shared';
import { collections, getDb } from './firestore.js';

/**
 * Statuses `rule-service.ts` / `review-service.ts` both treat as "no longer
 * blocks re-creation for this signature" (their `activeSignatures` /
 * `existingSignatures` filters exclude exactly these two before ever calling
 * `persistFinding`). Mirrored here so a doc sitting in one of these statuses
 * at the deterministic id is reactivated rather than left stuck.
 */
const TERMINAL_STATUSES: ReadonlySet<FindingStatus> = new Set(['resolved', 'fixed']);

export type PersistFindingOutcome = 'created' | 'reactivated' | 'skipped';

/**
 * Idempotently persist a Finding whose `finding_id` is a deterministic id
 * derived from its dedup signature (`deriveFindingId` in `ids.ts`).
 *
 * Two concurrent evaluation runs that compute the same signature (issue
 * #739 — `rule-service.ts` `persistConflictFindings` and `review-service.ts`
 * both used to read-then-write with a random id, so two racing runs could
 * both observe "no existing finding" and both insert a duplicate) now derive
 * the SAME `finding_id` and race on a create-only transactional write
 * instead: the loser's `tx.get` sees the doc the winner already committed
 * and no-ops. Same shape as `waiverCompletionDecisionId` /
 * `AssistantIntakeService`'s idempotency receipt (see
 * `services/orchestration/waiver-completion.ts`).
 *
 * A doc already present in a TERMINAL status (`resolved`/`fixed`) is
 * reactivated in place rather than skipped: both call sites exclude terminal
 * findings from their "already have an open finding for this signature"
 * check specifically so a conflict/defect that reappears under the same
 * signature after being resolved/fixed gets re-raised (review-service's
 * regression re-detection). Since the signature now maps to a fixed doc id,
 * that re-raise has to reopen the existing doc instead of minting a new one
 * at the same slot — every field except `finding_id`/`created_at` is
 * refreshed from the newly computed `finding` so title/description/severity
 * reflect the current observation. Because `tx.update` merges rather than
 * replaces, optional fields the fresh finding does not carry (`resolution`,
 * `knowledge_asset_ref`, `owner_ref`) are explicitly deleted so a reopened
 * finding cannot display stale links or resolution text from a prior life.
 *
 * Any other pre-existing status (`open`, or any non-terminal status) is left
 * untouched — either a concurrent run just created it (nothing to do) or an
 * upstream check already decided it's still active and shouldn't have called
 * this at all.
 */
export async function persistFinding(finding: Finding): Promise<PersistFindingOutcome> {
  const ref = collections.findings().doc(finding.finding_id);
  return getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.create(ref, finding);
      return 'created';
    }

    const existing = snap.data();
    if (existing && TERMINAL_STATUSES.has(existing.status)) {
      const { finding_id: _findingId, created_at: _createdAt, ...refreshed } = finding;
      const update: Record<string, unknown> = { ...refreshed };
      // tx.update merges: optional fields absent from the fresh finding must
      // be deleted explicitly or they survive stale from the doc's prior life.
      for (const staleOptional of ['resolution', 'knowledge_asset_ref', 'owner_ref']) {
        if (update[staleOptional] === undefined) update[staleOptional] = FieldValue.delete();
      }
      // `Transaction.update<T>`'s dotted-path overload rejects a plain
      // `UpdateData<Finding>` object here once a `FieldValue` sentinel is
      // mixed in — same friction `firestore-pipeline-adapter.ts` works around
      // by widening to `Record<string, unknown>` for the write.
      const rawRef = ref as unknown as FirebaseFirestore.DocumentReference<Record<string, unknown>>;
      tx.update(rawRef, update);
      return 'reactivated';
    }

    return 'skipped';
  });
}
