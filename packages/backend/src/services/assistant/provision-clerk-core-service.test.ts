import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case, EvidencePolicy, Project, Repository } from '@arbitra/shared';

/**
 * `ProvisionClerkCoreService` is the self-service, Cloud-Run-native
 * counterpart to `scripts/setup-clerk-core.ts`. Everything below exists to
 * pin the properties the brief calls out explicitly:
 *
 *  - ids come from `clerkCoreIds` — the exact ids `AssistantIntakeService`
 *    resolves — never re-derived;
 *  - calling twice is safe: nothing is created twice, and an existing
 *    document's customized fields are never patched back to the canonical
 *    shape;
 *  - the evidence policy is written risk-first, and — this is the point of
 *    the whole change — resolves through `CompletenessEvaluator`'s real
 *    `getEffectivePolicy` to the assistant's own requirement, not the
 *    built-in defaults a track-first write would silently fall back to;
 *  - membership is the caller alone.
 *
 * A tiny Firestore double stands in for `lib/firestore.js`: point reads/writes
 * by collection + id for `projects` / `repositories`, plus an equality-query
 * `.get()` for `evidence_policies` (all `CompletenessEvaluator.getEffectivePolicy`
 * needs).
 */

type DocData = Record<string, unknown>;

const store = new Map<string, Map<string, DocData>>();

function collectionStore(name: string): Map<string, DocData> {
  let existing = store.get(name);
  if (!existing) {
    existing = new Map();
    store.set(name, existing);
  }
  return existing;
}

/** Mimics Firestore's `ignoreUndefinedProperties` (set in `lib/firestore.ts`). */
function persistable<T>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}

class FakeDocRef {
  constructor(
    readonly collectionName: string,
    readonly id: string,
  ) {}

  async get() {
    const data = collectionStore(this.collectionName).get(this.id);
    return { exists: data !== undefined, data: () => data };
  }

  async set(data: DocData): Promise<void> {
    collectionStore(this.collectionName).set(this.id, persistable(data));
  }
}

interface Filter {
  field: string;
  value: unknown;
}

class FakeQuery {
  constructor(
    readonly collectionName: string,
    protected readonly filters: Filter[] = [],
  ) {}

  where(field: string, _op: '==', value: unknown): FakeQuery {
    return new FakeQuery(this.collectionName, [...this.filters, { field, value }]);
  }

  async get() {
    const docs = [...collectionStore(this.collectionName).values()].filter((doc) =>
      this.filters.every(({ field, value }) => doc[field] === value),
    );
    return { empty: docs.length === 0, docs: docs.map((d) => ({ data: () => d })) };
  }
}

class FakeCollection extends FakeQuery {
  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.collectionName, id);
  }
}

const fakeDb = {
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const writes: Array<{ ref: FakeDocRef; data: DocData }> = [];
    const tx = {
      get: (ref: FakeDocRef) => ref.get(),
      create: (ref: FakeDocRef, data: DocData) => {
        if (collectionStore(ref.collectionName).has(ref.id)) {
          throw new Error(`ALREADY_EXISTS: ${ref.collectionName}/${ref.id}`);
        }
        writes.push({ ref, data });
      },
    };
    const result = await fn(tx);
    // Firestore commits atomically; here that just means "apply everything
    // staged", since nothing in these tests makes a transaction fail.
    for (const write of writes) {
      await write.ref.set(write.data);
    }
    return result;
  },
};

const collections = {
  projects: () => new FakeCollection('projects'),
  repositories: () => new FakeCollection('repositories'),
  evidencePolicies: () => new FakeCollection('evidence_policies'),
};

vi.mock('../../lib/firestore.js', () => ({
  getDb: () => fakeDb,
  collections,
}));

const { ProvisionClerkCoreService } = await import('./provision-clerk-core-service.js');
const { clerkCoreIds } = await import('./clerk-core.js');
const { CompletenessEvaluator } = await import('../evidence/completeness-evaluator.js');

const USER_ID = 'usr_clerk_test';
const ids = clerkCoreIds(USER_ID);

function seedProject(overrides: Partial<Project> = {}): void {
  const project: Project = {
    project_id: ids.projectId,
    name: 'Clerk',
    description: 'Private project for Clerk assistant tasks.',
    owner_user_id: USER_ID,
    members: [USER_ID],
    reviewer_pool: [],
    tech_leads: [],
    default_evidence_policy_id: ids.policyId,
    default_rule_set_refs: [],
    default_validation_track: 'direct',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  collectionStore('projects').set(project.project_id, persistable(project) as DocData);
}

function seedRepository(overrides: Partial<Repository> = {}): void {
  const repository: Repository = {
    repository_id: ids.repositoryId,
    project_id: ids.projectId,
    name: 'clerk-no-source-repository-placeholder',
    url: 'https://clerk-placeholder.invalid/no-source-repository',
    provider: 'other',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  collectionStore('repositories').set(repository.repository_id, persistable(repository) as DocData);
}

function seedPolicy(overrides: Partial<EvidencePolicy> = {}): void {
  const policy: EvidencePolicy = {
    policy_id: ids.policyId,
    project_id: ids.projectId,
    rules: {
      low: {
        direct: {
          required_evidence_types: ['task_result'],
          optional_evidence_types: [],
          four_eyes_required: false,
          allow_self_approval: true,
        },
      },
    },
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  collectionStore('evidence_policies').set(policy.policy_id, persistable(policy) as DocData);
}

function baseCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_test',
    title: 'test',
    description: 'test',
    source_type: 'manual',
    source_ref: '',
    project_id: ids.projectId,
    repository_id: ids.repositoryId,
    owner_user_id: USER_ID,
    status: 'open',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    deleted_by: null,
    ...overrides,
  };
}

describe('ProvisionClerkCoreService', () => {
  beforeEach(() => {
    store.clear();
  });

  it('derives ids from clerkCoreIds, not a re-derivation', async () => {
    const service = new ProvisionClerkCoreService();
    const result = await service.provision(USER_ID);

    expect(result.ids).toEqual(clerkCoreIds(USER_ID));
    expect(result.user_id).toBe(USER_ID);
  });

  it('creates all three documents on a first call', async () => {
    const service = new ProvisionClerkCoreService();
    const result = await service.provision(USER_ID);

    expect(result.items).toEqual([
      { kind: 'project', id: ids.projectId, status: 'created' },
      { kind: 'repository', id: ids.repositoryId, status: 'created' },
      { kind: 'evidence_policy', id: ids.policyId, status: 'created' },
    ]);
    expect(collectionStore('projects').has(ids.projectId)).toBe(true);
    expect(collectionStore('repositories').has(ids.repositoryId)).toBe(true);
    expect(collectionStore('evidence_policies').has(ids.policyId)).toBe(true);
  });

  it('creates a project whose membership is the caller alone', async () => {
    const service = new ProvisionClerkCoreService();
    await service.provision(USER_ID);

    const project = collectionStore('projects').get(ids.projectId) as unknown as Project;
    expect(project.owner_user_id).toBe(USER_ID);
    expect(project.members).toEqual([USER_ID]);
    expect(project.reviewer_pool).toEqual([]);
    expect(project.tech_leads).toEqual([]);
  });

  it('writes the evidence policy risk-first', async () => {
    const service = new ProvisionClerkCoreService();
    await service.provision(USER_ID);

    const policy = collectionStore('evidence_policies').get(ids.policyId) as unknown as EvidencePolicy;
    expect(policy.rules['low']?.['direct']).toEqual({
      required_evidence_types: ['task_result'],
      optional_evidence_types: [],
      four_eyes_required: false,
      allow_self_approval: true,
    });
    // Never track-first — that shape is exactly what `getEffectivePolicy`
    // (risk-first) silently fails to index, per the demo seed script's
    // known-bad example.
    expect(policy.rules).not.toHaveProperty('direct');
  });

  it('resolves through CompletenessEvaluator.getEffectivePolicy to the assistant requirement, not the built-in defaults', async () => {
    const service = new ProvisionClerkCoreService();
    await service.provision(USER_ID);

    const evaluator = new CompletenessEvaluator();
    const resolved = await evaluator.getEffectivePolicyRule(baseCase());

    // The built-in direct/low default requires `ci_result` and forbids
    // self-approval — the opposite of what a Clerk task can ever produce.
    // If the stored policy were indexed wrong (track-first) or missed, this
    // would silently fall back to that default instead of failing loudly,
    // which is exactly the bug this test exists to catch.
    expect(resolved).toEqual({
      required_evidence_types: ['task_result'],
      optional_evidence_types: [],
      four_eyes_required: false,
      allow_self_approval: true,
    });
  });

  it('a second call creates nothing and reports each object as already provisioned', async () => {
    const service = new ProvisionClerkCoreService();
    await service.provision(USER_ID);
    const second = await service.provision(USER_ID);

    expect(second.items).toEqual([
      { kind: 'project', id: ids.projectId, status: 'already_provisioned' },
      { kind: 'repository', id: ids.repositoryId, status: 'already_provisioned' },
      { kind: 'evidence_policy', id: ids.policyId, status: 'already_provisioned' },
    ]);
  });

  it("an existing project's customized fields survive a second call", async () => {
    seedProject({ name: 'Renamed by admin', description: 'Custom description', tech_leads: ['usr_lead'] });
    seedRepository();
    seedPolicy({ rules: { medium: { direct: { required_evidence_types: ['task_result', 'screenshot'], optional_evidence_types: [], four_eyes_required: false, allow_self_approval: true } } } });

    const service = new ProvisionClerkCoreService();
    const result = await service.provision(USER_ID);

    expect(result.items.every((item) => item.status === 'already_provisioned')).toBe(true);

    const project = collectionStore('projects').get(ids.projectId) as unknown as Project;
    expect(project.name).toBe('Renamed by admin');
    expect(project.description).toBe('Custom description');
    expect(project.tech_leads).toEqual(['usr_lead']);

    const policy = collectionStore('evidence_policies').get(ids.policyId) as unknown as EvidencePolicy;
    expect(policy.rules).toEqual({
      medium: {
        direct: {
          required_evidence_types: ['task_result', 'screenshot'],
          optional_evidence_types: [],
          four_eyes_required: false,
          allow_self_approval: true,
        },
      },
    });
  });

  it('creates only the missing document when provisioning was left partially done', async () => {
    seedProject();
    seedRepository();
    // Evidence policy missing — e.g. a prior call failed after two of three
    // documents were created (or, for this service, a doc created by some
    // other path).

    const service = new ProvisionClerkCoreService();
    const result = await service.provision(USER_ID);

    expect(result.items).toEqual([
      { kind: 'project', id: ids.projectId, status: 'already_provisioned' },
      { kind: 'repository', id: ids.repositoryId, status: 'already_provisioned' },
      { kind: 'evidence_policy', id: ids.policyId, status: 'created' },
    ]);
    expect(collectionStore('evidence_policies').has(ids.policyId)).toBe(true);
  });
});
