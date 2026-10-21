import type { Evidence } from '@arbitra/shared';
import { NotFoundError } from '@arbitra/shared';
import { FieldValue } from 'firebase-admin/firestore';
import { collections } from '../../lib/firestore.js';

export class EvidenceRepository {
  async create(evidence: Evidence): Promise<Evidence> {
    await collections.evidence().doc(evidence.evidence_id).set(evidence);
    return evidence;
  }

  async getById(evidenceId: string): Promise<Evidence> {
    const doc = await collections.evidence().doc(evidenceId).get();
    if (!doc.exists) {
      throw new NotFoundError('Evidence', evidenceId);
    }
    return doc.data()!;
  }

  async getByCaseId(caseId: string): Promise<Evidence[]> {
    const snapshot = await collections.evidence()
      .where('case_id', '==', caseId)
      .orderBy('created_at', 'desc')
      .get();
    return snapshot.docs.map((doc) => doc.data());
  }

  /**
   * Look up an existing `file_edit` row for `(case_id, artifact_ref)` so
   * repeated Cursor `afterFileEdit` saves can collapse onto a single
   * evidence row instead of accumulating one per save. Returns `null`
   * when no row exists yet. Only `file_edit` is deduped — see
   * `EvidenceService.registerEvidence`.
   *
   * Requires Firestore composite index on
   * `evidence(case_id, type, artifact_ref)` — see
   * `firestore.indexes.json`.
   */
  async findFileEditByArtifact(
    caseId: string,
    artifactRef: string,
  ): Promise<Evidence | null> {
    const snapshot = await collections.evidence()
      .where('case_id', '==', caseId)
      .where('type', '==', 'file_edit')
      .where('artifact_ref', '==', artifactRef)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    return snapshot.docs[0]!.data();
  }

  /**
   * Atomically bump `edit_count` and refresh `updated_at` on an existing
   * row. Used by the file_edit dedupe path; never emits a new
   * `evidence_registered` event.
   */
  async incrementEditCount(evidenceId: string, updatedAt: string): Promise<void> {
    await collections.evidence().doc(evidenceId).update({
      edit_count: FieldValue.increment(1),
      updated_at: updatedAt,
    });
  }
}
