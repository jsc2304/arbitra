import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, Case, Evidence, Run } from '@arbitra/shared';

type Row = Record<string, unknown>;
const store = new Map<string, Map<string, Row>>();

function rows(name: string): Map<string, Row> {
  let collection = store.get(name);
  if (!collection) {
    collection = new Map();
    store.set(name, collection);
  }
  return collection;
}

class FakeDoc {
  constructor(readonly collection: string, readonly id: string) {}
  async get() {
    const row = rows(this.collection).get(this.id);
    return { exists: row !== undefined, data: () => row };
  }
}

class FakeQuery {
  constructor(
    readonly collection: string,
    readonly filters: Array<[string, unknown]> = [],
  ) {}
  where(field: string, op: string, value: unknown) {
    if (op !== '==') throw new Error(`Unsupported fake query operator: ${op}`);
    return new FakeQuery(this.collection, [...this.filters, [field, value]]);
  }
  async get() {
    const docs = [...rows(this.collection).entries()]
      .filter(([, row]) => this.filters.every(([field, value]) => row[field] === value))
      .map(([id, row]) => ({ id, exists: true, data: () => row }));
    return { docs, empty: docs.length === 0 };
  }
}

class FakeCollection extends FakeQuery {
  doc(id: string) { return new FakeDoc(this.collection, id); }
}

const collections = {
  cases: () => new FakeCollection('cases'),
  runs: () => new FakeCollection('runs'),
  evidence: () => new FakeCollection('evidence'),
  artifacts: () => new FakeCollection('artifacts'),
  users: () => new FakeCollection('users'),
  assistantFeedback: () => new FakeCollection('assistant_feedback'),
  caseEvents: () => new FakeCollection('case_events'),
};

const fakeDb = {
  async runTransaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    const writes: Array<{ op: 'set' | 'create'; ref: FakeDoc; data: Row }> = [];
    const tx = {
      get: (ref: FakeDoc) => ref.get(),
      set: (ref: FakeDoc, data: Row) => writes.push({ op: 'set' as const, ref, data }),
      create: (ref: FakeDoc, data: Row) => writes.push({ op: 'create' as const, ref, data }),
    };
    const result = await work(tx);
    for (const write of writes) {
      if (write.op === 'create' && rows(write.ref.collection).has(write.ref.id)) {
        throw new Error(`ALREADY_EXISTS: ${write.ref.collection}/${write.ref.id}`);
      }
      rows(write.ref.collection).set(write.ref.id, structuredClone(write.data));
    }
    return result;
  },
};

vi.mock('../../lib/firestore.js', () => ({ collections, getDb: () => fakeDb }));

const { AssistantFeedbackService } = await import('./assistant-feedback-service.js');

const CASE_ID = 'case-clerk-answer';
const REQUESTER = 'usr_requester';
const ADMIN = 'usr_admin';
const STRANGER = 'usr_stranger';
const RUN_ID = 'run_answer';
const EVIDENCE_ID = 'ev_answer';
const ARTIFACT_ID = 'art_answer';

function seed(): void {
  const case_: Case = {
    case_id: CASE_ID,
    title: 'Summarize my cases',
    description: 'Summarize my cases',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_clerk',
    repository_id: 'repo_clerk',
    owner_user_id: REQUESTER,
    status: 'done',
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
    created_at: '2026-08-05T08:00:00.000Z',
    updated_at: '2026-08-05T08:05:00.000Z',
    deleted_at: null,
    deleted_by: null,
  };
  const run: Run = {
    run_id: RUN_ID,
    case_id: CASE_ID,
    run_type: 'assistant_task_run',
    trigger_source: 'assistant-intake:web',
    status: 'completed',
    input_refs: [],
    output_refs: [EVIDENCE_ID],
    assistant_policy_state: 'bound',
    attempt: 1,
    created_at: '2026-08-05T08:00:00.000Z',
    updated_at: '2026-08-05T08:05:00.000Z',
    finished_at: '2026-08-05T08:05:00.000Z',
  };
  const evidence: Evidence = {
    evidence_id: EVIDENCE_ID,
    case_id: CASE_ID,
    run_id: RUN_ID,
    type: 'task_result',
    source_type: 'automated',
    artifact_ref: ARTIFACT_ID,
    machine_readable: true,
    validation_track: 'direct',
    created_at: '2026-08-05T08:05:00.000Z',
    created_by: 'system:assistant',
  };
  const artifact: Artifact = {
    artifact_id: ARTIFACT_ID,
    case_id: CASE_ID,
    run_id: RUN_ID,
    filename: 'result.json',
    content_type: 'application/json',
    storage_path: 'results/result.json',
    size_bytes: 100,
    created_by: 'system:assistant',
    created_at: '2026-08-05T08:05:00.000Z',
  };
  rows('cases').set(CASE_ID, case_ as unknown as Row);
  rows('runs').set(RUN_ID, run as unknown as Row);
  rows('evidence').set(EVIDENCE_ID, evidence as unknown as Row);
  rows('artifacts').set(ARTIFACT_ID, artifact as unknown as Row);
  rows('users').set(REQUESTER, { user_id: REQUESTER, roles: [] });
  rows('users').set(ADMIN, { user_id: ADMIN, roles: ['admin'] });
  rows('users').set(STRANGER, { user_id: STRANGER, roles: [] });
}

beforeEach(() => {
  store.clear();
  seed();
});

describe('AssistantFeedbackService', () => {
  it('pins feedback to the completed result, replays identical input, and audits revisions', async () => {
    const times = [
      new Date('2026-08-05T09:00:00.000Z'),
      new Date('2026-08-05T09:05:00.000Z'),
    ];
    const service = new AssistantFeedbackService({ now: () => times.shift()! });

    const first = await service.record(CASE_ID, REQUESTER, {
      rating: 'useful',
      reason: 'It answered the question directly.',
    });
    const replay = await service.record(CASE_ID, REQUESTER, {
      rating: 'useful',
      reason: 'It answered the question directly.',
    });
    const revised = await service.record(CASE_ID, REQUESTER, {
      rating: 'not_useful',
      reason: 'The totals were missing.',
    });

    expect(first).toMatchObject({ replayed: false, feedback: {
      case_id: CASE_ID,
      run_id: RUN_ID,
      result_evidence_id: EVIDENCE_ID,
      result_artifact_id: ARTIFACT_ID,
      revision: 1,
    } });
    expect(replay).toMatchObject({ replayed: true, feedback: { revision: 1 } });
    expect(replay.event_id).toBeUndefined();
    expect(revised).toMatchObject({ replayed: false, feedback: {
      revision: 2,
      created_at: '2026-08-05T09:00:00.000Z',
      updated_at: '2026-08-05T09:05:00.000Z',
    } });
    expect(rows('case_events').size).toBe(2);
    expect(rows('cases').get(CASE_ID)?.['updated_at']).toBe('2026-08-05T08:05:00.000Z');
  });

  it('lets admins inspect but not impersonate the requester, and hides feedback from strangers', async () => {
    const service = new AssistantFeedbackService();
    await service.record(CASE_ID, REQUESTER, { rating: 'useful', reason: 'Clear.' });

    await expect(service.get(CASE_ID, ADMIN)).resolves.toMatchObject({ rating: 'useful' });
    await expect(service.get(CASE_ID, STRANGER)).rejects.toThrow(
      'Only the Clerk requester or an admin can inspect this feedback.',
    );
    await expect(service.record(CASE_ID, ADMIN, { rating: 'not_useful', reason: 'Forged.' }))
      .rejects.toThrow('Only the Clerk requester can continue or read this thread.');
  });

  it('refuses feedback before a Clerk task has a completed immutable result', async () => {
    rows('cases').set(CASE_ID, {
      ...rows('cases').get(CASE_ID),
      status: 'in_build',
    });

    await expect(new AssistantFeedbackService().record(CASE_ID, REQUESTER, {
      rating: 'useful',
      reason: 'Too early.',
    })).rejects.toThrow('Only a completed Clerk task can receive a follow-up.');
    await expect(new AssistantFeedbackService().get(CASE_ID, ADMIN))
      .rejects.toThrow('Feedback is available only for completed Clerk tasks.');
    expect(rows('assistant_feedback').size).toBe(0);
    expect(rows('case_events').size).toBe(0);
  });
});
