import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError, NotFoundError } from '@arbitra/shared';
import type { KnowledgeAsset } from '@arbitra/shared';

// The service no longer touches ../../lib/firestore.js directly — all role
// checks flow through the shared in-service helper with actorRoles passed in
// from the route layer. The stub is kept as a safety net in case an
// unrelated import pulls firestore.ts transitively.
vi.mock('../../lib/firestore.js', () => ({
  collections: {
    users: () => ({
      doc: () => ({ get: vi.fn().mockResolvedValue({ exists: false }) }),
    }),
  },
}));

// Stub id generator so assertions are deterministic
vi.mock('../../lib/ids.js', () => ({
  generateId: (prefix: string) => `${prefix}_test`,
}));

import { KnowledgeService } from './knowledge-service.js';
import type { KnowledgeRepository } from './knowledge-repository.js';
import type { EventService } from '../event/event-service.js';

function makeAsset(overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  return {
    knowledge_id: 'know_test',
    type: 'precedent',
    title: 'Existing asset',
    summary: 'Existing summary',
    body: 'Existing body',
    scope_type: 'global',
    scope_ref: 'global',
    status: 'suggested',
    version: 3,
    trust_level: 0,
    source_case_refs: ['case_src'],
    source_decision_refs: [],
    tags: ['old'],
    artifact_refs: [],
    created_by: 'usr_author',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

interface MockRepo {
  getById: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  listByScope: ReturnType<typeof vi.fn>;
  listByStatus: ReturnType<typeof vi.fn>;
}

interface MockEvents {
  emit: ReturnType<typeof vi.fn>;
}

function makeMocks(initialAsset: KnowledgeAsset): {
  repo: MockRepo;
  events: MockEvents;
  service: KnowledgeService;
} {
  const repo: MockRepo = {
    getById: vi.fn(async () => initialAsset),
    update: vi.fn(async (_id: string, updates: Partial<KnowledgeAsset>) => ({
      ...initialAsset,
      ...updates,
    })),
    patch: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    create: vi.fn(async (a: KnowledgeAsset) => a),
    listByScope: vi.fn(async () => []),
    listByStatus: vi.fn(async () => []),
  };
  const events: MockEvents = { emit: vi.fn(async () => ({})) };
  const service = new KnowledgeService(
    repo as unknown as KnowledgeRepository,
    events as unknown as EventService,
  );
  return { repo, events, service };
}

describe('KnowledgeService.updateAsset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists only the fields explicitly provided', async () => {
    const existing = makeAsset();
    const { repo, service } = makeMocks(existing);

    await service.updateAsset(
      'know_test',
      { title: 'New title', tags: ['new'] },
      'usr_editor',
      ['tech_lead'],
    );

    // Consolidated-read path: exactly one read (getById) and one write (patch),
    // no post-update re-read via repo.update.
    expect(repo.getById).toHaveBeenCalledTimes(1);
    expect(repo.patch).toHaveBeenCalledTimes(1);
    expect(repo.update).not.toHaveBeenCalled();

    const [, updates] = repo.patch.mock.calls[0]!;
    // Provided fields must appear
    expect(updates.title).toBe('New title');
    expect(updates.tags).toEqual(['new']);
    // Non-provided fields must NOT appear
    expect(updates).not.toHaveProperty('summary');
    expect(updates).not.toHaveProperty('body');
    expect(updates).not.toHaveProperty('scope_type');
    // Version bump + updated_at always set
    expect(updates.version).toBe(existing.version + 1);
    expect(updates.updated_at).toEqual(expect.any(String));
  });

  it('returns the merged asset without issuing a second Firestore read', async () => {
    const existing = makeAsset();
    const { repo, service } = makeMocks(existing);

    const result = await service.updateAsset(
      'know_test',
      { title: 'Merged title' },
      'usr_editor',
      ['admin'],
    );

    expect(repo.getById).toHaveBeenCalledTimes(1);
    expect(result.title).toBe('Merged title');
    // Untouched fields come from the in-memory `existing` asset
    expect(result.summary).toBe(existing.summary);
    expect(result.scope_type).toBe(existing.scope_type);
    expect(result.version).toBe(existing.version + 1);
  });

  it('emits knowledge_asset_updated with changed_fields', async () => {
    const existing = makeAsset();
    const { events, service } = makeMocks(existing);

    await service.updateAsset(
      'know_test',
      { title: 'Changed', summary: 'Changed' },
      'usr_editor',
      ['admin'],
    );

    expect(events.emit).toHaveBeenCalledTimes(1);
    const [scopeCaseId, type, payload, actorId] = events.emit.mock.calls[0]!;
    expect(scopeCaseId).toBe('case_src');
    expect(type).toBe('knowledge_asset_updated');
    expect(actorId).toBe('usr_editor');
    expect(payload.knowledge_id).toBe('know_test');
    expect(payload.changed_fields).toEqual(['title', 'summary']);
  });

  it('throws ForbiddenError when actor lacks tech_lead or admin', async () => {
    const { service, repo } = makeMocks(makeAsset());

    await expect(
      service.updateAsset(
        'know_test',
        { title: 'x' },
        'usr_dev',
        ['developer', 'reviewer'],
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.patch).not.toHaveBeenCalled();
    // Role check runs before any Firestore read
    expect(repo.getById).not.toHaveBeenCalled();
  });

  it('accepts tech_lead role', async () => {
    const { service } = makeMocks(makeAsset());
    await expect(
      service.updateAsset('know_test', { title: 'x' }, 'usr_tl', ['tech_lead']),
    ).resolves.toBeDefined();
  });

  it('accepts admin role', async () => {
    const { service } = makeMocks(makeAsset());
    await expect(
      service.updateAsset('know_test', { title: 'x' }, 'usr_admin', ['admin']),
    ).resolves.toBeDefined();
  });
});

describe('KnowledgeService.deleteAsset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws ForbiddenError for non-privileged actor', async () => {
    const { service, repo, events } = makeMocks(makeAsset());

    await expect(
      service.deleteAsset('know_test', 'usr_dev', ['developer']),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(repo.delete).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('emits knowledge_asset_deleted and deletes the asset', async () => {
    const existing = makeAsset();
    const { service, repo, events } = makeMocks(existing);

    await service.deleteAsset('know_test', 'usr_tl', ['tech_lead']);

    // Event emitted with source_case_refs[0] as scope
    expect(events.emit).toHaveBeenCalledTimes(1);
    const [scopeCaseId, type, payload, actorId] = events.emit.mock.calls[0]!;
    expect(scopeCaseId).toBe('case_src');
    expect(type).toBe('knowledge_asset_deleted');
    expect(actorId).toBe('usr_tl');
    expect(payload.knowledge_id).toBe('know_test');

    // Repo delete called after event
    expect(repo.delete).toHaveBeenCalledWith('know_test');
  });

  it('uses empty scope when source_case_refs is empty', async () => {
    const { service, events } = makeMocks(
      makeAsset({ source_case_refs: [] }),
    );

    await service.deleteAsset('know_test', 'usr_admin', ['admin']);

    const [scopeCaseId] = events.emit.mock.calls[0]!;
    expect(scopeCaseId).toBe('');
  });
});

/**
 * The owner-scoped variants #832 slice A adds: same merge/emit behaviour as
 * `updateAsset`/`deleteAsset`, minus the `tech_lead`/`admin` gate —
 * `expectedScopeRef` is the ownership check instead, asserted INSIDE the
 * service (`assertOwnedContextAsset`) against the same `getById` read the
 * merge already needs. Fixtures below are `scope_type: 'project'` because
 * that assertion requires it — `makeAsset()`'s own default
 * (`scope_type: 'global'`) would never pass it.
 */
const OWN_PROJECT_ID = 'proj_clerk_owner';

function makeOwnedContextAsset(overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  return makeAsset({
    type: 'clerk_context' as never,
    scope_type: 'project',
    scope_ref: OWN_PROJECT_ID,
    ...overrides,
  });
}

describe('KnowledgeService.updateAssetAsOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists a merge identical to updateAsset, with no role check, when the scope matches', async () => {
    // Reverted line: reintroducing `requirePrivilegedRole` inside
    // `updateAssetAsOwner` (or inside the shared `applyAssetUpdate` it now
    // calls) makes this fail — a plain owner, with no roles at all, would
    // be rejected with ForbiddenError instead of succeeding.
    const existing = makeOwnedContextAsset();
    const { repo, service } = makeMocks(existing);

    const result = await service.updateAssetAsOwner(
      'know_test',
      { title: 'New title', always_inject: true },
      'usr_owner',
      OWN_PROJECT_ID,
    );

    expect(repo.getById).toHaveBeenCalledTimes(1);
    expect(repo.patch).toHaveBeenCalledTimes(1);
    const [, updates] = repo.patch.mock.calls[0]!;
    expect(updates.title).toBe('New title');
    expect(updates.always_inject).toBe(true);
    expect(updates.version).toBe(existing.version + 1);
    expect(result.title).toBe('New title');
  });

  it('merges only the fields explicitly provided, same as the privileged path', async () => {
    const existing = makeOwnedContextAsset({ always_inject: true });
    const { repo, service } = makeMocks(existing);

    await service.updateAssetAsOwner('know_test', { body: 'New body' }, 'usr_owner', OWN_PROJECT_ID);

    const [, updates] = repo.patch.mock.calls[0]!;
    expect(updates.body).toBe('New body');
    expect(updates).not.toHaveProperty('always_inject');
    expect(updates).not.toHaveProperty('title');
  });

  it('emits knowledge_asset_updated exactly like updateAsset', async () => {
    const existing = makeOwnedContextAsset({ source_case_refs: [] });
    const { events, service } = makeMocks(existing);

    await service.updateAssetAsOwner(
      'know_test',
      { always_inject: false },
      'usr_owner',
      OWN_PROJECT_ID,
    );

    expect(events.emit).toHaveBeenCalledTimes(1);
    const [, type, payload, actorId] = events.emit.mock.calls[0]!;
    expect(type).toBe('knowledge_asset_updated');
    expect(actorId).toBe('usr_owner');
    expect(payload.changed_fields).toEqual(['always_inject']);
  });

  it('rejects with NotFoundError — not ForbiddenError — when scope_ref does not match, and writes nothing', async () => {
    // Reverted line: removing the `assertOwnedContextAsset` call from
    // `applyAssetUpdate` makes this fail — a caller supplying ANY
    // `expectedScopeRef` would succeed regardless of the asset's real scope,
    // which is exactly the "mutate an arbitrary asset" gap this guard closes.
    const existing = makeOwnedContextAsset({ scope_ref: 'proj_clerk_someone_else' });
    const { repo, events, service } = makeMocks(existing);

    await expect(
      service.updateAssetAsOwner('know_test', { title: 'Hijacked' }, 'usr_attacker', OWN_PROJECT_ID),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(repo.patch).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('rejects with NotFoundError when the asset is in-scope but not a clerk_context entry', async () => {
    const existing = makeOwnedContextAsset({ type: 'precedent' });
    const { repo, service } = makeMocks(existing);

    await expect(
      service.updateAssetAsOwner('know_test', { title: 'Hijacked' }, 'usr_attacker', OWN_PROJECT_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.patch).not.toHaveBeenCalled();
  });
});

describe('KnowledgeService.deleteAssetAsOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes and emits with no role check, when the scope matches', async () => {
    // Reverted line: reintroducing `requirePrivilegedRole` inside
    // `deleteAssetAsOwner` (or the shared `removeAsset` it now calls) makes
    // this fail for the same reason as the update variant above.
    const existing = makeOwnedContextAsset({ source_case_refs: [] });
    const { repo, events, service } = makeMocks(existing);

    await service.deleteAssetAsOwner('know_test', 'usr_owner', OWN_PROJECT_ID);

    expect(repo.delete).toHaveBeenCalledWith('know_test');
    expect(events.emit).toHaveBeenCalledTimes(1);
    const [, type, , actorId] = events.emit.mock.calls[0]!;
    expect(type).toBe('knowledge_asset_deleted');
    expect(actorId).toBe('usr_owner');
  });

  it('rejects with NotFoundError and deletes nothing when scope_ref does not match', async () => {
    // Reverted line: removing the `assertOwnedContextAsset` call from
    // `removeAsset` makes this fail — a caller supplying ANY
    // `expectedScopeRef` would delete an asset belonging to a different
    // project's owner.
    const existing = makeOwnedContextAsset({ scope_ref: 'proj_clerk_someone_else' });
    const { repo, events, service } = makeMocks(existing);

    await expect(
      service.deleteAssetAsOwner('know_test', 'usr_attacker', OWN_PROJECT_ID),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(repo.delete).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('rejects with NotFoundError when the asset is in-scope but not a clerk_context entry', async () => {
    const existing = makeOwnedContextAsset({ type: 'anti_pattern' });
    const { repo, service } = makeMocks(existing);

    await expect(
      service.deleteAssetAsOwner('know_test', 'usr_attacker', OWN_PROJECT_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.delete).not.toHaveBeenCalled();
  });
});

describe('KnowledgeService.updateStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks verified promotion from non-privileged actor', async () => {
    const { service, repo } = makeMocks(makeAsset({ status: 'suggested' }));

    await expect(
      service.updateStatus('know_test', 'verified', 'usr_dev', ['developer']),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(repo.patch).not.toHaveBeenCalled();
    // Role check runs before the Firestore read
    expect(repo.getById).not.toHaveBeenCalled();
  });

  it.each(['tech_lead', 'admin'])(
    'allows verified promotion from %s via the shared role gate',
    async (role) => {
      const { service, repo } = makeMocks(makeAsset({ status: 'suggested' }));

      const result = await service.updateStatus(
        'know_test',
        'verified',
        `usr_${role}`,
        [role],
      );

      expect(result.status).toBe('verified');
      expect(repo.patch).toHaveBeenCalledTimes(1);
      expect(repo.getById).toHaveBeenCalledTimes(1);
    },
  );

  it('blocks canonical promotion from non-privileged actor', async () => {
    const { service, repo } = makeMocks(makeAsset());

    await expect(
      service.updateStatus('know_test', 'canonical', 'usr_dev', ['developer']),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(repo.patch).not.toHaveBeenCalled();
    // Role check runs before the Firestore read
    expect(repo.getById).not.toHaveBeenCalled();
  });

  it('allows canonical promotion from tech_lead via the shared role gate', async () => {
    const { service, repo } = makeMocks(makeAsset({ status: 'verified' }));

    const result = await service.updateStatus(
      'know_test',
      'canonical',
      'usr_tl',
      ['tech_lead'],
    );

    expect(result.status).toBe('canonical');
    expect(repo.patch).toHaveBeenCalledTimes(1);
    expect(repo.getById).toHaveBeenCalledTimes(1);
  });

  it('allows canonical promotion from admin via the shared role gate', async () => {
    const { service } = makeMocks(makeAsset({ status: 'verified' }));

    await expect(
      service.updateStatus(
        'know_test',
        'canonical',
        'usr_admin',
        ['admin'],
      ),
    ).resolves.toMatchObject({ status: 'canonical' });
  });

  it('emits knowledge_asset_status_changed with the status transition', async () => {
    const existing = makeAsset({ status: 'suggested' });
    const { service, events } = makeMocks(existing);

    await service.updateStatus(
      'know_test',
      'verified',
      'usr_tl',
      ['tech_lead'],
    );

    expect(events.emit).toHaveBeenCalledTimes(1);
    const [scopeCaseId, type, payload] = events.emit.mock.calls[0]!;
    expect(scopeCaseId).toBe('case_src');
    expect(type).toBe('knowledge_asset_status_changed');
    expect(payload).toMatchObject({
      knowledge_id: 'know_test',
      from: 'suggested',
      to: 'verified',
    });
  });
});

describe('KnowledgeService.createAsset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists expires_at when provided on create', async () => {
    const { service, repo } = makeMocks(makeAsset());
    const expires = '2027-01-01T00:00:00.000Z';

    const asset = await service.createAsset(
      {
        type: 'precedent',
        title: 'New asset',
        summary: 'summary',
        body: 'body',
        scope_type: 'global',
        scope_ref: 'global',
        expires_at: expires,
      },
      'usr_creator',
    );

    expect(asset.expires_at).toBe(expires);
    expect(repo.create).toHaveBeenCalledTimes(1);
    const [created] = repo.create.mock.calls[0]!;
    expect(created.expires_at).toBe(expires);
  });

  it('omits expires_at when not provided', async () => {
    const { service, repo } = makeMocks(makeAsset());

    const asset = await service.createAsset(
      {
        type: 'precedent',
        title: 'New asset',
        summary: 'summary',
        body: 'body',
        scope_type: 'global',
        scope_ref: 'global',
      },
      'usr_creator',
    );

    expect(asset.expires_at).toBeUndefined();
    const [created] = repo.create.mock.calls[0]!;
    expect(created).not.toHaveProperty('expires_at');
  });

  it('persists always_inject when provided on create (#832 slice A)', async () => {
    const { service, repo } = makeMocks(makeAsset());

    const asset = await service.createAsset(
      {
        type: 'clerk_context',
        title: 'Team roster',
        summary: 'summary',
        body: 'body',
        scope_type: 'project',
        scope_ref: 'proj_clerk_abc',
        always_inject: true,
      },
      'usr_creator',
    );

    expect(asset.always_inject).toBe(true);
    const [created] = repo.create.mock.calls[0]!;
    expect(created.always_inject).toBe(true);
  });

  it('omits always_inject when not provided', async () => {
    const { service, repo } = makeMocks(makeAsset());

    const asset = await service.createAsset(
      {
        type: 'clerk_context',
        title: 'Team roster',
        summary: 'summary',
        body: 'body',
        scope_type: 'project',
        scope_ref: 'proj_clerk_abc',
      },
      'usr_creator',
    );

    expect(asset.always_inject).toBeUndefined();
    const [created] = repo.create.mock.calls[0]!;
    expect(created).not.toHaveProperty('always_inject');
  });
});
