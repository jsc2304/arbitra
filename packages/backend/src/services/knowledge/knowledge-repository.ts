import type { KnowledgeAsset } from '@arbitra/shared';
import { NotFoundError } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';

export class KnowledgeRepository {
  async create(asset: KnowledgeAsset): Promise<KnowledgeAsset> {
    await collections.knowledgeAssets().doc(asset.knowledge_id).set(asset);
    return asset;
  }

  async getById(knowledgeId: string): Promise<KnowledgeAsset> {
    const doc = await collections.knowledgeAssets().doc(knowledgeId).get();
    if (!doc.exists) throw new NotFoundError('KnowledgeAsset', knowledgeId);
    return doc.data()!;
  }

  async update(knowledgeId: string, updates: Partial<KnowledgeAsset>): Promise<KnowledgeAsset> {
    const ref = collections.knowledgeAssets().doc(knowledgeId);
    await ref.update(updates);
    const updated = await ref.get();
    return updated.data()!;
  }

  /**
   * Write-only partial update. Callers that already hold the pre-update asset
   * in memory use this to avoid an extra Firestore read after the write.
   */
  async patch(knowledgeId: string, updates: Partial<KnowledgeAsset>): Promise<void> {
    await collections.knowledgeAssets().doc(knowledgeId).update(updates);
  }

  async delete(knowledgeId: string): Promise<void> {
    await collections.knowledgeAssets().doc(knowledgeId).delete();
  }

  async listByScope(scopeType: string, scopeRef: string): Promise<KnowledgeAsset[]> {
    const snapshot = await collections.knowledgeAssets()
      .where('scope_type', '==', scopeType)
      .where('scope_ref', '==', scopeRef)
      .get();
    return snapshot.docs.map((doc) => doc.data());
  }

  async listByStatus(status: string): Promise<KnowledgeAsset[]> {
    const snapshot = await collections.knowledgeAssets()
      .where('status', '==', status)
      .get();
    return snapshot.docs.map((doc) => doc.data());
  }

  /**
   * Fetch all knowledge assets in scope for a case's review: those scoped to
   * the case's project OR its repository. Firestore has no cross-field OR that
   * spans two `scope_type`/`scope_ref` pairs, so this issues two equality
   * queries and merges the results (de-duplicated by knowledge_id). Status /
   * type / expiry filtering and ranking are applied downstream by
   * `selectReviewKnowledge` — this method only widens the candidate set.
   */
  async listForReviewScope(
    projectId: string,
    repositoryId: string,
  ): Promise<KnowledgeAsset[]> {
    const [projectAssets, repoAssets] = await Promise.all([
      this.listByScope('project', projectId),
      this.listByScope('repo', repositoryId),
    ]);
    const byId = new Map<string, KnowledgeAsset>();
    for (const asset of [...projectAssets, ...repoAssets]) {
      byId.set(asset.knowledge_id, asset);
    }
    return [...byId.values()];
  }
}
