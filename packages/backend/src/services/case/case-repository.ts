import type { Case, CaseFilters } from '@arbitra/shared';
import { NotFoundError } from '@arbitra/shared';
import { collections, getDb } from '../../lib/firestore.js';

export class CaseRepository {
  async create(caseData: Case): Promise<Case> {
    await collections.cases().doc(caseData.case_id).set(caseData);
    return caseData;
  }

  async getById(caseId: string, options?: { includeDeleted?: boolean }): Promise<Case> {
    const doc = await collections.cases().doc(caseId).get();
    if (!doc.exists) {
      throw new NotFoundError('Case', caseId);
    }
    const data = doc.data()!;
    if (!options?.includeDeleted && data.deleted_at) {
      throw new NotFoundError('Case', caseId);
    }
    return data;
  }

  /**
   * Soft-delete a case by setting `deleted_at` / `deleted_by`. Keeps the
   * Firestore doc so references from related collections (events, evidence,
   * comments, etc.) stay resolvable for audit purposes. `getById` and `list`
   * hide soft-deleted docs by default; pass `includeDeleted: true` to see them.
   */
  async softDelete(caseId: string, actorId: string): Promise<void> {
    const ref = collections.cases().doc(caseId);
    const doc = await ref.get();
    if (!doc.exists) {
      throw new NotFoundError('Case', caseId);
    }
    const now = new Date().toISOString();
    await ref.update({
      deleted_at: now,
      deleted_by: actorId,
      updated_at: now,
    });
  }

  async update(caseId: string, updates: Partial<Case>): Promise<Case> {
    const ref = collections.cases().doc(caseId);
    await ref.update(updates);
    const updated = await ref.get();
    if (!updated.exists) {
      throw new NotFoundError('Case', caseId);
    }
    return updated.data()!;
  }

  /**
   * Count cases whose `status` ∈ `statuses`, optionally restricted to a set of
   * accessible project IDs. Uses Firestore's `.count()` aggregation (server-
   * side, O(log N)) so it stays cheap as the `cases` collection grows.
   *
   * Firestore limits compound queries to 30 values per `in` clause, so we
   * chunk over `projectIds` when provided.
   *
   * Passing `projectIds === undefined` counts across all projects (admin path
   * or "no access restriction"). Passing `projectIds === []` returns 0.
   */
  async countByStatus(
    statuses: readonly string[],
    projectIds?: readonly string[],
  ): Promise<number> {
    if (statuses.length === 0) return 0;
    if (projectIds !== undefined && projectIds.length === 0) return 0;

    // Firestore `in` supports up to 30 values; chunk if larger.
    const STATUS_CHUNK = 30;
    const PROJECT_CHUNK = 30;

    const statusChunks: string[][] = [];
    for (let i = 0; i < statuses.length; i += STATUS_CHUNK) {
      statusChunks.push([...statuses.slice(i, i + STATUS_CHUNK)]);
    }

    const projectChunks: (string[] | undefined)[] = projectIds
      ? (() => {
          const out: string[][] = [];
          for (let i = 0; i < projectIds.length; i += PROJECT_CHUNK) {
            out.push([...projectIds.slice(i, i + PROJECT_CHUNK)]);
          }
          return out;
        })()
      : [undefined];

    let total = 0;
    for (const statusChunk of statusChunks) {
      for (const projChunk of projectChunks) {
        let query: FirebaseFirestore.Query<Case> = collections
          .cases()
          .where('deleted_at', '==', null)
          .where('status', 'in', statusChunk);
        if (projChunk) {
          query = query.where('project_id', 'in', projChunk);
        }
        const snap = await query.count().get();
        total += snap.data().count;
      }
    }
    return total;
  }

  async list(
    filters: CaseFilters & { includeDeleted?: boolean },
  ): Promise<{ cases: Case[]; cursor?: string }> {
    const limit = filters.limit ?? 20;
    let query: FirebaseFirestore.Query<Case> = collections.cases();

    if (!filters.includeDeleted) {
      query = query.where('deleted_at', '==', null);
    }

    if (filters.status) {
      query = query.where('status', '==', filters.status);
    }
    if (filters.project_id) {
      query = query.where('project_id', '==', filters.project_id);
    }
    if (filters.repository_id) {
      query = query.where('repository_id', '==', filters.repository_id);
    }
    if (filters.owner_user_id) {
      query = query.where('owner_user_id', '==', filters.owner_user_id);
    }
    if (filters.validation_track) {
      query = query.where('validation_track', '==', filters.validation_track);
    }
    if (filters.risk_level) {
      query = query.where('risk_level', '==', filters.risk_level);
    }
    if (filters.priority) {
      query = query.where('priority', '==', filters.priority);
    }
    if (filters.current_branch) {
      query = query.where('current_branch', '==', filters.current_branch);
    }

    query = query.orderBy('updated_at', 'desc');

    if (filters.cursor) {
      const cursorDoc = await collections.cases().doc(filters.cursor).get();
      if (cursorDoc.exists) {
        query = query.startAfter(cursorDoc);
      }
    }

    query = query.limit(limit + 1);

    const snapshot = await query.get();
    const cases = snapshot.docs.map((doc) => doc.data());

    let nextCursor: string | undefined;
    if (cases.length > limit) {
      const lastCase = cases.pop()!;
      nextCursor = lastCase.case_id;
    }

    return { cases, cursor: nextCursor };
  }

  async updateInTransaction(
    transaction: FirebaseFirestore.Transaction,
    caseId: string,
    updates: Partial<Case>,
  ): Promise<void> {
    const ref = collections.cases().doc(caseId);
    transaction.update(ref, updates);
  }

  async getInTransaction(
    transaction: FirebaseFirestore.Transaction,
    caseId: string,
  ): Promise<Case> {
    const ref = collections.cases().doc(caseId);
    const doc = await transaction.get(ref);
    if (!doc.exists) {
      throw new NotFoundError('Case', caseId);
    }
    return doc.data()!;
  }

  getDb() {
    return getDb();
  }
}
