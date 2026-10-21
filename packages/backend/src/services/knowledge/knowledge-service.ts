import type {
  KnowledgeAsset,
  CreateKnowledgeAssetInput,
  KnowledgeStatus,
  UpdateKnowledgeAssetInput,
} from '@arbitra/shared';
import { ForbiddenError, NotFoundError } from '@arbitra/shared';
import { KnowledgeRepository } from './knowledge-repository.js';
import { EventService } from '../event/event-service.js';
import { generateId } from '../../lib/ids.js';

const PRIVILEGED_ROLES = ['tech_lead', 'admin'] as const;

/**
 * Single role-gate helper used by every KnowledgeService write path
 * (updateAsset, deleteAsset, updateStatus→verified/canonical). Callers pass the
 * actor's roles in — the service never loads the user doc itself. This
 * keeps all role checks uniform and keeps the service easy to test.
 */
function requirePrivilegedRole(actorRoles: string[], action: string): void {
  const hasRole = actorRoles.some((role) =>
    (PRIVILEGED_ROLES as readonly string[]).includes(role),
  );
  if (!hasRole) {
    throw new ForbiddenError(
      `Only tech lead or admin can ${action}`,
    );
  }
}

/**
 * The `KnowledgeAsset.type` `updateAssetAsOwner`/`deleteAssetAsOwner` are
 * restricted to. Those two methods exist for exactly one caller today — the
 * Clerk context routes (#832 slice A) — and this constant, together with
 * `assertOwnedContextAsset` below, is what keeps them from becoming a
 * generic "mutate any asset whose scope_ref happens to match" backdoor for
 * some future, unrelated caller.
 */
const OWNER_SCOPED_ASSET_TYPE = 'clerk_context';

/**
 * Asserts `asset` is both `OWNER_SCOPED_ASSET_TYPE` and scoped to exactly
 * the project the caller claims to own. Throws `NotFoundError` — never
 * `ForbiddenError` — on any mismatch, so a foreign-scope asset, a
 * wrong-type asset, and a genuinely missing asset are indistinguishable to
 * the caller (matches `api/assistant/context/[knowledgeId]/route.ts`'s
 * existing 404-for-everything-but-your-own stance; that route now relies
 * entirely on this check rather than duplicating it).
 *
 * This runs INSIDE the service, not only at whichever route calls it, so a
 * future caller of `updateAssetAsOwner`/`deleteAssetAsOwner` cannot mutate
 * an arbitrary asset by skipping — or getting wrong — its own pre-check:
 * the guarantee lives with the write, not with whoever remembers to check
 * first.
 */
function assertOwnedContextAsset(asset: KnowledgeAsset, expectedScopeRef: string): void {
  const owned =
    asset.type === OWNER_SCOPED_ASSET_TYPE
    && asset.scope_type === 'project'
    && asset.scope_ref === expectedScopeRef;
  if (!owned) {
    throw new NotFoundError('KnowledgeAsset', asset.knowledge_id);
  }
}

export class KnowledgeService {
  constructor(
    private readonly knowledgeRepo = new KnowledgeRepository(),
    private readonly eventService = new EventService(),
  ) {}

  async createAsset(
    input: CreateKnowledgeAssetInput,
    actorId: string,
  ): Promise<KnowledgeAsset> {
    const now = new Date().toISOString();

    const asset: KnowledgeAsset = {
      knowledge_id: generateId('knowledgeAsset'),
      type: input.type,
      title: input.title,
      summary: input.summary,
      body: input.body,
      scope_type: input.scope_type,
      scope_ref: input.scope_ref,
      status: 'suggested',
      version: 1,
      trust_level: 0,
      source_case_refs: input.source_case_refs ?? [],
      source_decision_refs: input.source_decision_refs ?? [],
      tags: input.tags ?? [],
      artifact_refs: [],
      created_by: actorId,
      created_at: now,
      updated_at: now,
      ...(input.expires_at ? { expires_at: input.expires_at } : {}),
      ...(input.always_inject !== undefined ? { always_inject: input.always_inject } : {}),
    };

    await this.knowledgeRepo.create(asset);

    await this.eventService.emit(
      input.source_case_refs?.[0] ?? '',
      'knowledge_asset_created',
      { knowledge_id: asset.knowledge_id, type: input.type },
      actorId,
    );

    return asset;
  }

  async updateStatus(
    knowledgeId: string,
    newStatus: KnowledgeStatus,
    actorId: string,
    actorRoles: string[],
  ): Promise<KnowledgeAsset> {
    // Review-eligible statuses require tech_lead or admin — `verified` is the
    // trust boundary where assets begin steering LLM reviews. Check BEFORE the
    // Firestore read so unauthorized callers cost zero reads.
    if (newStatus === 'verified' || newStatus === 'canonical') {
      requirePrivilegedRole(
        actorRoles,
        `set knowledge assets to ${newStatus}`,
      );
    }

    const asset = await this.knowledgeRepo.getById(knowledgeId);
    const oldStatus = asset.status;
    const updatedAt = new Date().toISOString();
    const updates = { status: newStatus, updated_at: updatedAt };

    // Single write, no post-read — merge locally from the asset we already have.
    await this.knowledgeRepo.patch(knowledgeId, updates);
    const updated: KnowledgeAsset = { ...asset, ...updates };

    // Emit event for audit
    if (asset.source_case_refs.length > 0) {
      await this.eventService.emit(
        asset.source_case_refs[0]!,
        'knowledge_asset_status_changed',
        { knowledge_id: knowledgeId, from: oldStatus, to: newStatus },
        actorId,
      );
    }

    return updated;
  }

  async updateAsset(
    knowledgeId: string,
    input: UpdateKnowledgeAssetInput,
    actorId: string,
    actorRoles: string[],
  ): Promise<KnowledgeAsset> {
    requirePrivilegedRole(actorRoles, 'edit knowledge assets');
    return this.applyAssetUpdate(knowledgeId, input, actorId);
  }

  /**
   * Update, with no privileged-role gate — `expectedScopeRef` is the
   * ownership check instead: `assertOwnedContextAsset` requires the asset
   * to be `type: 'clerk_context'` AND `scope_ref === expectedScopeRef`
   * before anything is merged or written. This is what a regular user's own
   * Clerk context edit satisfies without the generic `updateAsset` gate
   * above (`tech_lead`/`admin` only, `role-middleware.ts:12-32`) — and,
   * unlike the removed call-site-only contract this replaces, a caller
   * cannot skip the check by forgetting to run it first: it runs here,
   * against the SAME `getById` read `applyAssetUpdate` already needs, so
   * there is no extra Firestore round trip for it.
   */
  async updateAssetAsOwner(
    knowledgeId: string,
    input: UpdateKnowledgeAssetInput,
    actorId: string,
    expectedScopeRef: string,
  ): Promise<KnowledgeAsset> {
    return this.applyAssetUpdate(knowledgeId, input, actorId, expectedScopeRef);
  }

  private async applyAssetUpdate(
    knowledgeId: string,
    input: UpdateKnowledgeAssetInput,
    actorId: string,
    expectedScopeRef?: string,
  ): Promise<KnowledgeAsset> {
    const existing = await this.knowledgeRepo.getById(knowledgeId);
    // Absent only on the privileged `updateAsset` path above, which already
    // gated on role — `updateAssetAsOwner` always supplies it (required,
    // not optional, on that public signature).
    if (expectedScopeRef !== undefined) {
      assertOwnedContextAsset(existing, expectedScopeRef);
    }

    // Merge only fields that were explicitly provided (present keys)
    const updates: Partial<KnowledgeAsset> = {};
    const changedFields: string[] = [];

    if (input.title !== undefined) {
      updates.title = input.title;
      changedFields.push('title');
    }
    if (input.summary !== undefined) {
      updates.summary = input.summary;
      changedFields.push('summary');
    }
    if (input.body !== undefined) {
      updates.body = input.body;
      changedFields.push('body');
    }
    if (input.type !== undefined) {
      updates.type = input.type;
      changedFields.push('type');
    }
    if (input.scope_type !== undefined) {
      updates.scope_type = input.scope_type;
      changedFields.push('scope_type');
    }
    if (input.scope_ref !== undefined) {
      updates.scope_ref = input.scope_ref;
      changedFields.push('scope_ref');
    }
    if (input.tags !== undefined) {
      updates.tags = input.tags;
      changedFields.push('tags');
    }
    if (input.expires_at !== undefined) {
      updates.expires_at = input.expires_at;
      changedFields.push('expires_at');
    }
    if (input.always_inject !== undefined) {
      updates.always_inject = input.always_inject;
      changedFields.push('always_inject');
    }

    updates.version = existing.version + 1;
    updates.updated_at = new Date().toISOString();

    // Single write, no post-read — merge locally from `existing`.
    await this.knowledgeRepo.patch(knowledgeId, updates);
    const updated: KnowledgeAsset = { ...existing, ...updates };

    await this.eventService.emit(
      existing.source_case_refs[0] ?? '',
      'knowledge_asset_updated',
      { knowledge_id: knowledgeId, changed_fields: changedFields },
      actorId,
    );

    return updated;
  }

  async deleteAsset(
    knowledgeId: string,
    actorId: string,
    actorRoles: string[],
  ): Promise<void> {
    requirePrivilegedRole(actorRoles, 'delete knowledge assets');
    return this.removeAsset(knowledgeId, actorId);
  }

  /**
   * Delete, with no privileged-role gate. Same in-service ownership
   * assertion as `updateAssetAsOwner` — see its doc.
   */
  async deleteAssetAsOwner(
    knowledgeId: string,
    actorId: string,
    expectedScopeRef: string,
  ): Promise<void> {
    return this.removeAsset(knowledgeId, actorId, expectedScopeRef);
  }

  private async removeAsset(
    knowledgeId: string,
    actorId: string,
    expectedScopeRef?: string,
  ): Promise<void> {
    // Load first so we can scope the event to the original source case (if
    // any) — and, on the owner-scoped path, so the ownership check below
    // has the asset to check.
    const existing = await this.knowledgeRepo.getById(knowledgeId);
    if (expectedScopeRef !== undefined) {
      assertOwnedContextAsset(existing, expectedScopeRef);
    }

    await this.eventService.emit(
      existing.source_case_refs[0] ?? '',
      'knowledge_asset_deleted',
      { knowledge_id: knowledgeId, type: existing.type, title: existing.title },
      actorId,
    );

    await this.knowledgeRepo.delete(knowledgeId);
  }

  async getAsset(knowledgeId: string): Promise<KnowledgeAsset> {
    return this.knowledgeRepo.getById(knowledgeId);
  }

  async listByScope(scopeType: string, scopeRef: string): Promise<KnowledgeAsset[]> {
    return this.knowledgeRepo.listByScope(scopeType, scopeRef);
  }
}
