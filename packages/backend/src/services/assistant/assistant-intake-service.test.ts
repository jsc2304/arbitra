import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Artifact, Case, CreateCaseInput, Evidence, Project, Repository, Run } from '@arbitra/shared';

/**
 * Intake is the point where an assistant task becomes three inseparable
 * documents: the case, the `assistant_task_received` event that makes it
 * auditable, and the unclaimed `assistant_task_run` that makes it executable.
 * Everything below exists to hold one of two properties:
 *
 *  - **atomicity** — all three land or none do, so no case can exist without a
 *    history or without something to pick it up;
 *  - **idempotency** — one key yields exactly one case, under any interleaving.
 *
 * The Firestore double therefore models the two behaviours those properties
 * depend on: a commit applies every staged write or none of them, and
 * transactions that touch the same document commit serially, so a transaction
 * starting after another has committed observes the committed state.
 *
 * It also enforces Firestore's read-before-write rule inside a transaction. That
 * rule is the reason the per-user limit queries run outside the transaction, so
 * a double that quietly allowed a late read would hide the very constraint the
 * ordering is designed around.
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

function snapshotOf(collectionName: string, id: string) {
  const data = collectionStore(collectionName).get(id);
  return { id, exists: data !== undefined, data: () => data };
}

interface Filter {
  field: string;
  op: '==' | 'in' | 'not-in' | '>=';
  value: unknown;
}

function matches(doc: DocData, filters: Filter[]): boolean {
  return filters.every(({ field, op, value }) => {
    const actual = field.split('.').reduce<unknown>((current, part) => {
      if (!current || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[part];
    }, doc) ?? null;
    switch (op) {
      case '==':
        return actual === (value ?? null);
      case 'in':
        return (value as unknown[]).includes(actual);
      case 'not-in':
        // Firestore's `not-in` also excludes documents missing the field.
        return doc[field] !== undefined && !(value as unknown[]).includes(actual);
      case '>=':
        return String(actual) >= String(value);
    }
  });
}

class FakeQuery {
  constructor(
    readonly collectionName: string,
    protected readonly filters: Filter[] = [],
    protected readonly maxResults?: number,
  ) {}

  where(field: string, op: Filter['op'], value: unknown): FakeQuery {
    return new FakeQuery(this.collectionName, [...this.filters, { field, op, value }], this.maxResults);
  }

  limit(maxResults: number): FakeQuery {
    return new FakeQuery(this.collectionName, this.filters, maxResults);
  }

  private results(): DocData[] {
    const matched = [...collectionStore(this.collectionName).values()].filter((doc) =>
      matches(doc, this.filters),
    );
    return this.maxResults === undefined ? matched : matched.slice(0, this.maxResults);
  }

  count() {
    return {
      get: async () => ({ data: () => ({ count: this.results().length }) }),
    };
  }

  async get() {
    const docs = this.results();
    return { empty: docs.length === 0, docs: docs.map((d) => ({ data: () => d })) };
  }
}

class FakeDocRef {
  constructor(
    readonly collectionName: string,
    readonly id: string,
  ) {}

  get path(): string {
    return `${this.collectionName}/${this.id}`;
  }

  async get() {
    return snapshotOf(this.collectionName, this.id);
  }

  async set(data: DocData) {
    collectionStore(this.collectionName).set(this.id, persistable(data));
  }

  async create(data: DocData) {
    // Mirrors real Firestore create-if-not-exists semantics (issue #1063:
    // EventRepository.create() now uses `.doc(id).create(event)` for the
    // append-only case_events write).
    if (collectionStore(this.collectionName).has(this.id)) {
      throw new Error(`ALREADY_EXISTS: ${this.path}`);
    }
    collectionStore(this.collectionName).set(this.id, persistable(data));
  }
}

class FakeCollection extends FakeQuery {
  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.collectionName, id);
  }
}

type StagedWrite = { ref: FakeDocRef; op: 'create' | 'set' | 'update'; data: DocData };

/** Commits, each as the list of document paths it wrote. */
const commits: string[][] = [];
let transactionCount = 0;
/** When set, the next commit throws instead of applying any staged write. */
let failNextCommit: string | null = null;
// One in-flight chain: transaction N's writes are applied before N+1 reads.
let txQueue: Promise<unknown> = Promise.resolve();

const fakeDb = {
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    transactionCount += 1;
    const next = txQueue.then(async () => {
      const writes: StagedWrite[] = [];
      const tx = {
        get: async (ref: FakeDocRef) => {
          if (writes.length > 0) {
            throw new Error(
              'Firestore transactions require all reads to be executed before all writes.',
            );
          }
          return ref.get();
        },
        create: (ref: FakeDocRef, data: DocData) => writes.push({ ref, op: 'create', data }),
        set: (ref: FakeDocRef, data: DocData) => writes.push({ ref, op: 'set', data }),
        update: (ref: FakeDocRef, data: DocData) => writes.push({ ref, op: 'update', data }),
      };
      const result = await fn(tx);

      if (failNextCommit) {
        const message = failNextCommit;
        failNextCommit = null;
        // Firestore commits atomically: a failed commit applies nothing.
        throw new Error(message);
      }
      for (const write of writes) {
        if (write.op === 'create' && collectionStore(write.ref.collectionName).has(write.ref.id)) {
          throw new Error(`ALREADY_EXISTS: ${write.ref.path}`);
        }
      }
      for (const write of writes) {
        await write.ref.set(write.data);
      }
      if (writes.length > 0) commits.push(writes.map((w) => w.ref.path));
      return result;
    });
    txQueue = next.catch(() => undefined);
    return next;
  },
};

const collections = {
  cases: () => new FakeCollection('cases'),
  activeCases: () => new FakeQuery('cases').where('deleted_at', '==', null),
  caseEvents: () => new FakeCollection('case_events'),
  runs: () => new FakeCollection('runs'),
  projects: () => new FakeCollection('projects'),
  repositories: () => new FakeCollection('repositories'),
  evidence: () => new FakeCollection('evidence'),
  artifacts: () => new FakeCollection('artifacts'),
  assistantIntakeReceipts: () => new FakeCollection('assistant_intake_receipts'),
};

vi.mock('../../lib/firestore.js', () => ({
  getDb: () => fakeDb,
  collections,
}));

// `EventService` fires notifications off the write path; irrelevant here and it
// would reach for collections this double does not model.
vi.mock('../notification/event-notifier.js', () => ({
  EventNotifier: class {
    async onCaseEvent() {}
  },
}));

const REQUESTER = 'usr_requester';
const OTHER_USER = 'usr_other';

const LIMIT_ENV_VARS = [
  'ARBITRA_ASSISTANT_MAX_ACTIVE_PER_USER',
  'ARBITRA_ASSISTANT_DAILY_LIMIT',
  'ARBITRA_ASSISTANT_MAX_INPUT_CHARS',
  'ARBITRA_ASSISTANT_POLICY_VERSION',
  'ARBITRA_ASSISTANT_PROMPT_VERSION',
] as const;

const {
  AssistantIntakeService,
  ClerkCoreNotProvisionedError,
  assistantIntakeReceiptId,
  buildCaseDocument,
  resolveAssistantIntakeLimits,
  deriveTitle,
  startOfUtcDay,
} = await import('./assistant-intake-service.js');
const { clerkCoreIds } = await import('./clerk-core.js');
const { CaseService } = await import('../case/case-service.js');
const { AssistantFollowUpService } = await import('./assistant-follow-up-service.js');

const ids = clerkCoreIds(REQUESTER);

function seedClerkCore(overrides: Partial<Project> = {}, userId = REQUESTER): void {
  const coreIds = clerkCoreIds(userId);
  const project: Project = {
    project_id: coreIds.projectId,
    name: 'Clerk',
    description: 'Private project for Clerk assistant tasks.',
    owner_user_id: userId,
    members: [userId],
    reviewer_pool: [],
    tech_leads: [],
    default_evidence_policy_id: coreIds.policyId,
    default_validation_track: 'direct',
    default_rule_set_refs: [],
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
  const repository: Repository = {
    repository_id: coreIds.repositoryId,
    project_id: coreIds.projectId,
    name: 'clerk-no-source-repository-placeholder',
    url: 'https://clerk-placeholder.invalid/no-source-repository',
    provider: 'other',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
  collectionStore('projects').set(project.project_id, persistable(project) as DocData);
  collectionStore('repositories').set(repository.repository_id, persistable(repository) as DocData);
}

function seedCase(overrides: Partial<Case> & { case_id: string }): void {
  const base: Case = {
    case_id: overrides.case_id,
    title: 'seeded',
    description: 'seeded',
    source_type: 'manual',
    source_ref: '',
    project_id: ids.projectId,
    repository_id: ids.repositoryId,
    owner_user_id: REQUESTER,
    status: 'open',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    case_type: 'assistant_task',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
    deleted_by: null,
  };
  const merged = { ...base, ...overrides };
  collectionStore('cases').set(merged.case_id, persistable(merged) as DocData);
}

function storedCases(): Case[] {
  return [...collectionStore('cases').values()] as unknown as Case[];
}
function storedRuns(): Run[] {
  return [...collectionStore('runs').values()] as unknown as Run[];
}
function storedEvents(): DocData[] {
  return [...collectionStore('case_events').values()];
}
function storedReceipts(): DocData[] {
  return [...collectionStore('assistant_intake_receipts').values()];
}

function seedCompletedParent(caseId = 'case_parent', ownerUserId = REQUESTER) {
  const runId = `run_${caseId}`;
  const evidenceId = `evidence_${caseId}`;
  const artifactId = `artifact_${caseId}`;
  seedCase({
    case_id: caseId,
    status: 'done',
    owner_user_id: ownerUserId,
    description: 'What changed in the open cases?',
    assistant_context: {
      channel: 'web',
      conversation_visibility: 'direct',
      requester_user_id: ownerUserId,
      risk_level: 'low',
      policy_version: 'assistant_policy:v1',
      prompt_version: 'assistant_task:v1',
    },
  });
  const now = '2026-08-05T07:00:00.000Z';
  const run: Run = {
    run_id: runId,
    case_id: caseId,
    run_type: 'assistant_task_run',
    trigger_source: 'assistant-intake:web',
    status: 'completed',
    input_refs: [],
    output_refs: [artifactId],
    created_at: now,
    updated_at: now,
    finished_at: now,
    attempt: 1,
  };
  const evidence: Evidence = {
    evidence_id: evidenceId,
    case_id: caseId,
    run_id: runId,
    type: 'task_result',
    source_type: 'automated',
    artifact_ref: artifactId,
    summary: 'Three cases changed.',
    machine_readable: true,
    validation_track: 'direct',
    created_at: now,
    created_by: 'system:clerk',
  };
  const artifact: Artifact = {
    artifact_id: artifactId,
    case_id: caseId,
    run_id: runId,
    filename: 'result.json',
    content_type: 'application/json',
    storage_path: 'assistant/result.json',
    size_bytes: 123,
    created_by: 'system:clerk',
    created_at: now,
  };
  collectionStore('runs').set(runId, persistable(run) as DocData);
  collectionStore('evidence').set(evidenceId, persistable(evidence) as DocData);
  collectionStore('artifacts').set(artifactId, persistable(artifact) as DocData);
  return { caseId, runId, evidenceId, artifactId };
}

beforeEach(() => {
  store.clear();
  commits.length = 0;
  transactionCount = 0;
  failNextCommit = null;
  txQueue = Promise.resolve();
  for (const key of LIMIT_ENV_VARS) delete process.env[key];
  seedClerkCore();
});

afterEach(() => {
  for (const key of LIMIT_ENV_VARS) delete process.env[key];
});

describe('AssistantIntakeService.intake — the three writes', () => {
  it('lands the case, the received event, and the run in ONE transaction', async () => {
    const result = await new AssistantIntakeService().intake(
      { text: 'Summarise the open cases for me' },
      REQUESTER,
    );

    expect(transactionCount).toBe(1);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual([
      `cases/${result.case.case_id}`,
      `case_events/${result.event_id}`,
      `runs/${result.run_id}`,
    ]);

    expect(storedCases()).toHaveLength(1);
    expect(storedEvents()).toHaveLength(1);
    expect(storedRuns()).toHaveLength(1);
  });

  it('stamps the case with the assistant task shape', async () => {
    const { case: created } = await new AssistantIntakeService().intake(
      { text: 'Summarise the open cases for me' },
      REQUESTER,
    );

    expect(created.case_type).toBe('assistant_task');
    expect(created.project_id).toBe(ids.projectId);
    expect(created.repository_id).toBe(ids.repositoryId);
    expect(created.owner_user_id).toBe(REQUESTER);
    expect(created.validation_track).toBe('direct');
    expect(created.status).toBe('open');
  });

  it('records only what intake knows and leaves task_kind to the executor', async () => {
    process.env['ARBITRA_ASSISTANT_POLICY_VERSION'] = 'assistant_policy:v7';
    process.env['ARBITRA_ASSISTANT_PROMPT_VERSION'] = 'assistant_task:v9';

    const { case: created } = await new AssistantIntakeService().intake(
      { text: 'Summarise the open cases for me' },
      REQUESTER,
    );

    expect(created.assistant_context).toEqual({
      channel: 'web',
      conversation_visibility: 'direct',
      requester_user_id: REQUESTER,
      risk_level: 'low',
      policy_version: 'assistant_policy:v7',
      prompt_version: 'assistant_task:v9',
    });
    // No invented classification, and none persisted either.
    expect(created.assistant_context).not.toHaveProperty('task_kind');
    const persisted = storedCases()[0]!;
    expect(persisted.assistant_context).not.toHaveProperty('task_kind');
  });

  it('emits an assistant_task_received event pointing at the run', async () => {
    const result = await new AssistantIntakeService().intake(
      { text: 'Summarise the open cases' },
      REQUESTER,
    );

    const event = storedEvents()[0]!;
    expect(event['type']).toBe('assistant_task_received');
    expect(event['case_id']).toBe(result.case.case_id);
    expect(event['actor_id']).toBe(REQUESTER);
    expect(event['payload']).toEqual(
      expect.objectContaining({
        channel: 'web',
        requester_user_id: REQUESTER,
        run_id: result.run_id,
      }),
    );
  });

  it('creates the run UNCLAIMED — no lease, no worker, not started', async () => {
    const result = await new AssistantIntakeService().intake({ text: 'Do a thing' }, REQUESTER);

    const run = storedRuns()[0]!;
    expect(run.run_id).toBe(result.run_id);
    expect(run.run_type).toBe('assistant_task_run');
    expect(run.status).toBe('pending');
    expect(run.awaiting_claim).toBe(true);
    expect(run.attempt).toBe(1);
    // Reverting the explicit intake state makes a pre-model crash
    // indistinguishable from a legacy row with unavailable policy.
    expect(run.assistant_policy_state).toBe('unbound');
    expect(run.assistant_tool_policy).toBeUndefined();
    expect(run.lease_expires_at).toBeUndefined();
    expect(run.worker_id).toBeUndefined();
    expect(run.started_at).toBeUndefined();
    // Same for the returned doc the route dispatches.
    expect(result.run?.lease_expires_at).toBeUndefined();
    expect(result.run?.worker_id).toBeUndefined();
    expect(result.run?.started_at).toBeUndefined();
    expect(result.run?.assistant_policy_state).toBe('unbound');
  });

  it('derives a title from the first line and keeps the full text as description', async () => {
    const text = 'Check the deploy\n\nIt has been failing since this morning.';
    const { case: created } = await new AssistantIntakeService().intake({ text }, REQUESTER);

    expect(created.title).toBe('Check the deploy');
    expect(created.description).toBe(text);
  });
});

describe('AssistantIntakeService.intakeFollowUp', () => {
  it('creates one child with exact immutable provenance and leaves the parent untouched', async () => {
    const refs = seedCompletedParent();
    const parentBefore = JSON.stringify(collectionStore('cases').get(refs.caseId));

    const result = await new AssistantIntakeService().intakeFollowUp(
      { text: 'Which of those is urgent?', idempotency_key: 'turn-2' },
      REQUESTER,
      refs.caseId,
    );

    expect(result.replayed).toBe(false);
    expect(result.case.assistant_thread).toEqual({
      schema_version: 1,
      root_case_id: refs.caseId,
      parent_case_id: refs.caseId,
      prior_run_id: refs.runId,
      prior_result_evidence_id: refs.evidenceId,
      prior_result_artifact_id: refs.artifactId,
      depth: 1,
    });
    expect(JSON.stringify(collectionStore('cases').get(refs.caseId))).toBe(parentBefore);
    expect(storedCases()).toHaveLength(2);
    expect(storedRuns()).toHaveLength(2);
    expect(storedReceipts()).toHaveLength(1);
    expect(storedEvents().at(-1)?.['payload']).toEqual(
      expect.objectContaining({ assistant_thread: result.case.assistant_thread }),
    );
  });

  it('replays the same child before revalidating a parent that later became unavailable', async () => {
    const refs = seedCompletedParent();
    const service = new AssistantIntakeService();
    const request = { text: 'Which one?', idempotency_key: 'stable-turn' };
    const first = await service.intakeFollowUp(request, REQUESTER, refs.caseId);
    collectionStore('cases').set(refs.caseId, {
      ...collectionStore('cases').get(refs.caseId)!,
      deleted_at: '2026-08-05T08:00:00.000Z',
    });

    const replay = await service.intakeFollowUp(request, REQUESTER, refs.caseId);

    expect(replay).toMatchObject({ replayed: true, case: { case_id: first.case.case_id } });
    expect(storedCases()).toHaveLength(2);
  });

  it('does not let another user continue a private Clerk task', async () => {
    const refs = seedCompletedParent();
    seedClerkCore({}, OTHER_USER);

    await expect(
      new AssistantIntakeService().intakeFollowUp(
        { text: 'Tell me more', idempotency_key: 'foreign-turn' },
        OTHER_USER,
        refs.caseId,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(storedCases()).toHaveLength(1);
  });

  it('requires a completed parent with a task_result for its latest completed Run', async () => {
    seedCompletedParent();
    const parent = collectionStore('cases').get('case_parent')!;
    collectionStore('cases').set('case_parent', { ...parent, status: 'in_build' });

    await expect(
      new AssistantIntakeService().intakeFollowUp(
        { text: 'Too soon?', idempotency_key: 'early-turn' },
        REQUESTER,
        'case_parent',
      ),
    ).rejects.toMatchObject({ code: 'ASSISTANT_FOLLOW_UP_INVALID' });
    expect(storedCases()).toHaveLength(1);
  });

  /**
   * Before this fix, `intakeFollowUp` built its
   * `effectiveRequest` as `{ text, channel, idempotency_key }` only — no
   * `chat` field existed on `AssistantFollowUpRequest` at all, so a
   * Chat-originated follow-up's `assistant_context` never got a
   * `space_name`/`thread_name`, and `EventNotifier.notifyChatThreadOutcome`'s
   * `if (!ctx.space_name) return;` guard then silently dropped its
   * completion reply forever. Reverting the `...(request.chat ? { chat:
   * request.chat } : {})` spread in `intakeFollowUp` (or the `chat?:
   * AssistantIntakeChatContext` field on `AssistantFollowUpRequest`) makes
   * `assistant_context` below come back with no chat fields at all.
   *
   * Covers the space-thread variant: `conversation_visibility: 'space'`,
   * `thread_name` present.
   */
  it('persists the chat block into the follow-up case (space-thread variant)', async () => {
    const refs = seedCompletedParent();
    const chat = {
      space_name: 'spaces/AAA',
      thread_name: 'spaces/AAA/threads/CCC',
      source_message_name: 'spaces/AAA/messages/M2',
      chat_user_name: 'users/123',
      conversation_visibility: 'space' as const,
    };

    const result = await new AssistantIntakeService().intakeFollowUp(
      {
        text: 'Which one is urgent?',
        idempotency_key: 'spaces/AAA/messages/M2',
        channel: 'google_chat',
        chat,
      },
      REQUESTER,
      refs.caseId,
    );

    expect(result.case.assistant_context).toMatchObject(chat);
  });

  /**
   * Same fix, the DM variant: `conversation_visibility: 'direct'` and no
   * `thread_name` (a Chat DM message carries no reusable thread — see
   * `AssistantIntakeChatContext`'s doc and `chat-sender.ts`'s DM handling).
   * `space_name` alone is what gives a DM follow-up continuity, and it is
   * exactly the field the bug report's example was
   * missing. Reverting the same lines as the test above breaks this one too.
   */
  it('persists the chat block into the follow-up case (DM variant, no thread_name)', async () => {
    const refs = seedCompletedParent();
    const chat = {
      space_name: 'spaces/DMDM',
      source_message_name: 'spaces/DMDM/messages/M3',
      chat_user_name: 'users/456',
      conversation_visibility: 'direct' as const,
    };

    const result = await new AssistantIntakeService().intakeFollowUp(
      {
        text: 'One more thing',
        idempotency_key: 'spaces/DMDM/messages/M3',
        channel: 'google_chat',
        chat,
      },
      REQUESTER,
      refs.caseId,
    );

    expect(result.case.assistant_context).toMatchObject(chat);
    expect(result.case.assistant_context).not.toHaveProperty('thread_name');
  });
});

/**
 * PR #941: the Chat route (`runChatIntake` in
 * `packages/frontend/src/app/api/chat/events/route.ts`) re-decides
 * root-vs-follow-up on EVERY delivery of a message, from the thread's
 * mutable tip status. A redelivery of the exact same Chat message can
 * therefore be routed through `intake()` on its first delivery and through
 * `intakeFollowUp()` on a later redelivery (once the case has reached a
 * terminal status), or vice versa. Before this fix, those two methods
 * checked/wrote idempotency receipts in DIFFERENT namespaces for a
 * `google_chat` call — `intake()` keyed on (channel, requester, key) directly,
 * `intakeFollowUp()` always keyed on (`'web'`, requester, a key rehashed
 * with the parent case id) — so a redelivery landing on the other branch
 * than its first delivery missed the existing receipt entirely and created
 * a SECOND case (and, at the route layer, a second ack).
 */
function seedCompletedRunForCase(caseId: string): void {
  const runId = `run_completed_${caseId}`;
  const evidenceId = `evidence_completed_${caseId}`;
  const artifactId = `artifact_completed_${caseId}`;
  const now = '2026-08-05T09:00:00.000Z';
  const run: Run = {
    run_id: runId,
    case_id: caseId,
    run_type: 'assistant_task_run',
    trigger_source: 'assistant-intake:google_chat',
    status: 'completed',
    input_refs: [],
    output_refs: [artifactId],
    created_at: now,
    updated_at: now,
    finished_at: now,
    attempt: 1,
  };
  const evidence: Evidence = {
    evidence_id: evidenceId,
    case_id: caseId,
    run_id: runId,
    type: 'task_result',
    source_type: 'automated',
    artifact_ref: artifactId,
    summary: 'Done.',
    machine_readable: true,
    validation_track: 'direct',
    created_at: now,
    created_by: 'system:clerk',
  };
  const artifact: Artifact = {
    artifact_id: artifactId,
    case_id: caseId,
    run_id: runId,
    filename: 'result.json',
    content_type: 'application/json',
    storage_path: 'assistant/result.json',
    size_bytes: 42,
    created_by: 'system:clerk',
    created_at: now,
  };
  collectionStore('runs').set(runId, persistable(run) as DocData);
  collectionStore('evidence').set(evidenceId, persistable(evidence) as DocData);
  collectionStore('artifacts').set(artifactId, persistable(artifact) as DocData);
  const existingCase = collectionStore('cases').get(caseId)!;
  collectionStore('cases').set(caseId, { ...existingCase, status: 'done' });
}

describe('AssistantIntakeService — Chat redelivery across a routing-branch change (#941 regression)', () => {
  const MESSAGE_KEY = 'spaces/AAA/messages/M1';

  /**
   * The regression the review found. Reverting EITHER of `intakeFollowUp`'s
   * two fix lines breaks this:
   *  - the `channel === 'web' ? assistantFollowUpReceiptKey(...) :
   *    request.idempotency_key` ternary (reverting it to always call
   *    `assistantFollowUpReceiptKey`), or
   *  - the `this.findReplay(channel, ...)` call (reverting `channel` back
   *    to the literal `'web'`).
   * Either revert makes the redelivery below miss the receipt `intake()`
   * wrote, so it falls through to `resolveParentLink` (which succeeds,
   * since the case is seeded `done` with a completed Run/Evidence/Artifact)
   * and creates a SECOND case.
   */
  it('replays a redelivery routed to intakeFollowUp into the case intake() already created, with no second case or receipt', async () => {
    const service = new AssistantIntakeService();
    const first = await service.intake(
      { text: 'Please review PR #42', channel: 'google_chat', idempotency_key: MESSAGE_KEY },
      REQUESTER,
    );
    expect(first.replayed).toBe(false);
    // The task later completes — independent of this bug, this is what
    // moves `resolveExistingChatThreadCase` from 'busy' to 'ready' and
    // makes the route send the redelivery down `intakeFollowUp` instead.
    seedCompletedRunForCase(first.case.case_id);

    const redelivery = await service.intakeFollowUp(
      { text: 'Please review PR #42', idempotency_key: MESSAGE_KEY, channel: 'google_chat' },
      REQUESTER,
      first.case.case_id,
    );

    expect(redelivery.replayed).toBe(true);
    expect(redelivery.case.case_id).toBe(first.case.case_id);
    expect(storedCases()).toHaveLength(1);
    expect(storedReceipts()).toHaveLength(1);
  });

  /**
   * The mirror image: the message is first accepted as a follow-up (the
   * thread already had a completed parent when it arrived), and a LATER
   * redelivery of the exact same message finds the follow-up's own
   * resulting case has since ALSO reached a terminal status, so the route
   * would again call `intakeFollowUp` — this time with a DIFFERENT
   * `parentCaseId` (the follow-up's own case) than the first delivery used.
   * Reverting the same two lines as above breaks this the same way, since
   * both deliveries go through `intakeFollowUp` but with different parent
   * ids — only a parent-INDEPENDENT namespace collapses them to one case.
   */
  it('replays a later redelivery of a follow-up message even when the parentCaseId offered this time differs from the first delivery', async () => {
    const refs = seedCompletedParent();
    const service = new AssistantIntakeService();
    const first = await service.intakeFollowUp(
      { text: 'Which one is urgent?', idempotency_key: MESSAGE_KEY, channel: 'google_chat' },
      REQUESTER,
      refs.caseId,
    );
    expect(first.replayed).toBe(false);
    expect(storedCases()).toHaveLength(2);
    seedCompletedRunForCase(first.case.case_id);

    // Redelivery, now routed with the FOLLOW-UP's own case as parent
    // (`first.case.case_id`), not the original `refs.caseId`.
    const redelivery = await service.intakeFollowUp(
      { text: 'Which one is urgent?', idempotency_key: MESSAGE_KEY, channel: 'google_chat' },
      REQUESTER,
      first.case.case_id,
    );

    expect(redelivery.replayed).toBe(true);
    expect(redelivery.case.case_id).toBe(first.case.case_id);
    expect(storedCases()).toHaveLength(2);
  });

  /**
   * The reply-target fix must not disturb the
   * idempotency contract this whole describe block exists to protect — a
   * redelivered follow-up message, now additionally carrying a `chat`
   * block, still resolves to exactly one case and one receipt, and the
   * chat context persisted is the one from the FIRST delivery (a replay
   * never re-runs `buildCreateCaseInput`, so a redelivery presenting a
   * different chat payload — which should never happen in practice, but
   * proves the write path isn't re-executed — cannot overwrite it).
   */
  it('a redelivered follow-up message carrying a chat block stays idempotent — one case, one receipt, no second reply', async () => {
    const refs = seedCompletedParent();
    const service = new AssistantIntakeService();
    const chat = {
      space_name: 'spaces/AAA',
      thread_name: 'spaces/AAA/threads/CCC',
      source_message_name: MESSAGE_KEY,
      chat_user_name: 'users/123',
      conversation_visibility: 'space' as const,
    };

    const first = await service.intakeFollowUp(
      { text: 'Which one is urgent?', idempotency_key: MESSAGE_KEY, channel: 'google_chat', chat },
      REQUESTER,
      refs.caseId,
    );
    expect(first.replayed).toBe(false);

    const redelivery = await service.intakeFollowUp(
      // Redelivery of the exact same Chat message: same key, same chat
      // coordinates (Chat always resends identical payload on retry).
      { text: 'Which one is urgent?', idempotency_key: MESSAGE_KEY, channel: 'google_chat', chat },
      REQUESTER,
      refs.caseId,
    );

    expect(redelivery.replayed).toBe(true);
    expect(redelivery.case.case_id).toBe(first.case.case_id);
    expect(storedCases()).toHaveLength(2); // parent + one follow-up, not two follow-ups
    expect(storedReceipts()).toHaveLength(1);
    expect(redelivery.case.assistant_context).toMatchObject(chat);
  });
});

describe('AssistantFollowUpService', () => {
  function resultStorage(refs: ReturnType<typeof seedCompletedParent>, overrides: Record<string, unknown> = {}) {
    const document = {
      schema: 'arbitra.assistant_task_result/v2',
      case_id: refs.caseId,
      run_id: refs.runId,
      answer: 'Three cases changed.',
      tool_calls: [{ name: 'arbitra_search_cases', params: {}, outcome: 'ok' }],
      ...overrides,
    };
    return {
      save: vi.fn(),
      delete: vi.fn(),
      read: vi.fn(async () =>
        `data:application/json;base64,${Buffer.from(JSON.stringify(document)).toString('base64')}`),
    };
  }

  it('loads the one pinned turn — request, answer, redacted trace, case id — for a depth-1 follow-up', async () => {
    const refs = seedCompletedParent();
    const child = await new AssistantIntakeService().intakeFollowUp(
      { text: 'Which is urgent?', idempotency_key: 'context-turn' },
      REQUESTER,
      refs.caseId,
    );

    const turns = await new AssistantFollowUpService(resultStorage(refs)).loadContext(child.case);

    expect(turns).toEqual([
      {
        caseId: refs.caseId,
        request: 'What changed in the open cases?',
        answer: 'Three cases changed.',
        toolTrace: JSON.stringify([
          { name: 'arbitra_search_cases', params: {}, outcome: 'ok' },
        ]),
      },
    ]);
  });

  it('fails closed when result bytes do not match the pinned Run', async () => {
    const refs = seedCompletedParent();
    const child = await new AssistantIntakeService().intakeFollowUp(
      { text: 'Which is urgent?', idempotency_key: 'bad-context-turn' },
      REQUESTER,
      refs.caseId,
    );

    await expect(
      new AssistantFollowUpService(resultStorage(refs, { run_id: 'run_forged' }))
        .loadContext(child.case),
    ).rejects.toMatchObject({ code: 'ASSISTANT_FOLLOW_UP_INVALID' });
  });

  it('returns the dedicated conversation in depth order with stored answer previews', async () => {
    const refs = seedCompletedParent();
    const child = await new AssistantIntakeService().intakeFollowUp(
      { text: 'Which is urgent?', idempotency_key: 'thread-turn' },
      REQUESTER,
      refs.caseId,
    );

    const thread = await new AssistantFollowUpService(resultStorage(refs))
      .getThread(child.case.case_id, REQUESTER);

    expect(thread.root_case_id).toBe(refs.caseId);
    expect(thread.turns.map((turn) => [turn.case_id, turn.depth])).toEqual([
      [refs.caseId, 0],
      [child.case.case_id, 1],
    ]);
    expect(thread.turns[0]?.answer_preview).toBe('Three cases changed.');
  });

  /**
   * #968 proposal 1: before this fix, `loadContext`
   * pinned exactly ONE hop — the immediate parent's own result — and a
   * follow-up beyond depth 1 never saw anything before that. Reverting
   * `loadContext` to its old single-hop form (fetching only
   * `case_.assistant_thread`'s own pinned run/evidence/artifact) fails this:
   * the returned array would have length 1 (just turn 2), not 3.
   */
  function completeCaseWithResult(
    caseId: string,
    opts: { description?: string; ownerUserId?: string } = {},
  ): { caseId: string; runId: string; evidenceId: string; artifactId: string; storagePath: string } {
    const ownerUserId = opts.ownerUserId ?? REQUESTER;
    const existing = collectionStore('cases').get(caseId);
    if (existing) {
      collectionStore('cases').set(caseId, { ...existing, status: 'done' });
    } else {
      seedCase({
        case_id: caseId,
        status: 'done',
        owner_user_id: ownerUserId,
        description: opts.description ?? 'seeded question',
        assistant_context: {
          channel: 'web',
          conversation_visibility: 'direct',
          requester_user_id: ownerUserId,
          risk_level: 'low',
          policy_version: 'assistant_policy:v1',
          prompt_version: 'assistant_task:v1',
        },
      });
    }
    const runId = `run_${caseId}`;
    const evidenceId = `evidence_${caseId}`;
    const artifactId = `artifact_${caseId}`;
    const storagePath = `assistant/${artifactId}.json`;
    const now = '2026-08-05T07:00:00.000Z';
    const run: Run = {
      run_id: runId,
      case_id: caseId,
      run_type: 'assistant_task_run',
      trigger_source: 'assistant-intake:web',
      status: 'completed',
      input_refs: [],
      output_refs: [artifactId],
      created_at: now,
      updated_at: now,
      finished_at: now,
      attempt: 1,
    };
    const evidence: Evidence = {
      evidence_id: evidenceId,
      case_id: caseId,
      run_id: runId,
      type: 'task_result',
      source_type: 'automated',
      artifact_ref: artifactId,
      summary: 'preview',
      machine_readable: true,
      validation_track: 'direct',
      created_at: now,
      created_by: 'system:clerk',
    };
    const artifact: Artifact = {
      artifact_id: artifactId,
      case_id: caseId,
      run_id: runId,
      filename: 'result.json',
      content_type: 'application/json',
      storage_path: storagePath,
      size_bytes: 1,
      created_by: 'system:clerk',
      created_at: now,
    };
    collectionStore('runs').set(runId, persistable(run) as DocData);
    collectionStore('evidence').set(evidenceId, persistable(evidence) as DocData);
    collectionStore('artifacts').set(artifactId, persistable(artifact) as DocData);
    return { caseId, runId, evidenceId, artifactId, storagePath };
  }

  /**
   * `loadContext` reads one storage path per ancestor turn — this double keys
   * its fixtures by `storage_path` so a multi-turn chain test can give each
   * ancestor its own distinct answer and tool trace (the single-document
   * `resultStorage` above cannot: every case in these tests shares no path).
   */
  function chainStorage(
    fixtures: ReadonlyArray<{ storagePath: string; caseId: string; runId: string; answer: string; toolCalls: unknown[] }>,
  ) {
    const byPath = new Map(fixtures.map((f) => [f.storagePath, f]));
    return {
      save: vi.fn(),
      delete: vi.fn(),
      read: vi.fn(async (path: string) => {
        const entry = byPath.get(path);
        if (!entry) throw new Error(`chainStorage: no fixture for path ${path}`);
        const document = {
          schema: 'arbitra.assistant_task_result/v2',
          case_id: entry.caseId,
          run_id: entry.runId,
          answer: entry.answer,
          tool_calls: entry.toolCalls,
        };
        return `data:application/json;base64,${Buffer.from(JSON.stringify(document)).toString('base64')}`;
      }),
    };
  }

  it('walks the WHOLE chain — not just the immediate parent — for a depth-3 follow-up, oldest first', async () => {
    const service = new AssistantIntakeService();
    const root = completeCaseWithResult('case_root_multi', { description: 'What changed?' });

    const turn1 = await service.intakeFollowUp(
      { text: 'Which one is urgent?', idempotency_key: 'multi-1' },
      REQUESTER,
      root.caseId,
    );
    const turn1Result = completeCaseWithResult(turn1.case.case_id);

    const turn2 = await service.intakeFollowUp(
      { text: 'Why is it urgent?', idempotency_key: 'multi-2' },
      REQUESTER,
      turn1.case.case_id,
    );
    const turn2Result = completeCaseWithResult(turn2.case.case_id);

    const turn3 = await service.intakeFollowUp(
      { text: 'Who should fix it?', idempotency_key: 'multi-3' },
      REQUESTER,
      turn2.case.case_id,
    );
    expect(turn3.case.assistant_thread?.depth).toBe(3);

    const storage = chainStorage([
      {
        storagePath: root.storagePath,
        caseId: root.caseId,
        runId: root.runId,
        answer: 'It changed because of PR #42.',
        toolCalls: [{ name: 'arbitra_search_cases' }],
      },
      {
        storagePath: turn1Result.storagePath,
        caseId: turn1.case.case_id,
        runId: turn1Result.runId,
        answer: 'Case A is urgent.',
        toolCalls: [{ name: 'arbitra_get_case' }],
      },
      {
        storagePath: turn2Result.storagePath,
        caseId: turn2.case.case_id,
        runId: turn2Result.runId,
        answer: 'Because it blocks the release.',
        toolCalls: [],
      },
    ]);

    const turns = await new AssistantFollowUpService(storage).loadContext(turn3.case);

    expect(turns).toEqual([
      {
        caseId: root.caseId,
        request: 'What changed?',
        answer: 'It changed because of PR #42.',
        toolTrace: JSON.stringify([{ name: 'arbitra_search_cases' }]),
      },
      {
        caseId: turn1.case.case_id,
        request: 'Which one is urgent?',
        answer: 'Case A is urgent.',
        toolTrace: JSON.stringify([{ name: 'arbitra_get_case' }]),
      },
      {
        caseId: turn2.case.case_id,
        request: 'Why is it urgent?',
        answer: 'Because it blocks the release.',
        toolTrace: JSON.stringify([]),
      },
    ]);
  });

  /**
   * A Clerk thread is a tree, not a line — one root can have two depth-1
   * children started from two different Google Chat threads in the same DM.
   * A depth-2
   * follow-up off ONE sibling must see only its own lineage (root + that
   * sibling), never the other branch.
   *
   * Reverting `loadContext` to the old depth-count filter —
   * `threadCases.filter((row) => row.case_id !== case_.case_id &&
   * (row.assistant_thread?.depth ?? 0) < link.depth)` followed by
   * `if (ancestors.length !== link.depth) throw ...` — fails this test: the
   * filter matches all 3 non-self cases at depth < 2 (root + both siblings),
   * so `ancestors.length` is 3 against an expected `link.depth` of 2 and the
   * old code throws `AssistantFollowUpError` instead of returning turns.
   */
  it('walks only its own lineage through a branched thread, excluding a sibling branch', async () => {
    const service = new AssistantIntakeService();
    const root = completeCaseWithResult('case_root_branch', { description: 'What changed?' });

    const siblingA = await service.intakeFollowUp(
      { text: 'Which one is urgent?', idempotency_key: 'branch-a' },
      REQUESTER,
      root.caseId,
    );
    const siblingAResult = completeCaseWithResult(siblingA.case.case_id);

    // A second depth-1 child of the SAME root, from a different Chat thread —
    // this is the sibling branch that must never show up in the other
    // branch's context.
    await service.intakeFollowUp(
      { text: 'Is the deploy blocked?', idempotency_key: 'branch-b' },
      REQUESTER,
      root.caseId,
    );

    const child = await service.intakeFollowUp(
      { text: 'Why is it urgent?', idempotency_key: 'branch-a-child' },
      REQUESTER,
      siblingA.case.case_id,
    );
    expect(child.case.assistant_thread?.depth).toBe(2);

    const storage = chainStorage([
      {
        storagePath: root.storagePath,
        caseId: root.caseId,
        runId: root.runId,
        answer: 'It changed because of PR #42.',
        toolCalls: [{ name: 'arbitra_search_cases' }],
      },
      {
        storagePath: siblingAResult.storagePath,
        caseId: siblingA.case.case_id,
        runId: siblingAResult.runId,
        answer: 'Case A is urgent.',
        toolCalls: [{ name: 'arbitra_get_case' }],
      },
    ]);

    const turns = await new AssistantFollowUpService(storage).loadContext(child.case);

    expect(turns).toEqual([
      {
        caseId: root.caseId,
        request: 'What changed?',
        answer: 'It changed because of PR #42.',
        toolTrace: JSON.stringify([{ name: 'arbitra_search_cases' }]),
      },
      {
        caseId: siblingA.case.case_id,
        request: 'Which one is urgent?',
        answer: 'Case A is urgent.',
        toolTrace: JSON.stringify([{ name: 'arbitra_get_case' }]),
      },
    ]);
  });

  it('fails closed when an earlier ancestor turn has gone missing from the thread', async () => {
    const service = new AssistantIntakeService();
    const root = completeCaseWithResult('case_root_gap', { description: 'What changed?' });
    const turn1 = await service.intakeFollowUp(
      { text: 'Which one is urgent?', idempotency_key: 'gap-1' },
      REQUESTER,
      root.caseId,
    );
    completeCaseWithResult(turn1.case.case_id);
    const turn2 = await service.intakeFollowUp(
      { text: 'Why is it urgent?', idempotency_key: 'gap-2' },
      REQUESTER,
      turn1.case.case_id,
    );

    // Corrupt the chain: turn 1 (an ancestor OTHER than the immediate parent
    // for a depth-2 follow-up) disappears.
    collectionStore('cases').delete(turn1.case.case_id);

    const neverReadStorage = {
      save: vi.fn(),
      delete: vi.fn(),
      read: vi.fn(async () => {
        throw new Error('should fail on the missing-turn check before any storage read');
      }),
    };
    await expect(
      new AssistantFollowUpService(neverReadStorage).loadContext(turn2.case),
    ).rejects.toMatchObject({ code: 'ASSISTANT_FOLLOW_UP_INVALID' });
  });

  /**
   * The parent-chain walk trusts `assistant_thread.parent_case_id`, which is
   * system-written and never expected to cycle — but the guard exists
   * because a walk with no bound would hang (or loop until Firestore quota)
   * on any data corruption that produces one. Simulate that corruption
   * directly: rewrite turn 1's own parent pointer to name turn 2, its own
   * child, so walking from turn 2 bounces 1 -> 2 -> 1 -> 2 forever without
   * the step-count guard in `loadContext`.
   */
  it('rejects a cyclic parent chain instead of hanging', async () => {
    const service = new AssistantIntakeService();
    const root = completeCaseWithResult('case_root_cycle', { description: 'What changed?' });
    const turn1 = await service.intakeFollowUp(
      { text: 'Which one is urgent?', idempotency_key: 'cycle-1' },
      REQUESTER,
      root.caseId,
    );
    completeCaseWithResult(turn1.case.case_id);
    const turn2 = await service.intakeFollowUp(
      { text: 'Why is it urgent?', idempotency_key: 'cycle-2' },
      REQUESTER,
      turn1.case.case_id,
    );

    const turn1Doc = collectionStore('cases').get(turn1.case.case_id)!;
    collectionStore('cases').set(turn1.case.case_id, {
      ...turn1Doc,
      assistant_thread: {
        ...(turn1Doc['assistant_thread'] as DocData),
        parent_case_id: turn2.case.case_id,
      },
    });

    const neverReadStorage = {
      save: vi.fn(),
      delete: vi.fn(),
      read: vi.fn(async () => {
        throw new Error('should fail on the cycle guard before any storage read');
      }),
    };
    await expect(
      new AssistantFollowUpService(neverReadStorage).loadContext(turn2.case),
    ).rejects.toMatchObject({
      code: 'ASSISTANT_FOLLOW_UP_INVALID',
      message: expect.stringContaining('cycle'),
    });
  });

  /**
   * Downgrading the old `ancestors.length !== link.depth` hard failure to a
   * `console.warn` (see the module doc above `loadContext`) left one shape
   * that check alone would have caught but the walk's own missing-ancestor
   * guard does not: a mid-chain ancestor's `assistant_thread` can survive
   * with a correct `depth` and `root_case_id` — so it still resolves as a
   * legitimate Case when the walk looks it up — while its OWN
   * `parent_case_id` is gone. The walk just stops at that ancestor instead
   * of reaching the root, and `assertPinnedFollowUpSources` cannot catch
   * the shortfall either: it checks each ancestor against its own child,
   * never against the thread's actual root. Without the post-loop
   * `ancestors[0].case_id === link.root_case_id` check, a depth-3
   * follow-up here would silently return 2 turns instead of 3 — a Clerk
   * conversation answered from a quietly truncated context, not a
   * rejected request.
   */
  it('rejects a chain that stops short of the root even though the ancestor it stops at still looks valid', async () => {
    const service = new AssistantIntakeService();
    const root = completeCaseWithResult('case_root_truncated', { description: 'What changed?' });

    const turn1 = await service.intakeFollowUp(
      { text: 'Which one is urgent?', idempotency_key: 'trunc-1' },
      REQUESTER,
      root.caseId,
    );
    completeCaseWithResult(turn1.case.case_id);

    const turn2 = await service.intakeFollowUp(
      { text: 'Why is it urgent?', idempotency_key: 'trunc-2' },
      REQUESTER,
      turn1.case.case_id,
    );
    completeCaseWithResult(turn2.case.case_id);

    const turn3 = await service.intakeFollowUp(
      { text: 'Who should fix it?', idempotency_key: 'trunc-3' },
      REQUESTER,
      turn2.case.case_id,
    );
    expect(turn3.case.assistant_thread?.depth).toBe(3);

    // Corrupt turn 1's OWN thread link: drop `parent_case_id` only. `depth`
    // (1) and `root_case_id` (the real root) stay correct, so turn 1 still
    // resolves as a legitimate ancestor when the walk reaches it — the walk
    // just has nowhere further to go from there.
    const turn1Doc = collectionStore('cases').get(turn1.case.case_id)!;
    const { parent_case_id: _dropped, ...turn1ThreadRest } = turn1Doc['assistant_thread'] as DocData;
    collectionStore('cases').set(turn1.case.case_id, {
      ...turn1Doc,
      assistant_thread: turn1ThreadRest,
    });

    const neverReadStorage = {
      save: vi.fn(),
      delete: vi.fn(),
      read: vi.fn(async () => {
        throw new Error('should fail on the root-reached check before any storage read');
      }),
    };
    await expect(
      new AssistantFollowUpService(neverReadStorage).loadContext(turn3.case),
    ).rejects.toMatchObject({ code: 'ASSISTANT_FOLLOW_UP_INVALID' });
  });
});

describe('AssistantIntakeService.intake — failure leaves nothing behind', () => {
  it('writes NOTHING when the commit fails — not even a partial case', async () => {
    failNextCommit = 'simulated commit failure';

    await expect(
      new AssistantIntakeService().intake({ text: 'Summarise the open cases' }, REQUESTER),
    ).rejects.toThrow('simulated commit failure');

    expect(storedCases()).toEqual([]);
    expect(storedEvents()).toEqual([]);
    expect(storedRuns()).toEqual([]);
    expect(commits).toEqual([]);
  });

  it('leaves no receipt behind either, so a retry with the same key still works', async () => {
    failNextCommit = 'simulated commit failure';
    const service = new AssistantIntakeService();

    await expect(
      service.intake({ text: 'Summarise the open cases', idempotency_key: 'k-1' }, REQUESTER),
    ).rejects.toThrow('simulated commit failure');
    expect(storedReceipts()).toEqual([]);

    const retry = await service.intake(
      { text: 'Summarise the open cases', idempotency_key: 'k-1' },
      REQUESTER,
    );
    expect(retry.replayed).toBe(false);
    expect(storedCases()).toHaveLength(1);
    expect(storedRuns()).toHaveLength(1);
    expect(storedReceipts()).toHaveLength(1);
  });
});

describe('AssistantIntakeService.intake — idempotency', () => {
  it('a repeated key yields exactly ONE case', async () => {
    const service = new AssistantIntakeService();
    const request = { text: 'Summarise the open cases', idempotency_key: 'msg-42' };

    const first = await service.intake(request, REQUESTER);
    const second = await service.intake(request, REQUESTER);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.case.case_id).toBe(first.case.case_id);
    expect(second.run_id).toBe(first.run_id);
    // A replay has nothing to dispatch — the first request already did.
    expect(second.run).toBeNull();

    expect(storedCases()).toHaveLength(1);
    expect(storedEvents()).toHaveLength(1);
    expect(storedRuns()).toHaveLength(1);
    expect(storedReceipts()).toHaveLength(1);
  });

  it('CONCURRENT requests with the same key still produce exactly one case', async () => {
    const service = new AssistantIntakeService();
    const request = { text: 'Summarise the open cases', idempotency_key: 'msg-42' };

    const results = await Promise.all([
      service.intake(request, REQUESTER),
      service.intake(request, REQUESTER),
      service.intake(request, REQUESTER),
    ]);

    expect(storedCases()).toHaveLength(1);
    expect(storedRuns()).toHaveLength(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.case.case_id)).size).toBe(1);
    // All three preflight receipt reads happened before any commit, so the
    // transaction's authoritative receipt re-check had to resolve the race.
    expect(transactionCount).toBe(3);
  });

  it('uses the preflight receipt fast path for a sequential replay', async () => {
    const service = new AssistantIntakeService();
    const request = { text: 'Summarise the open cases', idempotency_key: 'msg-42' };

    await service.intake(request, REQUESTER);
    commits.length = 0;
    await service.intake(request, REQUESTER);

    // A committed receipt is returned before quota aggregation or a new
    // transaction. The concurrent test above still proves the authoritative
    // in-transaction re-check handles two callers that both miss this read.
    expect(transactionCount).toBe(1);
    expect(commits).toEqual([]);
  });

  it('scopes the key by requester, so two users cannot collide on one key', async () => {
    collectionStore('projects').clear();
    seedClerkCore();
    const otherIds = clerkCoreIds(OTHER_USER);
    collectionStore('projects').set(otherIds.projectId, {
      project_id: otherIds.projectId,
      name: 'Clerk',
      owner_user_id: OTHER_USER,
      members: [OTHER_USER],
      reviewer_pool: [],
      tech_leads: [],
      default_rule_set_refs: [],
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    });
    collectionStore('repositories').set(otherIds.repositoryId, {
      repository_id: otherIds.repositoryId,
      project_id: otherIds.projectId,
      name: 'clerk-no-source-repository-placeholder',
      url: 'https://clerk-placeholder.invalid/no-source-repository',
      provider: 'other',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    });

    const service = new AssistantIntakeService();
    const mine = await service.intake({ text: 'mine', idempotency_key: 'shared' }, REQUESTER);
    const theirs = await service.intake({ text: 'theirs', idempotency_key: 'shared' }, OTHER_USER);

    expect(theirs.replayed).toBe(false);
    expect(theirs.case.case_id).not.toBe(mine.case.case_id);
    expect(storedCases()).toHaveLength(2);
  });

  it('keys a Google Chat message name through the same intake path', async () => {
    // The Chat entry point is not built yet. What has to be true already is
    // that it needs no second intake path: it supplies a channel, the message
    // name as the key, and its coordinates — nothing else.
    const service = new AssistantIntakeService();
    const request = {
      text: 'Summarise the open cases',
      channel: 'google_chat' as const,
      idempotency_key: 'spaces/AAA/messages/BBB',
      chat: {
        space_name: 'spaces/AAA',
        thread_name: 'spaces/AAA/threads/CCC',
        source_message_name: 'spaces/AAA/messages/BBB',
        chat_user_name: 'users/123',
        conversation_visibility: 'space' as const,
      },
    };

    const first = await service.intake(request, REQUESTER);
    const redelivered = await service.intake(request, REQUESTER);

    expect(first.case.source_type).toBe('google_chat');
    expect(first.case.assistant_context).toEqual({
      channel: 'google_chat',
      space_name: 'spaces/AAA',
      thread_name: 'spaces/AAA/threads/CCC',
      source_message_name: 'spaces/AAA/messages/BBB',
      chat_user_name: 'users/123',
      conversation_visibility: 'space',
      requester_user_id: REQUESTER,
      risk_level: 'low',
      policy_version: 'assistant_policy:v1',
      prompt_version: 'assistant_task:v1',
    });
    expect(redelivered.replayed).toBe(true);
    expect(storedCases()).toHaveLength(1);

    const receipt = storedReceipts()[0]!;
    expect(receipt['receipt_id']).toBe(
      assistantIntakeReceiptId('google_chat', REQUESTER, 'spaces/AAA/messages/BBB'),
    );
    expect(receipt['channel']).toBe('google_chat');
    expect(receipt['case_id']).toBe(first.case.case_id);
    expect(receipt['run_id']).toBe(first.run_id);
  });

  it('without a key, every request is a new case (and no receipt is written)', async () => {
    const service = new AssistantIntakeService();
    await service.intake({ text: 'Summarise the open cases' }, REQUESTER);
    await service.intake({ text: 'Summarise the open cases' }, REQUESTER);

    expect(storedCases()).toHaveLength(2);
    expect(storedReceipts()).toEqual([]);
  });

  it('derives the same receipt id for the same triple and different ids otherwise', () => {
    expect(assistantIntakeReceiptId('web', 'u1', 'k')).toBe(
      assistantIntakeReceiptId('web', 'u1', 'k'),
    );
    expect(assistantIntakeReceiptId('web', 'u1', 'k')).not.toBe(
      assistantIntakeReceiptId('google_chat', 'u1', 'k'),
    );
    expect(assistantIntakeReceiptId('web', 'u1', 'k')).not.toBe(
      assistantIntakeReceiptId('web', 'u2', 'k'),
    );
    expect(assistantIntakeReceiptId('web', 'u1', 'k')).toMatch(/^air_[0-9a-f]{32}$/);
  });
});

describe('AssistantIntakeService.intake — blueprint provenance (Slice B, #793)', () => {
  /**
   * `TaskBlueprintService.runNow` calls `intake` with `channel: 'blueprint'`
   * and a `blueprint` context; this suite exercises that same public
   * `intake()` contract directly (mirrors the existing Google Chat suite
   * above), rather than going through the blueprint service and its own
   * Firestore double (`task-blueprint-service.test.ts`).
   */
  function blueprintRequest(overrides: {
    idempotency_key: string;
    blueprint_version?: number;
    prompt_text?: string;
  }) {
    const promptText = overrides.prompt_text ?? 'Summarise open cases for me';
    return {
      text: promptText,
      channel: 'blueprint' as const,
      idempotency_key: overrides.idempotency_key,
      blueprint: {
        blueprint_id: 'bp_digest',
        blueprint_version: overrides.blueprint_version ?? 1,
        prompt_text: promptText,
      },
    };
  }

  it('stamps blueprint_id (flat) and blueprint_context (snapshot) onto the case, with manual source_type', async () => {
    const { case: created } = await new AssistantIntakeService().intake(
      blueprintRequest({ idempotency_key: 'blueprint:bp_digest:1:2026-08-06T08:00:00.000Z' }),
      REQUESTER,
    );

    expect(created.source_type).toBe('manual');
    expect(created.assistant_context?.blueprint_id).toBe('bp_digest');
    expect(created.assistant_context?.blueprint_context).toEqual({
      blueprint_id: 'bp_digest',
      blueprint_version: 1,
      prompt_text: 'Summarise open cases for me',
    });
  });

  it('a repeated (blueprint_id, version, occurrence) key replays — no second case', async () => {
    const service = new AssistantIntakeService();
    const request = blueprintRequest({
      idempotency_key: 'blueprint:bp_digest:1:2026-08-06T08:00:00.000Z',
    });

    const first = await service.intake(request, REQUESTER);
    const second = await service.intake(request, REQUESTER);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.case.case_id).toBe(first.case.case_id);
    expect(storedCases()).toHaveLength(1);

    const receipt = storedReceipts()[0]!;
    expect(receipt['receipt_id']).toBe(
      assistantIntakeReceiptId('blueprint', REQUESTER, request.idempotency_key),
    );
    expect(receipt['channel']).toBe('blueprint');
  });

  it('an edited blueprint (new version, new occurrence key) creates a NEW case without rewriting the old snapshot', async () => {
    const service = new AssistantIntakeService();

    const occurrenceOne = await service.intake(
      blueprintRequest({
        idempotency_key: 'blueprint:bp_digest:1:2026-08-06T08:00:00.000Z',
        blueprint_version: 1,
        prompt_text: 'v1 prompt',
      }),
      REQUESTER,
    );

    // The blueprint was edited (version bumped to 2, prompt changed) between
    // occurrences — exactly what `TaskBlueprintService.update` does. Intake
    // has no idea the row changed; it only ever sees what THIS request
    // carries, which is the whole point of stamping the snapshot at intake
    // time rather than re-reading the (mutate-in-place) blueprint later.
    const occurrenceTwo = await service.intake(
      blueprintRequest({
        idempotency_key: 'blueprint:bp_digest:2:2026-08-06T09:00:00.000Z',
        blueprint_version: 2,
        prompt_text: 'v2 prompt',
      }),
      REQUESTER,
    );

    expect(occurrenceTwo.case.case_id).not.toBe(occurrenceOne.case.case_id);
    expect(storedCases()).toHaveLength(2);

    const first = storedCases().find((c) => c.case_id === occurrenceOne.case.case_id)!;
    const second = storedCases().find((c) => c.case_id === occurrenceTwo.case.case_id)!;
    expect(first.assistant_context?.blueprint_context).toEqual({
      blueprint_id: 'bp_digest',
      blueprint_version: 1,
      prompt_text: 'v1 prompt',
    });
    expect(second.assistant_context?.blueprint_context).toEqual({
      blueprint_id: 'bp_digest',
      blueprint_version: 2,
      prompt_text: 'v2 prompt',
    });
  });
});

describe('AssistantIntakeService.intake — membership', () => {
  it('refuses a non-member BEFORE any write', async () => {
    seedClerkCore({ owner_user_id: OTHER_USER, members: [OTHER_USER] });

    await expect(
      new AssistantIntakeService().intake({ text: 'Summarise the open cases' }, REQUESTER),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

    expect(storedCases()).toEqual([]);
    expect(storedEvents()).toEqual([]);
    expect(storedRuns()).toEqual([]);
    expect(storedReceipts()).toEqual([]);
    // Not even a transaction was opened.
    expect(transactionCount).toBe(0);
  });

  it('accepts a reviewer-pool / tech-lead member (isEffectiveMember semantics)', async () => {
    seedClerkCore({ owner_user_id: OTHER_USER, members: [], reviewer_pool: [REQUESTER] });
    await expect(
      new AssistantIntakeService().intake({ text: 'a' }, REQUESTER),
    ).resolves.toBeDefined();

    seedClerkCore({ owner_user_id: OTHER_USER, members: [], tech_leads: [REQUESTER] });
    await expect(
      new AssistantIntakeService().intake({ text: 'b' }, REQUESTER),
    ).resolves.toBeDefined();
  });

  it('refuses again inside the transaction if membership is revoked mid-flight', async () => {
    const service = new AssistantIntakeService();
    const intake = service.intake({ text: 'Summarise the open cases' }, REQUESTER);
    // Revoke after the pre-flight read, before the transaction's own read.
    seedClerkCore({ owner_user_id: OTHER_USER, members: [OTHER_USER] });

    await expect(intake).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(storedCases()).toEqual([]);
    expect(storedRuns()).toEqual([]);
  });

  it('reports unprovisioned Clerk cores actionably instead of writing a case', async () => {
    store.delete('projects');
    store.delete('repositories');

    await expect(
      new AssistantIntakeService().intake({ text: 'Summarise the open cases' }, REQUESTER),
    ).rejects.toBeInstanceOf(ClerkCoreNotProvisionedError);
    expect(storedCases()).toEqual([]);
  });

  it('refuses when the project exists but the placeholder repository does not', async () => {
    collectionStore('repositories').clear();

    await expect(
      new AssistantIntakeService().intake({ text: 'Summarise the open cases' }, REQUESTER),
    ).rejects.toMatchObject({ code: 'CLERK_CORE_NOT_PROVISIONED' });
    expect(storedCases()).toEqual([]);
  });

  it('refuses a placeholder repository that was re-homed to another project', async () => {
    const repository = collectionStore('repositories').get(ids.repositoryId)!;
    collectionStore('repositories').set(ids.repositoryId, {
      ...repository,
      project_id: 'proj_somewhere_else',
    });

    await expect(
      new AssistantIntakeService().intake({ text: 'Summarise the open cases' }, REQUESTER),
    ).rejects.toMatchObject({ code: 'CLERK_CORE_MISCONFIGURED' });
    expect(storedCases()).toEqual([]);
    expect(transactionCount).toBe(0);
  });
});

describe('AssistantIntakeService.intake — per-user limits', () => {
  it('uses the documented defaults', () => {
    expect(resolveAssistantIntakeLimits()).toEqual({
      maxActivePerUser: 10,
      dailyLimit: 30,
      maxInputChars: 8000,
    });
  });

  it('falls back to the default when an override is not a positive integer', () => {
    process.env['ARBITRA_ASSISTANT_MAX_ACTIVE_PER_USER'] = '0';
    process.env['ARBITRA_ASSISTANT_DAILY_LIMIT'] = 'many';
    expect(resolveAssistantIntakeLimits()).toEqual(
      expect.objectContaining({ maxActivePerUser: 10, dailyLimit: 30 }),
    );
  });

  it('accepts the 8000th character and refuses the 8001st', async () => {
    const service = new AssistantIntakeService();

    await expect(service.intake({ text: 'x'.repeat(8000) }, REQUESTER)).resolves.toBeDefined();
    await expect(service.intake({ text: 'x'.repeat(8001) }, REQUESTER)).rejects.toMatchObject({
      code: 'ASSISTANT_INTAKE_LIMIT',
      statusCode: 429,
      details: expect.objectContaining({ limit: 'input_chars', max: 8000 }),
    });

    expect(storedCases()).toHaveLength(1);
  });

  it('measures the input limit against the configured value', async () => {
    process.env['ARBITRA_ASSISTANT_MAX_INPUT_CHARS'] = '10';
    const service = new AssistantIntakeService();

    await expect(service.intake({ text: 'x'.repeat(10) }, REQUESTER)).resolves.toBeDefined();
    await expect(service.intake({ text: 'x'.repeat(11) }, REQUESTER)).rejects.toMatchObject({
      details: expect.objectContaining({ limit: 'input_chars', max: 10 }),
    });
  });

  it('refuses an empty request outright', async () => {
    await expect(
      new AssistantIntakeService().intake({ text: '   \n  ' }, REQUESTER),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(storedCases()).toEqual([]);
  });

  it('accepts the 10th active task and refuses the 11th', async () => {
    for (let i = 0; i < 9; i += 1) {
      seedCase({ case_id: `case-active-${i}`, status: 'in_build' });
    }
    const service = new AssistantIntakeService();

    // 9 active → the 10th is allowed.
    await expect(service.intake({ text: 'number ten' }, REQUESTER)).resolves.toBeDefined();
    // Now 10 active → refused at the boundary.
    await expect(service.intake({ text: 'number eleven' }, REQUESTER)).rejects.toMatchObject({
      code: 'ASSISTANT_INTAKE_LIMIT',
      details: expect.objectContaining({ limit: 'active_per_user', active: 10, max: 10 }),
    });
    expect(storedCases()).toHaveLength(10);
  });

  it('honors ARBITRA_ASSISTANT_MAX_ACTIVE_PER_USER', async () => {
    process.env['ARBITRA_ASSISTANT_MAX_ACTIVE_PER_USER'] = '2';
    seedCase({ case_id: 'case-a', status: 'open' });
    seedCase({ case_id: 'case-b', status: 'in_review' });

    await expect(
      new AssistantIntakeService().intake({ text: 'third' }, REQUESTER),
    ).rejects.toMatchObject({ details: expect.objectContaining({ limit: 'active_per_user' }) });
  });

  it('names the blocking cases so "let one finish" is actionable', async () => {
    process.env['ARBITRA_ASSISTANT_MAX_ACTIVE_PER_USER'] = '2';
    seedCase({ case_id: 'case-blocking-a', status: 'open' });
    seedCase({ case_id: 'case-blocking-b', status: 'in_build' });
    // Another user's active task, and a terminal one of the requester's own:
    // neither occupies a slot, so neither may appear in the details.
    seedCase({ case_id: 'case-other-user', status: 'in_build', owner_user_id: OTHER_USER });
    seedCase({ case_id: 'case-done', status: 'done' });

    await expect(
      new AssistantIntakeService().intake({ text: 'third' }, REQUESTER),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        limit: 'active_per_user',
        case_ids: ['case-blocking-a', 'case-blocking-b'],
      }),
    });
  });

  it('replays a keyed request at the active-task quota instead of returning 429', async () => {
    const service = new AssistantIntakeService();
    const request = { text: 'the original task', idempotency_key: 'active-quota-replay' };
    const first = await service.intake(request, REQUESTER);
    for (let i = 0; i < 9; i += 1) {
      seedCase({ case_id: `case-active-replay-${i}`, status: 'in_build' });
    }

    const replay = await service.intake(request, REQUESTER);

    expect(replay).toMatchObject({ replayed: true, case: { case_id: first.case.case_id } });
    expect(storedCases()).toHaveLength(10);
  });

  it('still returns 429 for a genuinely new keyed request at the active-task quota', async () => {
    for (let i = 0; i < 10; i += 1) {
      seedCase({ case_id: `case-active-new-${i}`, status: 'in_build' });
    }

    await expect(
      new AssistantIntakeService().intake(
        { text: 'a different task', idempotency_key: 'new-at-active-quota' },
        REQUESTER,
      ),
    ).rejects.toMatchObject({
      code: 'ASSISTANT_INTAKE_LIMIT',
      details: expect.objectContaining({ limit: 'active_per_user', active: 10, max: 10 }),
    });
  });

  it('counts only this user, only assistant tasks, and only non-terminal live cases', async () => {
    process.env['ARBITRA_ASSISTANT_MAX_ACTIVE_PER_USER'] = '1';
    seedCase({ case_id: 'case-other-user', owner_user_id: OTHER_USER, status: 'open' });
    seedCase({ case_id: 'case-other-type', case_type: 'bugfix', status: 'open' });
    seedCase({ case_id: 'case-done', status: 'done' });
    seedCase({ case_id: 'case-rejected', status: 'rejected' });
    seedCase({ case_id: 'case-deleted', status: 'open', deleted_at: '2026-08-02T00:00:00.000Z' });

    // None of the five counts as an active assistant task for this user.
    await expect(
      new AssistantIntakeService().intake({ text: 'still allowed' }, REQUESTER),
    ).resolves.toBeDefined();
  });

  it('accepts the 30th task today and refuses the 31st', async () => {
    // Terminal so the active limit cannot fire first — which also shows the
    // daily count ignores status.
    for (let i = 0; i < 29; i += 1) {
      seedCase({ case_id: `case-today-${i}`, status: 'done' });
    }
    const service = new AssistantIntakeService();

    await expect(service.intake({ text: 'number thirty' }, REQUESTER)).resolves.toBeDefined();
    await expect(service.intake({ text: 'number thirtyone' }, REQUESTER)).rejects.toMatchObject({
      code: 'ASSISTANT_INTAKE_LIMIT',
      details: expect.objectContaining({ limit: 'daily', today: 30, max: 30 }),
    });
    expect(storedCases()).toHaveLength(30);
  });

  it('counts soft-deleted cases towards the daily limit, so deleting cannot reset it', async () => {
    process.env['ARBITRA_ASSISTANT_DAILY_LIMIT'] = '2';
    seedCase({ case_id: 'case-today-live', status: 'done' });
    seedCase({
      case_id: 'case-today-deleted',
      status: 'done',
      deleted_at: '2026-08-03T09:00:00.000Z',
    });

    await expect(
      new AssistantIntakeService().intake({ text: 'third today' }, REQUESTER),
    ).rejects.toMatchObject({ details: expect.objectContaining({ limit: 'daily' }) });
  });

  it('replays a keyed request at the daily quota instead of returning 429', async () => {
    const service = new AssistantIntakeService();
    const request = { text: 'the original task', idempotency_key: 'daily-quota-replay' };
    const first = await service.intake(request, REQUESTER);
    for (let i = 0; i < 29; i += 1) {
      seedCase({ case_id: `case-daily-replay-${i}`, status: 'done' });
    }

    const replay = await service.intake(request, REQUESTER);

    expect(replay).toMatchObject({ replayed: true, case: { case_id: first.case.case_id } });
    expect(storedCases()).toHaveLength(30);
  });

  it('ignores tasks created before today', async () => {
    process.env['ARBITRA_ASSISTANT_DAILY_LIMIT'] = '1';
    seedCase({
      case_id: 'case-yesterday',
      status: 'done',
      created_at: '2020-01-01T23:59:59.999Z',
    });

    await expect(
      new AssistantIntakeService().intake({ text: 'first today' }, REQUESTER),
    ).resolves.toBeDefined();
  });

  it('checks membership before the limits, so a non-member is never rate-limited', async () => {
    process.env['ARBITRA_ASSISTANT_MAX_ACTIVE_PER_USER'] = '1';
    seedCase({ case_id: 'case-active', status: 'open' });
    seedClerkCore({ owner_user_id: OTHER_USER, members: [OTHER_USER] });

    await expect(
      new AssistantIntakeService().intake({ text: 'Summarise the open cases' }, REQUESTER),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('AssistantIntakeService — field-default parity with CaseService.createCase', () => {
  /**
   * The whole reason this service exists is that `createCase` writes the case
   * and its event as two independent writes. Everything else about the case
   * document must stay identical, so this compares the two persisted documents
   * field by field. Adding a default to `createCase` without adding it here
   * fails this test rather than silently producing divergent assistant cases.
   */
  it('persists the same case document CaseService.createCase would have', async () => {
    const intakeResult = await new AssistantIntakeService().intake(
      { text: 'Summarise the open cases for me' },
      REQUESTER,
    );
    const fromIntake = storedCases().find((c) => c.case_id === intakeResult.case.case_id)!;

    // The same CreateCaseInput, replayed through CaseService.
    const input: CreateCaseInput = {
      title: fromIntake.title,
      description: fromIntake.description,
      source_type: fromIntake.source_type,
      source_ref: fromIntake.source_ref,
      project_id: fromIntake.project_id,
      repository_id: fromIntake.repository_id,
      validation_track: fromIntake.validation_track,
      risk_level: fromIntake.risk_level,
      priority: fromIntake.priority,
      case_type: fromIntake.case_type,
      assistant_context: fromIntake.assistant_context,
    };
    const viaCaseService = await new CaseService().createCase(input, REQUESTER);
    const fromCaseService = storedCases().find((c) => c.case_id === viaCaseService.case_id)!;

    // Only the identity and the timestamps may differ.
    const normalize = (c: Case) => ({
      ...c,
      case_id: '<id>',
      created_at: '<ts>',
      updated_at: '<ts>',
    });
    expect(normalize(fromIntake)).toEqual(normalize(fromCaseService));

    // Guard the comparison itself: if either document ever loses these, the
    // equality above could pass on two equally-wrong documents.
    for (const doc of [fromIntake, fromCaseService]) {
      expect(doc.status).toBe('open');
      expect(doc.decision_ready).toBe(false);
      expect(doc.deleted_at).toBeNull();
      expect(doc.deleted_by).toBeNull();
      expect(doc.active_rule_set_refs).toEqual([]);
      expect(doc.knowledge_context_refs).toEqual([]);
      expect(doc.jira_refs).toEqual([]);
      expect(doc.owner_user_id).toBe(REQUESTER);
    }
  });

  it('writes the same document as CaseService.createCase for an input that sets EVERY optional field', async () => {
    /**
     * The preceding test compares the two persisted documents for the input
     * intake actually produces. That input leaves most of `CreateCaseInput`'s
     * optional fields unset — and a field NEITHER builder maps looks identical
     * in both documents, so the comparison passes while the field is silently
     * dropped on both paths. This drives every optional field at once and
     * compares the documents AND their key sets, so a default that one builder
     * writes and the other does not fails here.
     *
     * `buildCaseDocument` is called directly: intake constructs its own
     * `CreateCaseInput` and cannot be made to carry these fields, and the unit
     * under comparison is the builder, not the transaction around it. The
     * builder's output is put through `persistable` first so both sides are
     * compared as Firestore would store them (`ignoreUndefinedProperties`
     * drops undefined-valued keys).
     */
    const input: CreateCaseInput = {
      title: 'Every optional field',
      description: 'Populates every optional CreateCaseInput field at once.',
      source_type: 'manual',
      source_ref: 'src-ref-1',
      project_id: ids.projectId,
      // Already `repo_`-shaped, so `createCase`'s slug resolution is a no-op
      // and cannot introduce a difference of its own.
      repository_id: ids.repositoryId,
      // Explicit, so `createCase`'s project-default lookup is a no-op too.
      validation_track: 'manual',
      risk_level: 'high',
      priority: 'urgent',
      // `assistant_task` produces no code, so `assertBranchAllowsCaseType`
      // accepts the branch below.
      case_type: 'assistant_task',
      assistant_context: {
        channel: 'google_chat',
        conversation_visibility: 'space',
        requester_user_id: REQUESTER,
        space_name: 'spaces/AAA',
        thread_name: 'spaces/AAA/threads/BBB',
        source_message_name: 'spaces/AAA/messages/CCC',
        chat_user_name: 'users/123',
        risk_level: 'high',
        policy_version: 'assistant_policy:v1',
        prompt_version: 'assistant_task:v1',
      },
      current_branch: 'feat/parity',
      current_pr_ref: 'https://github.com/org/repo/pull/1',
      jira_refs: ['ARB-1', 'ARB-2'],
      assigned_reviewer_id: 'usr_reviewer',
      active_rule_set_refs: ['rs_parity'],
      knowledge_context_refs: ['ka_parity'],
      // Not case-document fields: processed separately (artifacts / git
      // detection) and expected in NEITHER document.
      attachments: [{ filename: 'a.txt', content_type: 'text/plain', data: 'YQ==' }],
      git_context: { branch: 'feat/parity', commit_sha: 'abc123' },
    };

    const viaCaseService = await new CaseService().createCase(input, REQUESTER);
    const fromCaseService = storedCases().find((c) => c.case_id === viaCaseService.case_id)!;

    // Same input, same actor, same timestamp — only the id may differ.
    const fromBuilder = persistable(
      buildCaseDocument(input, REQUESTER, 'case-parity-builder', fromCaseService.created_at),
    ) as unknown as Case;

    const normalize = (c: Case) => ({ ...c, case_id: '<id>' });
    expect(normalize(fromBuilder)).toEqual(normalize(fromCaseService));
    expect(Object.keys(fromBuilder).sort()).toEqual(Object.keys(fromCaseService).sort());

    // The optional fields that DO reach the document must actually have landed,
    // or the equality above would be comparing two equally-empty documents.
    for (const doc of [fromBuilder, fromCaseService]) {
      expect(doc.assigned_reviewer_id).toBe('usr_reviewer');
      expect(doc.current_branch).toBe('feat/parity');
      expect(doc.current_pr_ref).toBe('https://github.com/org/repo/pull/1');
      expect(doc.active_rule_set_refs).toEqual(['rs_parity']);
      expect(doc.knowledge_context_refs).toEqual(['ka_parity']);
      expect(doc.assistant_context?.space_name).toBe('spaces/AAA');
      expect(doc.validation_track).toBe('manual');
      expect(doc.source_ref).toBe('src-ref-1');
    }

    // `jira_refs` reaches BOTH documents. It used to reach neither, which made
    // the two builders agree by both dropping it; asserting the value here
    // fails if either builder stops writing it.
    for (const doc of [fromBuilder, fromCaseService]) {
      expect(doc.jira_refs).toEqual(['ARB-1', 'ARB-2']);
    }

    // Fields BOTH builders drop, pinned so they cannot diverge silently.
    // Neither is a case-document field: they are processed separately.
    for (const doc of [fromBuilder, fromCaseService] as unknown as Record<string, unknown>[]) {
      expect('attachments' in doc).toBe(false);
      expect('git_context' in doc).toBe(false);
    }
  });
});

describe('intake helpers', () => {
  it('elides an over-long title without touching the description', () => {
    const long = 'w'.repeat(200);
    expect(deriveTitle(long)).toHaveLength(120);
    expect(deriveTitle(long).endsWith('…')).toBe(true);
  });

  it('collapses whitespace and skips leading blank lines', () => {
    expect(deriveTitle('\n\n  Fix   the   thing  \nmore detail')).toBe('Fix the thing');
  });

  it('starts the daily window at midnight UTC', () => {
    expect(startOfUtcDay(new Date('2026-08-03T23:59:59.999Z'))).toBe('2026-08-03T00:00:00.000Z');
    expect(startOfUtcDay(new Date('2026-08-03T00:00:00.000Z'))).toBe('2026-08-03T00:00:00.000Z');
  });
});
