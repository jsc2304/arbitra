import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Case, CaseEvent, Run } from '@arbitra/shared';

const cases = new Map<string, Case>();
const events = new Map<string, CaseEvent>();

interface FakeRef {
  kind: 'case' | 'event';
  id: string;
}

function readRef(ref: FakeRef): Case | CaseEvent | undefined {
  return ref.kind === 'case' ? cases.get(ref.id) : events.get(ref.id);
}

function writeRef(ref: FakeRef, value: Case | CaseEvent): void {
  if (ref.kind === 'case') cases.set(ref.id, value as Case);
  else events.set(ref.id, value as CaseEvent);
}

const fakeDb = {
  async runTransaction<T>(
    fn: (tx: {
      get: (ref: FakeRef) => Promise<{ exists: boolean; data: () => Case | CaseEvent | undefined }>;
      update: (ref: FakeRef, updates: Record<string, unknown>) => void;
      set: (ref: FakeRef, value: Case | CaseEvent) => void;
      create: (ref: FakeRef, value: Case | CaseEvent) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const writes: Array<() => void> = [];
    const tx = {
      get: async (ref: FakeRef) => {
        const value = readRef(ref);
        return { exists: value !== undefined, data: () => value };
      },
      update: (ref: FakeRef, updates: Record<string, unknown>) => {
        writes.push(() => {
          const current = readRef(ref);
          if (!current) throw new Error(`Missing ${ref.kind} ${ref.id}`);
          writeRef(ref, { ...current, ...updates } as Case | CaseEvent);
        });
      },
      set: (ref: FakeRef, value: Case | CaseEvent) => {
        writes.push(() => writeRef(ref, value));
      },
      // Mirrors real Firestore create-if-not-exists semantics (issue #1063:
      // EventRepository.createInTransaction() now uses `transaction.create()`
      // for the append-only case_events write).
      create: (ref: FakeRef, value: Case | CaseEvent) => {
        writes.push(() => {
          if (readRef(ref) !== undefined) {
            throw new Error(`ALREADY_EXISTS: ${ref.kind}/${ref.id}`);
          }
          writeRef(ref, value);
        });
      },
    };
    const result = await fn(tx);
    for (const write of writes) write();
    return result;
  },
};

vi.mock('../../lib/firestore.js', () => ({
  getDb: () => fakeDb,
  collections: {
    cases: () => ({ doc: (id: string): FakeRef => ({ kind: 'case', id }) }),
    caseEvents: () => ({ doc: (id: string): FakeRef => ({ kind: 'event', id }) }),
  },
}));

const { FirestorePipelineAdapter } = await import('./firestore-pipeline-adapter.js');
const { createPreconditionEvaluator } = await import('./preconditions.js');

function makeAssistantCase(): Case {
  return {
    case_id: 'case_a',
    title: 'Assistant task',
    description: 'Test task',
    source_type: 'google_chat',
    source_ref: 'spaces/one/messages/two',
    project_id: 'project_1',
    repository_id: 'repo_1',
    owner_user_id: 'user_1',
    status: 'in_build',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    case_type: 'assistant_task',
    assistant_context: {
      channel: 'google_chat',
      space_name: 'spaces/one',
      thread_name: 'spaces/one/threads/two',
      source_message_name: 'spaces/one/messages/two',
      chat_user_name: 'users/one',
      conversation_visibility: 'space',
      task_kind: 'implementation',
      risk_level: 'low',
      policy_version: 'policy-v1',
      prompt_version: 'prompt-v1',
    },
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-08-03T10:00:00.000Z',
    updated_at: '2026-08-03T10:00:00.000Z',
  };
}

function makeFailedAssistantRun(runId: string, attempt: number): Run {
  return {
    run_id: runId,
    case_id: 'case_a',
    run_type: 'assistant_task_run',
    trigger_source: 'system:test',
    status: 'failed',
    attempt,
    error_message: 'Assistant run lease expired',
    input_refs: [],
    output_refs: [],
    created_at: '2026-08-03T10:01:00.000Z',
    updated_at: '2026-08-03T10:01:00.000Z',
  };
}

describe('FirestorePipelineAdapter.documentAssistantHold', () => {
  beforeEach(() => {
    cases.clear();
    events.clear();
  });

  it('atomically persists retry exhaustion as a terminal verdict', async () => {
    cases.set('case_a', makeAssistantCase());
    const adapter = new FirestorePipelineAdapter();

    await adapter.documentAssistantHold(
      'case_a',
      { wait_reason: 'failed_permanently', run_id: 'run_a3', attempt: 3 },
      {
        type: 'assistant_task_abandoned',
        payload: { run_id: 'run_a3', attempt: 3, classification: 'retry_exhausted' },
      },
      'system:assistant-sweeper',
    );

    const persistedCase = cases.get('case_a')!;
    expect(persistedCase.assistant_context).toEqual(expect.objectContaining({
      wait_reason: 'failed_permanently',
      wait_run_id: 'run_a3',
      wait_attempt: 3,
      channel: 'google_chat',
      source_message_name: 'spaces/one/messages/two',
      prompt_version: 'prompt-v1',
    }));

    const persistedEvents = [...events.values()];
    expect(persistedEvents).toEqual([
      expect.objectContaining({
        case_id: 'case_a',
        type: 'assistant_task_abandoned',
        actor_id: 'system:assistant-sweeper',
        payload: expect.objectContaining({ run_id: 'run_a3' }),
      }),
    ]);

    const precondition = await createPreconditionEvaluator({
      case_: persistedCase,
      runs: [makeFailedAssistantRun('run_a3', 3)],
      findings: [],
      ruleResults: [],
      evidence: [],
      decisions: [],
      events: persistedEvents,
      actorId: 'system:assistant-sweeper',
    }).evaluate('assistant_terminal_failure_documented');
    expect(precondition.satisfied).toBe(true);
  });

  it('atomically persists a terminal failure and satisfies the terminal-failure precondition', async () => {
    cases.set('case_a', makeAssistantCase());
    const adapter = new FirestorePipelineAdapter();

    await adapter.documentAssistantHold(
      'case_a',
      { wait_reason: 'failed_permanently', run_id: 'run_a1', attempt: 1 },
      {
        type: 'assistant_task_abandoned',
        payload: { run_id: 'run_a1', attempt: 1, error: 'bound:max_steps' },
      },
      'system:pipeline',
    );

    const persistedCase = cases.get('case_a')!;
    const persistedEvents = [...events.values()];
    expect(persistedCase.assistant_context).toEqual(expect.objectContaining({
      wait_reason: 'failed_permanently',
      wait_run_id: 'run_a1',
      wait_attempt: 1,
      prompt_version: 'prompt-v1',
    }));

    const evaluator = createPreconditionEvaluator({
      case_: persistedCase,
      runs: [makeFailedAssistantRun('run_a1', 1)],
      findings: [],
      ruleResults: [],
      evidence: [],
      decisions: [],
      events: persistedEvents,
      actorId: 'system:pipeline',
    });
    await expect(evaluator.evaluate('assistant_terminal_failure_documented')).resolves.toEqual({
      satisfied: true,
    });
  });
});
