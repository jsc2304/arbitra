import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Case, CaseEvent, Run } from '@arbitra/shared';

/**
 * Cancellation is a concurrency boundary, not a status-label helper. These
 * tests exercise the real coordinator service, transition core, state machine,
 * precondition evaluator, repositories and event service against a Firestore
 * double that preserves the database properties the boundary depends on:
 *
 * - every transaction applies all staged writes or none of them;
 * - every transaction reads before it writes;
 * - a document can be mutated only once per commit; and
 * - a replay observes the previous commit instead of a stale fixture.
 *
 * The only mocked product dependency is the notification side effect. No
 * cancellation decision, transition, event or reconciliation result is
 * supplied by a test double.
 */

type DocData = Record<string, unknown>;

const DELETE_SENTINEL = '<<field-deleted>>';
const FIXED_NOW = '2026-08-05T09:30:00.000Z';
const REQUESTER = 'usr_requester';
const ADMIN = 'usr_admin';
const STRANGER = 'usr_stranger';
const CASE_ID = 'case-clerk-cancel';

const store = new Map<string, Map<string, DocData>>();
/** One entry per committed transaction, containing every document it wrote. */
const commits: string[][] = [];

function collectionStore(name: string): Map<string, DocData> {
  let existing = store.get(name);
  if (!existing) {
    existing = new Map();
    store.set(name, existing);
  }
  return existing;
}

/** Mimics Firestore's ignoreUndefinedProperties setting. */
function persistable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface Filter {
  field: string;
  op: '==' | 'in';
  value: unknown;
}

function matches(data: DocData, filters: Filter[]): boolean {
  return filters.every(({ field, op, value }) => {
    const actual = data[field] ?? null;
    if (op === '==') return actual === (value ?? null);
    return (value as unknown[]).includes(actual);
  });
}

class FakeQuery {
  constructor(
    readonly collectionName: string,
    protected readonly filters: Filter[] = [],
  ) {}

  where(field: string, op: Filter['op'], value: unknown): FakeQuery {
    return new FakeQuery(this.collectionName, [...this.filters, { field, op, value }]);
  }

  orderBy(): FakeQuery {
    return this;
  }

  limit(): FakeQuery {
    return this;
  }

  async get() {
    const docs = [...collectionStore(this.collectionName).entries()]
      .filter(([, data]) => matches(data, this.filters))
      .map(([id, data]) => ({ id, exists: true, data: () => data }));
    return { empty: docs.length === 0, docs };
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
    const data = collectionStore(this.collectionName).get(this.id);
    return { id: this.id, exists: data !== undefined, data: () => data };
  }

  async set(data: DocData) {
    collectionStore(this.collectionName).set(this.id, persistable(data));
  }

  async merge(patch: DocData) {
    const current = collectionStore(this.collectionName).get(this.id) ?? {};
    const next: DocData = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === DELETE_SENTINEL) delete next[key];
      else next[key] = value;
    }
    collectionStore(this.collectionName).set(this.id, persistable(next));
  }
}

class FakeCollection extends FakeQuery {
  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.collectionName, id);
  }
}

type ReadableRef = FakeDocRef | FakeQuery;
type StagedWrite = { ref: FakeDocRef; op: 'create' | 'set' | 'update'; data: DocData };

const fakeDb = {
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const writes: StagedWrite[] = [];
    const tx = {
      get: async (ref: ReadableRef) => {
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
    const paths = writes.map((write) => write.ref.path);
    if (new Set(paths).size !== paths.length) {
      throw new Error(`Firestore rejects multiple mutations of one document: ${paths.join(', ')}`);
    }
    for (const write of writes) {
      if (write.op === 'create' && collectionStore(write.ref.collectionName).has(write.ref.id)) {
        throw new Error(`ALREADY_EXISTS: ${write.ref.path}`);
      }
    }
    for (const write of writes) {
      if (write.op === 'update') await write.ref.merge(write.data);
      else await write.ref.set(write.data);
    }
    if (paths.length > 0) commits.push(paths);
    return result;
  },
};

const collections = {
  cases: () => new FakeCollection('cases'),
  activeCases: () => new FakeQuery('cases').where('deleted_at', '==', null),
  caseEvents: () => new FakeCollection('case_events'),
  runs: () => new FakeCollection('runs'),
  findings: () => new FakeCollection('findings'),
  ruleResults: () => new FakeCollection('rule_results'),
  evidence: () => new FakeCollection('evidence'),
  decisions: () => new FakeCollection('decisions'),
  users: () => new FakeCollection('users'),
};

vi.mock('../../lib/firestore.js', () => ({ getDb: () => fakeDb, collections }));

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => DELETE_SENTINEL },
}));

vi.mock('../notification/event-notifier.js', () => ({
  EventNotifier: class {
    async onCaseEvent() {}
  },
}));

const {
  AssistantCancellationConflictError,
  AssistantCancellationService,
} = await import('./assistant-cancellation-service.js');

function baseCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: CASE_ID,
    title: 'Which cases are open?',
    description: 'Read the current open cases.',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_clerk_test',
    repository_id: 'repo_clerk_test',
    owner_user_id: REQUESTER,
    status: 'open',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    case_type: 'assistant_task',
    assistant_context: {
      channel: 'web',
      conversation_visibility: 'direct',
      requester_user_id: REQUESTER,
      risk_level: 'low',
      policy_version: 'assistant_policy:v1',
      prompt_version: 'assistant_task:v1',
    },
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-08-05T09:00:00.000Z',
    updated_at: '2026-08-05T09:00:00.000Z',
    deleted_at: null,
    deleted_by: null,
    ...overrides,
  };
}

function baseRun(
  runId: string,
  status: Run['status'],
  overrides: Partial<Run> = {},
): Run {
  return {
    run_id: runId,
    case_id: CASE_ID,
    run_type: 'assistant_task_run',
    trigger_source: 'assistant-intake:web',
    status,
    input_refs: [],
    output_refs: [],
    assistant_policy_state: 'unbound',
    attempt: 1,
    created_at: '2026-08-05T09:00:00.000Z',
    updated_at: '2026-08-05T09:00:00.000Z',
    ...(status === 'running'
      ? {
          started_at: '2026-08-05T09:00:05.000Z',
          worker_id: `worker-${runId}`,
          lease_expires_at: '2026-08-05T09:35:00.000Z',
        }
      : {}),
    ...overrides,
  };
}

function seedCase(case_: Case, runs: Run[], users: Record<string, string[]> = {}): void {
  collectionStore('cases').set(case_.case_id, persistable(case_) as DocData);
  for (const run of runs) {
    collectionStore('runs').set(run.run_id, persistable(run) as DocData);
  }
  collectionStore('users').set(REQUESTER, { user_id: REQUESTER, roles: [] });
  collectionStore('users').set(ADMIN, { user_id: ADMIN, roles: ['admin'] });
  collectionStore('users').set(STRANGER, { user_id: STRANGER, roles: [] });
  for (const [userId, roles] of Object.entries(users)) {
    collectionStore('users').set(userId, { user_id: userId, roles });
  }
}

function stored<T>(collection: string, id: string): T {
  return collectionStore(collection).get(id) as T;
}

function events(caseId = CASE_ID): CaseEvent[] {
  return [...collectionStore('case_events').values()]
    .filter((event) => event['case_id'] === caseId) as unknown as CaseEvent[];
}

function cancellationEvents(runId?: string): CaseEvent[] {
  return events().filter((event) =>
    event.type === 'run_cancelled'
      && (runId === undefined || event.payload['run_id'] === runId),
  );
}

function service(): InstanceType<typeof AssistantCancellationService> {
  return new AssistantCancellationService({ now: () => new Date(FIXED_NOW) });
}

beforeEach(() => {
  store.clear();
  commits.length = 0;
});

describe('AssistantCancellationService.cancel', () => {
  it('atomically rejects the Case and cancels the exact active target plus sorted siblings under one revision', async () => {
    const case_ = baseCase({ status: 'in_build' });
    // Deliberately insert out of id order: Firestore query order is not stable.
    const target = baseRun('run-z-target', 'running', { attempt: 3 });
    const pendingSibling = baseRun('run-a-pending', 'pending', {
      awaiting_claim: true,
      attempt: 4,
    });
    const runningSibling = baseRun('run-m-running', 'running', { attempt: 2 });
    const completed = baseRun('run-b-completed', 'completed', {
      attempt: 1,
      finished_at: '2026-08-05T09:20:00.000Z',
    });
    seedCase(case_, [target, pendingSibling, runningSibling, completed]);

    const result = await service().cancel(case_.case_id, REQUESTER, target.run_id);

    expect(result).toMatchObject({
      target_run_id: target.run_id,
      revision: 1,
      run_ids: ['run-a-pending', 'run-m-running', 'run-z-target'],
      pending_reconciliation_run_ids: ['run-m-running', 'run-z-target'],
      replayed: false,
    });

    const storedCase = stored<Case>('cases', case_.case_id);
    expect(storedCase.status).toBe('rejected');
    expect(storedCase.assistant_cancel_intent).toEqual({
      revision: 1,
      requested_at: FIXED_NOW,
      requested_by: REQUESTER,
    });
    expect(result.case.assistant_cancel_intent).toEqual(storedCase.assistant_cancel_intent);

    for (const runId of result.run_ids) {
      const run = stored<Run>('runs', runId);
      expect(run.status).toBe('cancelled');
      expect(run.assistant_cancel_intent).toEqual(storedCase.assistant_cancel_intent);
      expect(run.worker_id).toBeUndefined();
      expect(run.lease_expires_at).toBeUndefined();
      expect(run.awaiting_claim).toBeUndefined();
    }
    expect(stored<Run>('runs', completed.run_id)).toEqual(completed);

    const pending = stored<Run>('runs', pendingSibling.run_id);
    expect(pending.assistant_cancel_reconcile_pending).toBeUndefined();
    expect(pending.assistant_cancel_receipt).toMatchObject({
      revision: 1,
      reconciled_by: 'cancel_service',
      usage_status: 'complete',
      trace_status: 'recorded',
    });
    const pendingEvent = cancellationEvents(pendingSibling.run_id);
    expect(pendingEvent).toHaveLength(1);
    expect(pendingEvent[0]).toMatchObject({
      actor_id: 'system:clerk',
      payload: {
        run_id: pendingSibling.run_id,
        cancel_revision: 1,
        usage_status: 'complete',
        trace_status: 'recorded',
        tool_calls: 0,
        tool_call_records: [],
        steps: 0,
        total_tokens: 0,
      },
    });
    expect(pending.assistant_cancel_receipt?.event_id).toBe(pendingEvent[0]?.event_id);

    for (const runId of [runningSibling.run_id, target.run_id]) {
      const run = stored<Run>('runs', runId);
      expect(run.assistant_cancel_reconcile_pending).toBe(true);
      expect(run.assistant_cancel_receipt).toBeUndefined();
      expect(cancellationEvents(runId)).toHaveLength(0);
    }

    const transitionEvent = events().find((event) => event.type === 'assistant_task_cancelled');
    expect(transitionEvent).toMatchObject({
      actor_id: REQUESTER,
      payload: {
        from_status: 'in_build',
        to_status: 'rejected',
        cancel_revision: 1,
        requested_at: FIXED_NOW,
        requested_by: REQUESTER,
        run_ids: ['run-a-pending', 'run-m-running', 'run-z-target'],
        pending_run_ids: ['run-a-pending'],
        running_run_ids: ['run-m-running', 'run-z-target'],
      },
    });

    // Case, transition event, zero-work receipt event and all active Runs are
    // one commit. A non-transactional implementation would leave >1 entries.
    expect(commits).toHaveLength(1);
    expect(commits[0]).toHaveLength(6);
    expect(commits[0]).toEqual(expect.arrayContaining([
      `cases/${case_.case_id}`,
      `runs/${pendingSibling.run_id}`,
      `runs/${runningSibling.run_id}`,
      `runs/${target.run_id}`,
    ]));
    expect(commits[0]?.filter((path) => path.startsWith('case_events/'))).toHaveLength(2);
  });

  it('rejects a stale selected attempt when a newer attempt is active and writes nothing', async () => {
    const case_ = baseCase({ status: 'in_build' });
    const staleTarget = baseRun('run-old', 'failed', {
      attempt: 1,
      finished_at: '2026-08-05T09:10:00.000Z',
    });
    const newer = baseRun('run-new', 'running', { attempt: 2 });
    seedCase(case_, [staleTarget, newer]);

    const before = persistable({
      case: stored<Case>('cases', case_.case_id),
      old: stored<Run>('runs', staleTarget.run_id),
      newer: stored<Run>('runs', newer.run_id),
    });

    await expect(service().cancel(case_.case_id, REQUESTER, staleTarget.run_id)).rejects.toMatchObject({
      name: 'AssistantCancellationConflictError',
      code: 'ASSISTANT_CANCELLATION_CONFLICT',
      statusCode: 409,
      details: {
        target_run_id: staleTarget.run_id,
        target_status: 'failed',
        active_run_ids: [newer.run_id],
      },
    });
    expect({
      case: stored<Case>('cases', case_.case_id),
      old: stored<Run>('runs', staleTarget.run_id),
      newer: stored<Run>('runs', newer.run_id),
    }).toEqual(before);
    expect(events()).toEqual([]);
    expect(commits).toEqual([]);
  });

  it('replays the recorded cancellation without another transition, event or Run write', async () => {
    const case_ = baseCase();
    const target = baseRun('run-replay', 'pending', { awaiting_claim: true });
    seedCase(case_, [target]);
    const cancellation = service();

    const first = await cancellation.cancel(case_.case_id, REQUESTER, target.run_id);
    const firstEvents = persistable(events());
    const firstCommits = persistable(commits);
    const firstCase = persistable(stored<Case>('cases', case_.case_id));
    const firstRun = persistable(stored<Run>('runs', target.run_id));

    const replay = await cancellation.cancel(case_.case_id, REQUESTER, target.run_id);

    expect(replay).toMatchObject({
      target_run_id: target.run_id,
      revision: first.revision,
      run_ids: [target.run_id],
      pending_reconciliation_run_ids: [],
      replayed: true,
    });
    expect(replay.case).toEqual(first.case);
    expect(events()).toEqual(firstEvents);
    expect(commits).toEqual(firstCommits);
    expect(stored<Case>('cases', case_.case_id)).toEqual(firstCase);
    expect(stored<Run>('runs', target.run_id)).toEqual(firstRun);
    expect(events().filter((event) => event.type === 'assistant_task_cancelled')).toHaveLength(1);
    expect(cancellationEvents(target.run_id)).toHaveLength(1);
  });

  it('loses to a completed task and leaves the terminal result untouched', async () => {
    const case_ = baseCase({ status: 'done' });
    const target = baseRun('run-completed', 'completed', {
      finished_at: '2026-08-05T09:20:00.000Z',
      summary: 'The answer completed first.',
      token_usage: {
        prompt_tokens: 20,
        completion_tokens: 5,
        total_tokens: 25,
        model: 'test-model',
      },
    });
    seedCase(case_, [target]);

    await expect(service().cancel(case_.case_id, REQUESTER, target.run_id)).rejects.toEqual(
      expect.objectContaining({
        name: 'AssistantCancellationConflictError',
        code: 'ASSISTANT_CANCELLATION_CONFLICT',
        statusCode: 409,
        details: { case_id: case_.case_id, status: 'done' },
      }),
    );
    expect(stored<Case>('cases', case_.case_id)).toEqual(case_);
    expect(stored<Run>('runs', target.run_id)).toEqual(target);
    expect(events()).toEqual([]);
    expect(commits).toEqual([]);
  });

  it('allows the requester and an admin, while denying an unrelated user before writes', async () => {
    const requesterCase = baseCase({ case_id: 'case-requester' });
    const requesterRun = baseRun('run-requester', 'pending', {
      case_id: requesterCase.case_id,
      awaiting_claim: true,
    });
    seedCase(requesterCase, [requesterRun]);
    const requesterResult = await service().cancel(
      requesterCase.case_id,
      REQUESTER,
      requesterRun.run_id,
    );
    expect(requesterResult.case.status).toBe('rejected');
    expect(requesterResult.case.assistant_cancel_intent?.requested_by).toBe(REQUESTER);

    const adminCase = baseCase({ case_id: 'case-admin' });
    const adminRun = baseRun('run-admin', 'pending', {
      case_id: adminCase.case_id,
      awaiting_claim: true,
    });
    seedCase(adminCase, [adminRun]);
    const adminResult = await service().cancel(adminCase.case_id, ADMIN, adminRun.run_id);
    expect(adminResult.case.status).toBe('rejected');
    expect(adminResult.case.assistant_cancel_intent?.requested_by).toBe(ADMIN);

    const strangerCase = baseCase({ case_id: 'case-stranger' });
    const strangerRun = baseRun('run-stranger', 'pending', {
      case_id: strangerCase.case_id,
      awaiting_claim: true,
    });
    seedCase(strangerCase, [strangerRun]);
    const commitsBeforeDenial = persistable(commits);
    const eventsBeforeDenial = persistable([...collectionStore('case_events').values()]);

    await expect(
      service().cancel(strangerCase.case_id, STRANGER, strangerRun.run_id),
    ).rejects.toMatchObject({
      name: 'ForbiddenError',
      code: 'FORBIDDEN',
      statusCode: 403,
      details: { case_id: strangerCase.case_id },
    });
    expect(stored<Case>('cases', strangerCase.case_id)).toEqual(strangerCase);
    expect(stored<Run>('runs', strangerRun.run_id)).toEqual(strangerRun);
    expect(commits).toEqual(commitsBeforeDenial);
    expect([...collectionStore('case_events').values()]).toEqual(eventsBeforeDenial);
  });
});

describe('AssistantCancellationService.reconcile', () => {
  it('retains a running attempt trace and usage exactly once, with receipt and event in one commit', async () => {
    const case_ = baseCase({ status: 'in_build' });
    const target = baseRun('run-running', 'running', {
      assistant_policy_state: 'bound',
      assistant_tool_policy: {
        schema_version: 1,
        task_kind: 'arbitra_data_question',
        enabled_tools: ['list_cases', 'get_case'],
        tool_selection_reason: 'requester_scoped_read_registry',
      },
    });
    seedCase(case_, [target]);
    const cancellation = service();
    await cancellation.cancel(case_.case_id, REQUESTER, target.run_id);

    const cancelled = stored<Run>('runs', target.run_id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.assistant_cancel_reconcile_pending).toBe(true);
    expect(cancelled.assistant_cancel_receipt).toBeUndefined();
    expect(cancellationEvents(target.run_id)).toHaveLength(0);

    const trace = [
      {
        tool_name: 'list_cases',
        arguments: { status: 'open' },
        outcome: 'ok' as const,
        duration_ms: 11,
        result_summary: '2 cases',
      },
      {
        tool_name: 'get_case',
        arguments: { case_id: 'case-a' },
        outcome: 'ok' as const,
        duration_ms: 7,
        result_summary: 'case-a',
      },
    ];
    const reconciled = await cancellation.reconcile({
      runId: target.run_id,
      reconciledBy: 'executor',
      usageStatus: 'complete',
      traceStatus: 'recorded',
      trace,
      steps: 3,
      finishReason: 'cancelled',
      modelId: 'test-model',
      inputTokens: 120,
      outputTokens: 15,
      totalTokens: 135,
      durationMs: 432,
    });

    expect(reconciled.replayed).toBe(false);
    expect(reconciled.receipt).toMatchObject({
      revision: 1,
      reconciled_by: 'executor',
      usage_status: 'complete',
      trace_status: 'recorded',
    });
    const storedRun = stored<Run>('runs', target.run_id);
    expect(storedRun.assistant_cancel_reconcile_pending).toBeUndefined();
    expect(storedRun.assistant_cancel_receipt).toEqual(reconciled.receipt);
    expect(storedRun.token_usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 15,
      total_tokens: 135,
      model: 'test-model',
    });
    expect(storedRun.summary).toBe('Clerk task stopped after 2 recorded read(s).');

    const recorded = cancellationEvents(target.run_id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      actor_id: 'system:clerk',
      payload: {
        run_id: target.run_id,
        cancel_revision: 1,
        reconciled_by: 'executor',
        usage_status: 'complete',
        trace_status: 'recorded',
        tool_calls: 2,
        tool_call_records: trace,
        steps: 3,
        finish_reason: 'cancelled',
        model: 'test-model',
        input_tokens: 120,
        output_tokens: 15,
        total_tokens: 135,
        duration_ms: 432,
      },
    });
    expect(reconciled.receipt.event_id).toBe(recorded[0]?.event_id);

    const commitsAfterFirstReconcile = persistable(commits);
    const eventsAfterFirstReconcile = persistable(events());
    const replay = await cancellation.reconcile({
      runId: target.run_id,
      reconciledBy: 'assistant_sweeper',
      usageStatus: 'unavailable',
      traceStatus: 'unavailable',
    });

    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(reconciled.receipt);
    expect(commits).toEqual(commitsAfterFirstReconcile);
    expect(events()).toEqual(eventsAfterFirstReconcile);
    expect(cancellationEvents(target.run_id)).toHaveLength(1);
    expect(stored<Run>('runs', target.run_id).token_usage).toEqual(storedRun.token_usage);

    // Cancellation and reconciliation are separate durable boundaries, each
    // internally atomic; the idempotent replay creates no third commit.
    expect(commits).toHaveLength(2);
    expect(commits[1]).toEqual(expect.arrayContaining([
      `runs/${target.run_id}`,
      `case_events/${reconciled.receipt.event_id}`,
    ]));
  });

  it('refuses reconciliation unless the Run carries the durable cancellation fence', async () => {
    const case_ = baseCase();
    const active = baseRun('run-not-cancelled', 'running');
    seedCase(case_, [active]);

    await expect(service().reconcile({
      runId: active.run_id,
      reconciledBy: 'executor',
      usageStatus: 'partial',
      traceStatus: 'recorded',
      trace: [],
    })).rejects.toBeInstanceOf(AssistantCancellationConflictError);
    expect(stored<Run>('runs', active.run_id)).toEqual(active);
    expect(events()).toEqual([]);
    expect(commits).toEqual([]);
  });
});
