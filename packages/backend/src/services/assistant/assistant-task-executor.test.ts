import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Case, Evidence, Run } from '@arbitra/shared';
import type { LanguageModel } from 'ai';

/**
 * One attempt, end to end.
 *
 * The properties under test are the ones that make an assistant result
 * trustworthy rather than merely present:
 *
 *  - the five documents of a completed task land in ONE commit, or none of them
 *    do;
 *  - the evidence that commit writes actually satisfies
 *    `assistant_result_evidence_present` — evaluated with the real precondition
 *    function against the real state machine, not a paraphrase of it;
 *  - a cancellation that lands mid-flight makes the completion discard the
 *    result instead of committing it over a case that has moved on;
 *  - a bound, a rejected answer, or a lost run each end the attempt without
 *    persisting anything.
 *
 * The Firestore double models the three behaviours those properties depend on:
 * reads-before-writes inside a transaction, all-or-nothing commits, and
 * Firestore's refusal of more than one mutation per document per commit (which
 * is why `task_kind` rides along in the transition's own case update).
 */

type DocData = Record<string, unknown>;

const DELETE_SENTINEL = '<<field-deleted>>';

const store = new Map<string, Map<string, DocData>>();
/** One entry per committed transaction: the document paths it wrote. */
const commits: string[][] = [];
let failNextCommit: string | null = null;

function collectionStore(name: string): Map<string, DocData> {
  let existing = store.get(name);
  if (!existing) {
    existing = new Map();
    store.set(name, existing);
  }
  return existing;
}

/** Mimics Firestore's `ignoreUndefinedProperties`. */
function persistable<T>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}

interface Filter {
  field: string;
  op: '==' | 'in';
  value: unknown;
}

function matches(doc: DocData, filters: Filter[]): boolean {
  return filters.every(({ field, op, value }) => {
    const actual = doc[field] ?? null;
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
    const docs = [...collectionStore(this.collectionName).values()].filter((doc) =>
      matches(doc, this.filters),
    );
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
    const data = collectionStore(this.collectionName).get(this.id);
    return { id: this.id, exists: data !== undefined, data: () => data };
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

  /**
   * Stands in for `CollectionReference.firestore`, just enough for
   * `resolveDisplayNames`'s `collections.users().firestore.getAll(...refs)`:
   * one snapshot per ref, in order, non-existent docs as `exists: false` —
   * never dropped, never thrown.
   */
  get firestore() {
    return {
      getAll: async (...refs: FakeDocRef[]) => Promise.all(refs.map((ref) => ref.get())),
    };
  }
}

type StagedWrite = { ref: FakeDocRef; op: 'create' | 'set' | 'update'; data: DocData };

const fakeDb = {
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
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
    const paths = writes.map((w) => w.ref.path);
    if (new Set(paths).size !== paths.length) {
      throw new Error(`Firestore rejects more than one mutation per document: ${paths.join(', ')}`);
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
    if (writes.length > 0) commits.push(paths);
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
  artifacts: () => new FakeCollection('artifacts'),
  projects: () => new FakeCollection('projects'),
  users: () => new FakeCollection('users'),
  repositories: () => new FakeCollection('repositories'),
  // `vi.fn`-wrapped (not a plain arrow) so a test can assert how many times
  // the injected-context fetch queried this collection — the "no double
  // query" property #832 slice A depends on (`loadInjectedContext` is
  // called exactly once per attempt and its result feeds both the prompt
  // and the trace).
  knowledgeAssets: vi.fn(() => new FakeCollection('knowledge_assets')),
};

vi.mock('../../lib/firestore.js', () => ({ getDb: () => fakeDb, collections }));

// `FieldValue.delete()` is a server sentinel; the double needs a value it can
// recognise when merging an update.
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => DELETE_SENTINEL },
}));

// Notifications fire off the write path and would reach collections this double
// does not model.
vi.mock('../notification/event-notifier.js', () => ({
  EventNotifier: class {
    async onCaseEvent() {}
  },
}));

const { AssistantTaskExecutor } = await import('./assistant-task-executor.js');
// The REAL precondition evaluator, so "the evidence satisfies
// `assistant_result_evidence_present`" is checked against the actual gate rather
// than a paraphrase of it.
const { createPreconditionEvaluator } = await import('../orchestration/preconditions.js');
// The REAL id derivation, so a seeded knowledge asset's `scope_ref` lands at
// exactly the id `loadInjectedContext` queries for — a hand-picked stand-in
// id would pass even if the executor queried the wrong scope.
const { clerkCoreIds } = await import('./clerk-core.js');

const REQUESTER = 'usr_requester';
const PROJECT = 'proj_clerk_test';

interface FakeCallArgs {
  tools: Record<string, { execute: (input: unknown) => Promise<unknown> }>;
  system?: string;
  prompt?: string;
  /** Set only by the answer retry, which replays the conversation. */
  messages?: { role: string; content: unknown }[];
  toolChoice?: string;
  prepareStep?: (options: { steps: unknown[]; stepNumber: number }) => { toolChoice?: string };
  stopWhen?: (options: { steps: unknown[] }) => boolean | PromiseLike<boolean>;
  onStepFinish?: (step: { usage: { inputTokens?: number; outputTokens?: number } }) => void;
}

/**
 * The `generateText` double. It consults `prepareStep` for every step index it
 * claims to have run, as the SDK does (`ai` 6.0.168, `dist/index.js:4313`):
 * `prepareStep` is what withholds the reads, so a double that skipped it would
 * exercise the executor with that seam permanently off.
 */
function fakeGenerate(
  body: (args: FakeCallArgs) => Promise<{ text: string; finishReason?: string; steps?: number }>,
) {
  const calls: FakeCallArgs[] = [];
  const fn = (async (args: FakeCallArgs) => {
    calls.push(args);
    await args.prepareStep?.({ steps: [], stepNumber: 0 });
    const answer = await body(args);
    for (let stepNumber = 1; stepNumber < (answer.steps ?? 1); stepNumber += 1) {
      await args.prepareStep?.({ steps: new Array(stepNumber).fill({}), stepNumber });
    }
    const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
    return {
      text: answer.text,
      finishReason: answer.finishReason ?? 'stop',
      steps: new Array(answer.steps ?? 1).fill({ usage }),
      totalUsage: usage,
    };
  }) as never;
  return { fn, calls };
}

/**
 * A double that runs the SDK's multi-step loop until the step ceiling, the way a
 * request that outgrows its budget reaches it: one tool call per step for as
 * long as tools are offered, then — once `prepareStep` takes them away — the
 * answer. Modelled on the installed `ai` 6.0.168 loop (`dist/index.js:4641`),
 * and stopped by the real `stopWhen` rather than by a step count copied here.
 */
function fakeGenerateToCeiling(toolName: string, answer: string) {
  const fn = (async (args: FakeCallArgs) => {
    const steps: { usage: { inputTokens: number; outputTokens: number } }[] = [];
    const usage = { inputTokens: 100, outputTokens: 20 };
    let text = '';
    let finishReason = 'stop';
    for (;;) {
      const decision = (await args.prepareStep?.({ steps, stepNumber: steps.length })) ?? {};
      if (decision.toolChoice === 'none') {
        text = answer;
        finishReason = 'stop';
      } else {
        await args.tools[toolName]!.execute({});
        text = '';
        finishReason = 'tool-calls';
      }
      steps.push({ usage });
      args.onStepFinish?.({ usage });
      if (finishReason !== 'tool-calls') break;
      if (await args.stopWhen?.({ steps })) break;
    }
    return {
      text,
      finishReason,
      steps,
      totalUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    };
  }) as never;
  return { fn };
}

/**
 * Same loop, but the first step emits SEVERAL tool calls at once — what
 * `@ai-sdk/google` does, and the only way the tool-call allowance can run out
 * before the step ceiling. Subsequent steps read once, until `prepareStep` takes
 * the tools away and the answer arrives.
 */
function fakeGenerateParallel(options: {
  toolName: string;
  callsOnFirstStep: number;
  answer: string;
}) {
  const fn = (async (args: FakeCallArgs) => {
    const steps: { usage: { inputTokens: number; outputTokens: number } }[] = [];
    const usage = { inputTokens: 100, outputTokens: 20 };
    let text = '';
    let finishReason = 'stop';
    for (;;) {
      const decision = (await args.prepareStep?.({ steps, stepNumber: steps.length })) ?? {};
      if (decision.toolChoice === 'none') {
        text = options.answer;
        finishReason = 'stop';
      } else {
        const calls = steps.length === 0 ? options.callsOnFirstStep : 1;
        await Promise.all(
          Array.from({ length: calls }, () => args.tools[options.toolName]!.execute({})),
        );
        text = '';
        finishReason = 'tool-calls';
      }
      steps.push({ usage });
      args.onStepFinish?.({ usage });
      if (finishReason !== 'tool-calls') break;
      if (await args.stopWhen?.({ steps })) break;
    }
    return {
      text,
      finishReason,
      steps,
      totalUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    };
  }) as never;
  return { fn };
}

/**
 * The shape that used to end a run in `bound:max_steps`: the ceiling is reached,
 * the reserved answer step runs, and the model emits nothing. This double answers
 * only when it is asked the second time, so the executor's whole path is exercised
 * — the run must now COMPLETE, where before it was rejected.
 *
 * It reports `response.messages`, because the retry answers from the conversation
 * and a double that omitted them would make the retry impossible while looking
 * like it had covered it.
 */
function fakeGenerateEmptyThenAnswer(options: { toolName: string; answerOnRetry: string }) {
  const retries: FakeCallArgs[] = [];
  const fn = (async (args: FakeCallArgs) => {
    const usage = { inputTokens: 100, outputTokens: 20 };
    if (args.messages !== undefined) {
      retries.push(args);
      args.onStepFinish?.({ usage });
      return {
        text: options.answerOnRetry,
        finishReason: 'stop',
        steps: [{ usage }],
        totalUsage: { ...usage, totalTokens: 120 },
        response: {
          messages: [{ role: 'assistant', content: [{ type: 'text', text: options.answerOnRetry }] }],
        },
      };
    }

    const steps: { usage: { inputTokens: number; outputTokens: number } }[] = [];
    const messages: { role: string; content: unknown }[] = [];
    let finishReason = 'stop';
    for (;;) {
      const decision = (await args.prepareStep?.({ steps, stepNumber: steps.length })) ?? {};
      if (decision.toolChoice === 'none') {
        // The reserved step: nothing to say, which is the defect.
        finishReason = 'stop';
        messages.push({ role: 'assistant', content: [] });
      } else {
        await args.tools[options.toolName]!.execute({ status: 'open' });
        finishReason = 'tool-calls';
        const id = `call_${steps.length}`;
        messages.push({
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: id, toolName: options.toolName, input: {} }],
        });
        messages.push({
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: id, toolName: options.toolName, output: { rows: [] } },
          ],
        });
      }
      steps.push({ usage });
      args.onStepFinish?.({ usage });
      if (finishReason !== 'tool-calls') break;
      if (await args.stopWhen?.({ steps })) break;
    }
    return {
      text: '',
      finishReason,
      steps,
      totalUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      response: { messages },
    };
  }) as never;
  return { fn, retries: () => retries };
}

/**
 * The shape seen in practice: the provider ignores
 * `toolChoice: 'none'` on the reserved step and spends it on tool calls — which
 * are NOT executed, so the reported conversation ends on a dangling tool-call
 * turn carrying only a preamble. The run used to fail there with the second ask
 * never made; it must now be asked again, and complete when that ask answers.
 */
function fakeGenerateToolCallsThenAnswer(options: {
  toolName: string;
  preamble: string;
  answerOnRetry: string;
}) {
  const retries: FakeCallArgs[] = [];
  const fn = (async (args: FakeCallArgs) => {
    const usage = { inputTokens: 100, outputTokens: 20 };
    if (args.messages !== undefined) {
      retries.push(args);
      args.onStepFinish?.({ usage });
      return {
        text: options.answerOnRetry,
        finishReason: 'stop',
        steps: [{ usage }],
        totalUsage: { ...usage, totalTokens: 120 },
        response: {
          messages: [
            { role: 'assistant', content: [{ type: 'text', text: options.answerOnRetry }] },
          ],
        },
      };
    }

    const steps: { usage: { inputTokens: number; outputTokens: number } }[] = [];
    const messages: { role: string; content: unknown }[] = [];
    for (;;) {
      const decision = (await args.prepareStep?.({ steps, stepNumber: steps.length })) ?? {};
      if (decision.toolChoice === 'none') {
        // The reserved step, spent on calls the withheld tools never answer.
        messages.push({
          role: 'assistant',
          content: [
            { type: 'text', text: options.preamble },
            { type: 'tool-call', toolCallId: 'call_withheld', toolName: options.toolName, input: {} },
          ],
        });
        steps.push({ usage });
        args.onStepFinish?.({ usage });
        break;
      }
      await args.tools[options.toolName]!.execute({ status: 'open' });
      const id = `call_${steps.length}`;
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: id, toolName: options.toolName, input: {} }],
      });
      messages.push({
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: id, toolName: options.toolName, output: { rows: [] } },
        ],
      });
      steps.push({ usage });
      args.onStepFinish?.({ usage });
      if (await args.stopWhen?.({ steps })) break;
    }
    return {
      text: options.preamble,
      finishReason: 'tool-calls',
      steps,
      totalUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      response: { messages },
    };
  }) as never;
  return { fn, retries: () => retries };
}

function makeExecutor(
  generate: ReturnType<typeof fakeGenerate>['fn'],
  storage = { save: vi.fn(async () => '2026/08/03/abcd-result.json'), read: vi.fn(), delete: vi.fn() },
  extraOptions: Partial<ConstructorParameters<typeof AssistantTaskExecutor>[0]> = {},
) {
  const executor = new AssistantTaskExecutor({
    generate,
    storage: storage as never,
    resolveModel: async () => ({ model: {} as LanguageModel, modelId: 'test-model' }),
    ...extraOptions,
  });
  return { executor, storage };
}

function seed(options: { caseOverrides?: Partial<Case>; runOverrides?: Partial<Run> } = {}): {
  case_: Case;
  run: Run;
} {
  collectionStore('projects').set(PROJECT, {
    project_id: PROJECT,
    name: 'Clerk',
    owner_user_id: REQUESTER,
    members: [REQUESTER],
    reviewer_pool: [],
    tech_leads: [],
  });
  collectionStore('users').set(REQUESTER, { user_id: REQUESTER, roles: [] });

  const case_ = {
    case_id: 'case-clerk-1',
    title: 'Which cases are open?',
    description: 'Which cases are still open in Arbitra?',
    source_type: 'manual',
    source_ref: '',
    project_id: PROJECT,
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
    created_at: '2026-08-03T10:00:00.000Z',
    updated_at: '2026-08-03T10:00:00.000Z',
    deleted_at: null,
    deleted_by: null,
    ...options.caseOverrides,
  } as Case;

  const run = {
    run_id: 'run_clerk_1',
    case_id: case_.case_id,
    run_type: 'assistant_task_run',
    trigger_source: 'assistant-intake:web',
    status: 'running',
    input_refs: [],
    output_refs: [],
    started_at: '2026-08-03T10:00:05.000Z',
    created_at: '2026-08-03T10:00:00.000Z',
    updated_at: '2026-08-03T10:00:05.000Z',
    lease_expires_at: '2099-08-03T10:05:05.000Z',
    worker_id: 'worker_a',
    attempt: 1,
    ...options.runOverrides,
  } as Run;

  collectionStore('cases').set(case_.case_id, persistable(case_) as DocData);
  collectionStore('runs').set(run.run_id, persistable(run) as DocData);
  return { case_, run };
}

function stored(collection: string): DocData[] {
  return [...collectionStore(collection).values()];
}

function storedEventTypes(): string[] {
  return stored('case_events').map((e) => e['type'] as string);
}

beforeEach(() => {
  store.clear();
  commits.length = 0;
  failNextCommit = null;
  collections.knowledgeAssets.mockClear();
});

describe('AssistantTaskExecutor — the completed attempt', () => {
  it('commits the run completion, the artifact, the evidence, the transition and the event together', async () => {
    const { case_, run } = seed();
    const { fn } = fakeGenerate(async () => ({ text: 'Two cases are open: A and B.' }));
    const { executor, storage } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome.outcome).toBe('completed');

    // The bytes went to object storage before the transaction opened.
    expect(storage.save).toHaveBeenCalledTimes(1);

    // Three transactions: `open → in_build`, the pre-model policy bind, then
    // completion. The latter atomically carries the case/run updates, artifact,
    // evidence and three events. Removing the bind collapses this back to two and
    // loses the inspectable policy for model-attempt failures.
    expect(commits).toHaveLength(3);
    const completion = commits[2]!;
    expect(completion).toHaveLength(7);
    expect(completion).toContain(`runs/${run.run_id}`);
    expect(completion).toContain(`cases/${case_.case_id}`);
    expect(completion.some((p) => p.startsWith('artifacts/'))).toBe(true);
    expect(completion.some((p) => p.startsWith('evidence/'))).toBe(true);
    // The transition emits both assistant-specific and generic completion events;
    // the executor adds the Run event in that same commit.
    expect(completion.filter((p) => p.startsWith('case_events/'))).toHaveLength(3);

    const storedCase = collectionStore('cases').get(case_.case_id)!;
    expect(storedCase['status']).toBe('done');
    expect((storedCase['assistant_context'] as DocData)['task_kind']).toBe('arbitra_data_question');
    // #858: the Scheduled tab's occurrence badge reads this straight off the
    // case (via GET /api/assistant/tasks), not off the run's event payload —
    // it has to be `false` here, not merely absent, or a badge-mapping bug
    // that treats "absent" as "not withheld" would be indistinguishable from
    // this genuinely-not-withheld attempt.
    expect((storedCase['assistant_context'] as DocData)['reads_withheld']).toBe(false);
    expect('reads_withheld_reason' in (storedCase['assistant_context'] as DocData)).toBe(false);

    const storedRun = collectionStore('runs').get(run.run_id)!;
    expect(storedRun['status']).toBe('completed');
    expect(storedRun['output_refs']).toEqual([stored('artifacts')[0]!['artifact_id']]);
    expect(storedRun['token_usage']).toMatchObject({ model: 'test-model', total_tokens: 120 });
    expect(storedRun['assistant_policy_state']).toBe('bound');
    expect(storedRun['assistant_tool_policy']).toMatchObject({
      tool_selection_reason: 'requester_scoped_read_registry',
    });
    // The lease is released, or the stale sweep would keep looking at it.
    expect('lease_expires_at' in storedRun).toBe(false);
    expect('worker_id' in storedRun).toBe(false);

    expect(storedEventTypes().sort()).toEqual([
      'assistant_task_completed',
      'assistant_task_started',
      'case_completed',
      'run_completed',
    ]);
  });

  it('preserves blueprint provenance on the done-transition write instead of overwriting assistant_context wholesale', async () => {
    // #858: `extraCaseUpdates.assistant_context` spreads the case's EXISTING
    // assistant_context before adding `task_kind`/`reads_withheld` — it must
    // never rebuild that object from scratch, or a blueprint occurrence's
    // `blueprint_id`/`blueprint_context` (stamped at intake, read nowhere
    // else in this transaction) would be silently dropped the moment the run
    // it started finishes. Rewriting that spread as an object literal with
    // only the new fields would make this fail.
    const { case_, run } = seed({
      caseOverrides: {
        assistant_context: {
          channel: 'blueprint',
          conversation_visibility: 'direct',
          requester_user_id: REQUESTER,
          risk_level: 'low',
          policy_version: 'assistant_policy:v1',
          prompt_version: 'assistant_task:v1',
          blueprint_id: 'taskBlueprint_roster_check',
          blueprint_context: {
            blueprint_id: 'taskBlueprint_roster_check',
            blueprint_version: 3,
            prompt_text: "Every Monday at 9, summarize my team's open cases",
          },
        },
      },
    });
    const { fn } = fakeGenerate(async () => ({ text: 'Two cases are open: A and B.' }));
    const { executor } = makeExecutor(fn);

    await executor.run(run, case_);

    const storedContext = collectionStore('cases').get(case_.case_id)!['assistant_context'] as DocData;
    expect(storedContext['blueprint_id']).toBe('taskBlueprint_roster_check');
    expect(storedContext['blueprint_context']).toEqual({
      blueprint_id: 'taskBlueprint_roster_check',
      blueprint_version: 3,
      prompt_text: "Every Monday at 9, summarize my team's open cases",
    });
    // The new fields still land alongside it — this is not a choice between
    // provenance and classification.
    expect(storedContext['task_kind']).toBe('arbitra_data_question');
    expect(storedContext['reads_withheld']).toBe(false);
  });

  it("records the answer step's own output-token ceiling in the serialized trace bounds", async () => {
    // Reverted line: removing `max_answer_output_tokens:
    // bounds.maxAnswerOutputTokens` from `boundsPayload` in
    // assistant-task-executor.ts makes this fail — the field the retry now
    // widens (assistant-loop.ts, issue #841) would be invisible to an operator
    // reading the trace.
    const { case_, run } = seed();
    const { fn } = fakeGenerate(async () => ({ text: 'Two cases are open: A and B.' }));
    const { executor, storage } = makeExecutor(fn);

    await executor.run(run, case_);

    const document = JSON.parse(
      Buffer.from((storage.save.mock.calls[0] as unknown as string[])[2]!, 'base64').toString(
        'utf-8',
      ),
    );
    expect(document.bounds.max_answer_output_tokens).toBe(4_000);
    expect(document.bounds.max_answer_output_tokens).toBeGreaterThan(
      document.bounds.max_output_tokens,
    );
  });

  it('writes evidence that satisfies assistant_result_evidence_present', async () => {
    const { case_, run } = seed();
    const { fn } = fakeGenerate(async () => ({ text: 'Two cases are open.' }));
    const { executor } = makeExecutor(fn);

    await executor.run(run, case_);

    const evidence = stored('evidence') as unknown as Evidence[];
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      type: 'task_result',
      run_id: run.run_id,
      source_type: 'automated',
    });
    expect(evidence[0]!.artifact_ref).toBe(stored('artifacts')[0]!['artifact_id']);

    // The real precondition, against the committed state.
    const evaluator = createPreconditionEvaluator({
      case_: collectionStore('cases').get(case_.case_id)! as unknown as Case,
      runs: stored('runs') as unknown as Run[],
      findings: [],
      ruleResults: [],
      evidence,
      decisions: [],
      events: [],
      actorId: 'system',
    });
    expect(await evaluator.evaluate('assistant_result_evidence_present')).toEqual({
      satisfied: true,
    });
  });

  it('records the trace in the artifact and a short summary in the event, without prompts or reasoning', async () => {
    const { case_, run } = seed();
    const { fn } = fakeGenerate(async (args) => {
      await args.tools['arbitra_search_cases']!.execute({ status: 'open' });
      return { text: 'One case is open.' };
    });
    const { executor, storage } = makeExecutor(fn);

    await executor.run(run, case_);

    const [, contentType, base64] = storage.save.mock.calls[0] as unknown as [
      string,
      string,
      string,
    ];
    expect(contentType).toBe('application/json');
    const document = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
    expect(document.schema).toBe('arbitra.assistant_task_result/v2');
    expect(document.assistant_tool_policy).toEqual(
      collectionStore('runs').get(run.run_id)!['assistant_tool_policy'],
    );
    expect(document.answer).toBe('One case is open.');
    expect(document.tool_calls).toHaveLength(1);
    expect(document.tool_calls[0]).toMatchObject({
      name: 'arbitra_search_cases',
      outcome: 'ok',
    });
    expect(document.tool_calls[0].duration_ms).toEqual(expect.any(Number));
    // Not in the artifact: the prompt, the system instructions, any reasoning.
    const serialised = JSON.stringify(document);
    expect(serialised).not.toContain('You are Clerk');
    expect(serialised).not.toContain('untrusted_user_request');
    expect(document.prompt).toBeUndefined();
    expect(document.system).toBeUndefined();
    expect(document.reasoning).toBeUndefined();

    const completionEvent = stored('case_events').find((e) => e['type'] === 'run_completed')!;
    const payload = completionEvent['payload'] as DocData;
    expect(payload['tool_calls']).toHaveLength(1);
    expect(payload['answer_chars']).toBe('One case is open.'.length);
    expect(JSON.stringify(payload)).not.toContain('You are Clerk');
  });
});

describe('AssistantTaskExecutor — policy binding is the pre-model fence', () => {
  const boundPolicy = {
    schema_version: 1 as const,
    task_kind: 'arbitra_data_question' as const,
    enabled_tools: [
      'arbitra_search_cases',
      'arbitra_count_cases',
      'arbitra_count_case_transitions',
      'arbitra_get_case',
      'arbitra_search_knowledge',
      'arbitra_get_knowledge',
    ],
    tool_selection_reason: 'requester_scoped_read_registry' as const,
  };

  it('binds the persisted policy before the first model call', async () => {
    const { case_, run } = seed({ caseOverrides: { status: 'in_build' } });
    const { fn } = fakeGenerate(async () => {
      const storedRun = collectionStore('runs').get(run.run_id)!;
      // Moving the bind below generate makes this fail at the production model
      // boundary, not against a policy-only double.
      expect(storedRun['assistant_policy_state']).toBe('bound');
      expect(storedRun['assistant_tool_policy']).toEqual(boundPolicy);
      return { text: 'Bound first.' };
    });

    const outcome = await makeExecutor(fn).executor.run(run, case_);

    expect(outcome.outcome).toBe('completed');
  });

  it('replays an identical bound snapshot without another bind write', async () => {
    const { case_, run } = seed({
      caseOverrides: { status: 'in_build' },
      runOverrides: {
        assistant_policy_state: 'bound',
        assistant_tool_policy: boundPolicy,
      },
    });
    const { fn } = fakeGenerate(async () => ({ text: 'Replay answered.' }));

    const outcome = await makeExecutor(fn).executor.run(run, case_);

    expect(outcome.outcome).toBe('completed');
    expect(commits).toHaveLength(1);
  });

  it('fails closed when an owned run is already bound to a different snapshot', async () => {
    const { case_, run } = seed({
      caseOverrides: { status: 'in_build' },
      runOverrides: {
        assistant_policy_state: 'bound',
        assistant_tool_policy: { ...boundPolicy, task_kind: 'general_question' },
      },
    });
    const generate = fakeGenerate(async () => ({ text: 'Never reached.' }));

    const outcome = await makeExecutor(generate.fn).executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'failed', reason: 'policy_binding_failed' });
    expect(generate.calls).toEqual([]);
  });

  it('starts no model work when cancel intent wins before policy binding', async () => {
    const { case_, run } = seed({
      caseOverrides: { status: 'in_build' },
      runOverrides: {
        status: 'cancelled',
        finished_at: '2026-08-04T10:00:00.000Z',
        worker_id: undefined,
        lease_expires_at: undefined,
        assistant_policy_state: 'unbound',
        assistant_cancel_intent: {
          revision: 1,
          requested_at: '2026-08-04T10:00:00.000Z',
          requested_by: REQUESTER,
        },
        assistant_cancel_reconcile_pending: true,
      },
    });
    const generate = fakeGenerate(async () => ({ text: 'Never reached.' }));
    const reconcile = vi.fn(async () => ({}) as never);

    const outcome = await makeExecutor(generate.fn, undefined, {
      cancellationService: { reconcile },
    }).executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'stood_down', reason: 'run_cancelled' });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(generate.calls).toEqual([]);
  });

  it('leaves the bound snapshot inspectable when the model attempt fails', async () => {
    const { case_, run } = seed({ caseOverrides: { status: 'in_build' } });
    const { fn } = fakeGenerate(async () => {
      throw new Error('provider unavailable');
    });

    const outcome = await makeExecutor(fn).executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'failed', reason: 'model_call_failed' });
    expect(collectionStore('runs').get(run.run_id)).toMatchObject({
      assistant_policy_state: 'bound',
      assistant_tool_policy: boundPolicy,
    });
  });

  it('does not commit a late result after the bound snapshot changes', async () => {
    const { case_, run } = seed({ caseOverrides: { status: 'in_build' } });
    const { fn } = fakeGenerate(async () => {
      const current = collectionStore('runs').get(run.run_id)!;
      collectionStore('runs').set(run.run_id, {
        ...current,
        assistant_tool_policy: { ...boundPolicy, task_kind: 'general_question' },
      });
      return { text: 'Stale policy answer.' };
    });

    const outcome = await makeExecutor(fn).executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'stood_down', reason: 'run_policy_changed' });
    expect(stored('artifacts')).toEqual([]);
    expect(stored('evidence')).toEqual([]);
    expect(collectionStore('cases').get(case_.case_id)!['status']).toBe('in_build');
  });
});

describe('AssistantTaskExecutor — follow-up context is a pre-model fence', () => {
  it('starts zero model calls when the pinned context cannot be resolved', async () => {
    const { case_, run } = seed({ caseOverrides: { status: 'in_build' } });
    const generate = fakeGenerate(async () => ({ text: 'Never reached.' }));

    const outcome = await makeExecutor(generate.fn, undefined, {
      loadFollowUpContext: async () => {
        throw new Error('pinned Artifact mismatch');
      },
    }).executor.run(run, case_);

    expect(outcome).toMatchObject({
      outcome: 'failed',
      reason: 'follow_up_context_invalid',
    });
    expect(generate.calls).toEqual([]);
    // Policy remains independently bound and inspectable even though context
    // validation stopped the attempt before the provider boundary.
    expect(collectionStore('runs').get(run.run_id)?.['assistant_policy_state']).toBe('bound');
  });

  it('passes the separately fenced preceding exchange to a fresh child attempt', async () => {
    const { case_, run } = seed({
      caseOverrides: { status: 'in_build', description: 'Which one is urgent?' },
    });
    const generate = fakeGenerate(async (args) => {
      expect(args.prompt).toContain('<untrusted_prior_request>\nWhich cases changed?');
      expect(args.prompt).toContain('<untrusted_prior_answer>\nThree cases changed.');
      expect(args.prompt).toContain('<untrusted_prior_tool_trace>');
      expect(args.prompt).toContain('<untrusted_user_request>\nWhich one is urgent?');
      return { text: 'Case A is urgent.' };
    });

    const outcome = await makeExecutor(generate.fn, undefined, {
      loadFollowUpContext: async () => [
        {
          caseId: 'case_parent',
          request: 'Which cases changed?',
          answer: 'Three cases changed.',
          toolTrace: '[{"name":"arbitra_search_cases"}]',
        },
      ],
    }).executor.run(run, case_);

    expect(outcome.outcome).toBe('completed');
    expect(generate.calls).toHaveLength(1);
  });
});

/**
 * Clerk had no clock, and the effect was a confidently conditional answer rather
 * than a missing one: asked how many cases were updated in the last 48 hours, it
 * offered two answers depending on what the date might be, having taken the newest
 * `updated_at` it read for the present. So the instant is handed to the model, and
 * recorded next to the answer it produced — an answer is read later than it was
 * written, and "the last 48 hours" moves in the meantime.
 */
describe("AssistantTaskExecutor — the requester's identity reaches the prompt", () => {
  it('injects the data block with the display name and email when the profile exists on the users doc', async () => {
    const { case_, run } = seed();
    collectionStore('users').set(REQUESTER, {
      user_id: REQUESTER,
      display_name: 'Alex Example',
      email: 'alex@example.com',
      roles: ['admin'],
    });
    const { fn, calls } = fakeGenerate(async () => ({ text: 'Answered.' }));
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome.outcome).toBe('completed');
    expect(calls[0]!.system).toContain('REQUESTER');
    expect(calls[0]!.system).toContain('Alex Example');
    expect(calls[0]!.system).toContain('alex@example.com');
    // Only display name and email reach the prompt — never the id or the roles
    // that sit right next to them on the same user document.
    expect(calls[0]!.system).not.toContain(REQUESTER);
    expect(calls[0]!.system).not.toContain('admin');
  });

  it('omits the block gracefully — not an empty or broken one — when the profile has no name or email', async () => {
    // The default `seed()` fixture's user doc: `{ user_id, roles: [] }`, no
    // display_name/email — the shape most existing tests in this file use.
    const { case_, run } = seed();
    const { fn, calls } = fakeGenerate(async () => ({ text: 'Answered.' }));
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome.outcome).toBe('completed');
    expect(calls[0]!.system).not.toContain('REQUESTER');
    // The standing UNTRUSTED CONTENT enumeration now names this tag alongside
    // the other three, always — see `assistant-prompt.test.ts`'s matching
    // test for why an opening-tag-shaped mention alone no longer signals a
    // real data block, and the closing tag is what must stay absent here.
    expect(calls[0]!.system).not.toContain('</untrusted_requester_identity>');
  });
});

/**
 * The requester's always-inject Clerk context (#832 slice A): knowledge
 * assets in their own private Clerk project marked `always_inject: true`,
 * fetched once, threaded into the prompt AND the stored trace from that one
 * fetch, and bounded by count and by characters.
 */
describe('AssistantTaskExecutor — always-inject Clerk context reaches the prompt and the trace (#832 slice A)', () => {
  function seedContextEntry(
    id: string,
    overrides: Partial<{
      title: string;
      body: string;
      always_inject: boolean;
      updated_at: string;
      scope_ref: string;
      type: string;
    }> = {},
  ) {
    collectionStore('knowledge_assets').set(id, {
      knowledge_id: id,
      type: 'clerk_context',
      title: 'Team roster',
      summary: 'Team roster',
      body: 'Team members: Alice, Bob, Carol.',
      scope_type: 'project',
      scope_ref: clerkCoreIds(REQUESTER).projectId,
      status: 'suggested',
      version: 1,
      trust_level: 0,
      source_case_refs: [],
      source_decision_refs: [],
      tags: [],
      artifact_refs: [],
      created_by: REQUESTER,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
      always_inject: true,
      ...overrides,
    });
  }

  function storedResultDocument(storage: { save: ReturnType<typeof vi.fn> }) {
    return JSON.parse(
      Buffer.from((storage.save.mock.calls[0] as unknown as string[])[2]!, 'base64').toString(
        'utf-8',
      ),
    );
  }

  it('threads one fetch into both the prompt and the trace — no double query', async () => {
    // Reverted line: removing the `injectedContext` argument from the
    // `buildAssistantSystemPrompt(asOf, requesterProfile, injectedContext)`
    // call in `assistant-task-executor.ts` makes the prompt assertion below
    // fail while the trace assertion still passes — proving the two would
    // disagree instead of coming from the same fetch.
    const { case_, run } = seed();
    seedContextEntry('ka_roster');
    const { fn, calls } = fakeGenerate(async () => ({ text: 'Answered.' }));
    const { executor, storage } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome.outcome).toBe('completed');
    expect(calls[0]!.system).toContain('STANDING CONTEXT');
    expect(calls[0]!.system).toContain('Team roster');
    expect(calls[0]!.system).toContain('Team members: Alice, Bob, Carol.');

    const document = storedResultDocument(storage);
    expect(document.injected_context).toEqual([
      { knowledge_id: 'ka_roster', title: 'Team roster' },
    ]);
    // The trace names the entry but never carries its body.
    expect(JSON.stringify(document.injected_context)).not.toContain('Alice');

    // Exactly one query against the collection for the whole attempt.
    expect(collections.knowledgeAssets).toHaveBeenCalledTimes(1);
  });

  it('omits the section and reports an empty trace when nothing is marked always-inject', async () => {
    const { case_, run } = seed();
    seedContextEntry('ka_not_injected', { always_inject: false });
    const { fn, calls } = fakeGenerate(async () => ({ text: 'Answered.' }));
    const { executor, storage } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome.outcome).toBe('completed');
    expect(calls[0]!.system).not.toContain('STANDING CONTEXT');
    const document = storedResultDocument(storage);
    expect(document.injected_context).toEqual([]);
  });

  it('ignores always-inject entries scoped to a different project', async () => {
    const { case_, run } = seed();
    seedContextEntry('ka_other', { scope_ref: 'proj_clerk_someone_else' });
    const { fn, calls } = fakeGenerate(async () => ({ text: 'Answered.' }));
    const { executor, storage } = makeExecutor(fn);

    await executor.run(run, case_);

    expect(calls[0]!.system).not.toContain('STANDING CONTEXT');
    expect(storedResultDocument(storage).injected_context).toEqual([]);
  });

  it('drops entries beyond the entry-count bound, keeping the most recently updated', async () => {
    // Reverted line: removing the `applyInjectedContextBounds` call in
    // `loadInjectedContext` makes this fail — all three entries would reach
    // the prompt and the trace instead of the two the override allows.
    process.env['ARBITRA_ASSISTANT_MAX_INJECTED_CONTEXT_ENTRIES'] = '2';
    try {
      const { case_, run } = seed();
      seedContextEntry('ka_oldest', { title: 'Oldest', updated_at: '2026-07-01T00:00:00.000Z' });
      seedContextEntry('ka_middle', { title: 'Middle', updated_at: '2026-07-15T00:00:00.000Z' });
      seedContextEntry('ka_newest', { title: 'Newest', updated_at: '2026-08-01T00:00:00.000Z' });
      const { fn } = fakeGenerate(async () => ({ text: 'Answered.' }));
      const { executor, storage } = makeExecutor(fn);

      await executor.run(run, case_);

      const document = storedResultDocument(storage);
      expect(document.injected_context).toHaveLength(2);
      expect(document.bounds.max_injected_context_entries).toBe(2);
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_INJECTED_CONTEXT_ENTRIES'];
    }
  });

  it('drops entries beyond the char bound', async () => {
    process.env['ARBITRA_ASSISTANT_MAX_INJECTED_CONTEXT_CHARS'] = '10';
    try {
      const { case_, run } = seed();
      seedContextEntry('ka_roster', { title: 'Team roster', body: 'a much longer body than ten characters' });
      const { fn, calls } = fakeGenerate(async () => ({ text: 'Answered.' }));
      const { executor, storage } = makeExecutor(fn);

      await executor.run(run, case_);

      expect(calls[0]!.system).not.toContain('STANDING CONTEXT');
      expect(storedResultDocument(storage).injected_context).toEqual([]);
      expect(storedResultDocument(storage).bounds.max_injected_context_chars).toBe(10);
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_INJECTED_CONTEXT_CHARS'];
    }
  });

  it('fails the attempt rather than silently omitting context when the fetch itself errors', async () => {
    const { case_, run } = seed();
    collections.knowledgeAssets.mockImplementationOnce(() => {
      throw new Error('Firestore unavailable');
    });
    const { fn } = fakeGenerate(async () => ({ text: 'Answered.' }));
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome.outcome).toBe('failed');
    expect((outcome as { reason: string }).reason).toBe('injected_context_load_failed');
  });
});

describe('AssistantTaskExecutor — the attempt has a clock', () => {
  const NOW = new Date('2026-08-04T07:39:35.412Z');

  it('hands the current instant to the model and records it on the artifact', async () => {
    const { case_, run } = seed({
      caseOverrides: { description: 'How many cases were updated in the last two days?' },
    });
    const { fn, calls } = fakeGenerate(async () => ({ text: 'None were.' }));
    const { executor, storage } = makeExecutor(fn, undefined, { now: () => NOW });

    const outcome = await executor.run(run, case_);

    expect(outcome.outcome).toBe('completed');
    // What the model was told.
    expect(calls[0]!.system).toContain('2026-08-04T07:39:35Z');
    expect(calls[0]!.system).toContain('CURRENT TIME');

    const document = JSON.parse(
      Buffer.from((storage.save.mock.calls[0] as unknown as string[])[2]!, 'base64').toString(
        'utf-8',
      ),
    );
    // The same instant, so the answer can be read against the moment it was
    // written rather than against whenever it is opened.
    expect(document.as_of).toBe(NOW.toISOString());
    // Still not the prompt itself — only the instant travels into the artifact.
    expect(JSON.stringify(document)).not.toContain('You are Clerk');
  });

  it('uses one instant for the prompt and the record, not two readings of the clock', async () => {
    const { case_, run } = seed();
    const ticks = [
      new Date('2026-08-04T07:39:35.000Z'),
      new Date('2026-08-04T07:39:41.000Z'),
      new Date('2026-08-04T07:39:44.000Z'),
    ];
    let tick = 0;
    const { fn, calls } = fakeGenerate(async () => ({ text: 'Answered.' }));
    const { executor, storage } = makeExecutor(fn, undefined, {
      now: () => ticks[Math.min(tick++, ticks.length - 1)]!,
    });

    await executor.run(run, case_);

    const document = JSON.parse(
      Buffer.from((storage.save.mock.calls[0] as unknown as string[])[2]!, 'base64').toString(
        'utf-8',
      ),
    );
    // `as_of` is the instant the model reasoned from, which is the first reading.
    // `created_at` is when the result was stored — close, but a different fact, so
    // the two are recorded separately rather than one standing in for the other.
    expect(document.as_of).toBe(ticks[0]!.toISOString());
    expect(calls[0]!.system).toContain('2026-08-04T07:39:35Z');
    expect(document.created_at).not.toBe(document.as_of);
  });
});

describe('AssistantTaskExecutor — a second ask for the answer is on the record', () => {
  it('completes a run whose reserved step was empty but whose second ask answered', async () => {
    const { case_, run } = seed({
      caseOverrides: { description: 'How many cases are open in Arbitra?' },
    });
    const answer = 'No cases are open.';
    const { fn, retries } = fakeGenerateEmptyThenAnswer({
      toolName: 'arbitra_search_cases',
      answerOnRetry: answer,
    });
    process.env['ARBITRA_ASSISTANT_MAX_STEPS'] = '3';
    try {
      const { executor, storage } = makeExecutor(fn);

      const outcome = await executor.run(run, case_);

      // The whole point: this shape produced `bound:max_steps` and a rejected case
      // before, and two of the first five real runs took it.
      expect(outcome.outcome).toBe('completed');
      expect(collectionStore('cases').get(case_.case_id)!['status']).toBe('done');
      expect(retries()).toHaveLength(1);
      // Authorship stayed with the model: the stored answer is its own text.
      const document = JSON.parse(
        Buffer.from((storage.save.mock.calls[0] as unknown as string[])[2]!, 'base64').toString(
          'utf-8',
        ),
      );
      expect(document.answer).toBe(answer);
      expect(document.answer_retried).toBe(true);
      expect(document.reads_withheld).toBe(true);
      // The reads it did make are still on the record.
      expect(document.tool_calls).toHaveLength(2);
      const evidence = stored('evidence') as unknown as Evidence[];
      expect(evidence[0]!.summary).toBe(answer);
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_STEPS'];
    }
  });

  /**
   * The three numbers are stored together and rendered as one line, so they have to
   * agree. The retry's tokens used to be counted twice into the split while the
   * total learned about them once, and every retried run therefore stored a block
   * whose parts summed to more than its own total.
   */
  it('stores a usage block that adds up, and a step count inside the stated ceiling', async () => {
    const { case_, run } = seed();
    const { fn } = fakeGenerateEmptyThenAnswer({
      toolName: 'arbitra_search_cases',
      answerOnRetry: 'No cases are open.',
    });
    process.env['ARBITRA_ASSISTANT_MAX_STEPS'] = '3';
    try {
      const { executor, storage } = makeExecutor(fn);

      await executor.run(run, case_);

      const document = JSON.parse(
        Buffer.from((storage.save.mock.calls[0] as unknown as string[])[2]!, 'base64').toString(
          'utf-8',
        ),
      );
      expect(document.answer_retried).toBe(true);
      expect(document.usage.input_tokens + document.usage.output_tokens).toBe(
        document.usage.total_tokens,
      );
      // What the run's cost record shows, which is the same arithmetic.
      const usage = collectionStore('runs').get(run.run_id)!['token_usage'] as DocData;
      expect((usage['prompt_tokens'] as number) + (usage['completion_tokens'] as number)).toBe(
        usage['total_tokens'],
      );
      // `steps` means steps of the ceiling, and the ceiling is printed beside it:
      // an audit for "did this attempt respect its own bound" must not fire on
      // every retried run, and the panel must not show a count above the bound.
      expect(document.steps).toBeLessThanOrEqual(document.bounds.max_steps);
      // The extra model call is reported next to the count instead.
      const completion = stored('case_events').find((e) => e['type'] === 'run_completed')!;
      expect((completion['payload'] as DocData)['answer_retried']).toBe(true);
      expect((completion['payload'] as DocData)['steps']).toBe(document.steps);
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_STEPS'];
    }
  });

  /**
   * The question `answer_retried` exists to answer — how often does the first ask
   * come back empty — is mostly answered by runs that failed anyway. Recording it
   * only on the completed path leaves exactly the subset where the problem had
   * already solved itself.
   */
  it('records the second ask on the failure path, and says so in the run message', async () => {
    const { case_, run } = seed();
    const { fn, retries } = fakeGenerateEmptyThenAnswer({
      toolName: 'arbitra_search_cases',
      answerOnRetry: '',
    });
    process.env['ARBITRA_ASSISTANT_MAX_STEPS'] = '3';
    try {
      const { executor } = makeExecutor(fn);

      const outcome = await executor.run(run, case_);

      expect(retries()).toHaveLength(1);
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'bound:max_steps' });
      expect(outcome.message).toContain('on the first ask or the plainer second one');
      const failure = stored('case_events').find((e) => e['type'] === 'assistant_task_failed')!;
      const payload = failure['payload'] as DocData;
      expect(payload['answer_retried']).toBe(true);
      // Same payload, same reads: a failed attempt still says what it read.
      expect(payload['tool_call_records']).toHaveLength(2);
      expect(payload['bounds']).toBeDefined();
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_STEPS'];
    }
  });

  it('does not claim a second ask on a run that never made one', async () => {
    // `fakeGenerateToCeiling` reports no `response.messages`, so the retry declines
    // — the run fails with one ask, and the sentence stored as its `error_message`
    // has to say that rather than describing a call that did not happen.
    const { case_, run } = seed();
    const { fn } = fakeGenerateToCeiling('arbitra_search_cases', '');
    process.env['ARBITRA_ASSISTANT_MAX_STEPS'] = '3';
    try {
      const { executor } = makeExecutor(fn);

      const outcome = await executor.run(run, case_);

      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'bound:max_steps' });
      expect(outcome.message).toContain('on the one ask it was given');
      expect(outcome.message).not.toContain('second');
      const failure = stored('case_events').find((e) => e['type'] === 'assistant_task_failed')!;
      expect((failure['payload'] as DocData)['answer_retried']).toBe(false);
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_STEPS'];
    }
  });

  it('completes a run whose reserved step went to tool calls but whose second ask answered', async () => {
    // The observed production shape (issue #785): the provider read past
    // `toolChoice: 'none'`, the attempt ended `finish_reason: 'tool-calls'`, and
    // `answer_retried` stayed false — the rescue never ran. Same deploy answered
    // a sibling question in one call, so the mechanism, not the clock, was the gap.
    const { case_, run } = seed({
      caseOverrides: { description: 'How many cases did we implement the last 48h?' },
    });
    const answer = 'Three cases were completed in the last 48 hours.';
    const { fn, retries } = fakeGenerateToolCallsThenAnswer({
      toolName: 'arbitra_search_cases',
      preamble: 'Let me page through the remaining cases.',
      answerOnRetry: answer,
    });
    process.env['ARBITRA_ASSISTANT_MAX_STEPS'] = '3';
    try {
      const { executor, storage } = makeExecutor(fn);

      const outcome = await executor.run(run, case_);

      expect(outcome.outcome).toBe('completed');
      expect(retries()).toHaveLength(1);
      const document = JSON.parse(
        Buffer.from((storage.save.mock.calls[0] as unknown as string[])[2]!, 'base64').toString(
          'utf-8',
        ),
      );
      // The answer is the second ask's text; the preamble was never stored.
      expect(document.answer).toBe(answer);
      expect(document.answer).not.toContain('Let me page');
      expect(document.answer_retried).toBe(true);
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_STEPS'];
    }
  });

  it('keeps the discarded preamble on the failure event when the second ask also fails', async () => {
    const { case_, run } = seed();
    const preamble = 'Let me page through the remaining cases.';
    const { fn, retries } = fakeGenerateToolCallsThenAnswer({
      toolName: 'arbitra_search_cases',
      preamble,
      answerOnRetry: '',
    });
    process.env['ARBITRA_ASSISTANT_MAX_STEPS'] = '3';
    try {
      const { executor } = makeExecutor(fn);

      const outcome = await executor.run(run, case_);

      expect(retries()).toHaveLength(1);
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'bound:max_steps' });
      const failure = stored('case_events').find((e) => e['type'] === 'assistant_task_failed')!;
      const payload = failure['payload'] as DocData;
      expect(payload['answer_retried']).toBe(true);
      // The last thing the model said, preserved as what it is — a preamble on a
      // failed attempt — never as a governed answer.
      expect(payload['discarded_preamble']).toBe(preamble);
      expect(stored('evidence')).toHaveLength(0);
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_STEPS'];
    }
  });

  it('records answer_retried false for an attempt that answered first time', async () => {
    const { case_, run } = seed();
    const { fn } = fakeGenerate(async () => ({ text: 'One case is open.' }));
    const { executor, storage } = makeExecutor(fn);

    await executor.run(run, case_);

    const document = JSON.parse(
      Buffer.from((storage.save.mock.calls[0] as unknown as string[])[2]!, 'base64').toString(
        'utf-8',
      ),
    );
    expect(document.answer_retried).toBe(false);
  });
});

describe('AssistantTaskExecutor — the policy decides the tool set', () => {
  it('keeps read tools available when the classifier labels a general question', async () => {
    // Title AND description: the policy reads both, because intake derives the
    // title from the request text and either could carry the signal.
    const { case_, run } = seed({
      caseOverrides: {
        title: 'Rewrite this sentence',
        description: 'Rewrite this sentence more politely, please.',
      },
    });
    const { fn, calls } = fakeGenerate(async () => ({ text: 'Here is a politer version.' }));
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome.outcome).toBe('completed');
    // Reintroducing the keyword gate makes this empty again.
    expect(Object.keys(calls[0]!.tools)).toEqual([
      'arbitra_search_cases',
      'arbitra_count_cases',
      'arbitra_count_case_transitions',
      'arbitra_get_case',
      'arbitra_search_knowledge',
      'arbitra_get_knowledge',
    ]);
  });

  it('does not let the classifier narrow a case question to a hand-picked subset', async () => {
    const { case_, run } = seed({
      caseOverrides: {
        title: 'List the evidence on my cases',
        description: 'List the evidence on my open cases.',
      },
    });
    const { fn, calls } = fakeGenerate(async () => ({ text: 'Nothing yet.' }));
    const { executor } = makeExecutor(fn);

    await executor.run(run, case_);

    expect(Object.keys(calls[0]!.tools)).toEqual([
      'arbitra_search_cases',
      'arbitra_count_cases',
      'arbitra_count_case_transitions',
      'arbitra_get_case',
      'arbitra_search_knowledge',
      'arbitra_get_knowledge',
    ]);
  });
});

describe('AssistantTaskExecutor — nothing is persisted unless everything is', () => {
  it('discards the result when the case is cancelled mid-flight', async () => {
    const { case_, run } = seed();
    const { fn } = fakeGenerate(async () => {
      // The case is soft-deleted while the model is working.
      const current = collectionStore('cases').get(case_.case_id)!;
      collectionStore('cases').set(case_.case_id, {
        ...current,
        deleted_at: '2026-08-03T10:01:00.000Z',
        deleted_by: REQUESTER,
      });
      return { text: 'An answer nobody asked for any more.' };
    });
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'discarded', reason: 'case_unavailable' });
    expect(stored('artifacts')).toEqual([]);
    expect(stored('evidence')).toEqual([]);
    expect(collectionStore('runs').get(run.run_id)!['status']).toBe('running');
    expect(storedEventTypes()).not.toContain('run_completed');
  });

  it('discards the result when the case reached a terminal status mid-flight', async () => {
    const { case_, run } = seed();
    const { fn } = fakeGenerate(async () => {
      const current = collectionStore('cases').get(case_.case_id)!;
      collectionStore('cases').set(case_.case_id, { ...current, status: 'rejected' });
      return { text: 'An answer for a rejected case.' };
    });
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'discarded', reason: 'case_terminal' });
    expect(stored('artifacts')).toEqual([]);
    expect(stored('evidence')).toEqual([]);
  });

  it('stands down without touching the run when the run stopped being ours mid-flight', async () => {
    const { case_, run } = seed();
    const { fn } = fakeGenerate(async () => {
      const current = collectionStore('runs').get(run.run_id)!;
      collectionStore('runs').set(run.run_id, { ...current, status: 'failed' });
      return { text: 'An answer for a run someone else already failed.' };
    });
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'stood_down', reason: 'run_failed' });
    expect(stored('artifacts')).toEqual([]);
    expect(stored('evidence')).toEqual([]);
    expect(collectionStore('runs').get(run.run_id)!['status']).toBe('failed');
  });

  it('writes none of the five documents when the commit itself fails', async () => {
    const { case_, run } = seed();
    const { fn } = fakeGenerate(async () => {
      // Fail the NEXT commit — the completion, not the in_build transition.
      failNextCommit = 'ETIMEDOUT: firestore unavailable';
      return { text: 'An answer that never lands.' };
    });
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome.outcome).toBe('failed');
    expect(stored('artifacts')).toEqual([]);
    expect(stored('evidence')).toEqual([]);
    expect(collectionStore('runs').get(run.run_id)!['status']).toBe('running');
    // Still `in_build` from the first transaction, never `done`.
    expect(collectionStore('cases').get(case_.case_id)!['status']).toBe('in_build');
    expect(storedEventTypes()).toContain('assistant_task_failed');
    expect(storedEventTypes()).not.toContain('assistant_task_completed');
  });
});

describe('AssistantTaskExecutor — an attempt that cannot produce a trustworthy answer', () => {
  it('fails the attempt with the bound as the recorded reason, persisting no result', async () => {
    const { case_, run } = seed({
      caseOverrides: { description: 'List my open cases in Arbitra.' },
    });
    // The token budget, not the tool-call allowance: it fires mid-generation and
    // aborts, which is the class of bound that still fails an attempt. The reads
    // it interrupts are what this test follows into the event payload.
    const { fn } = fakeGenerate(async (args) => {
      await args.tools['arbitra_search_cases']!.execute({});
      await args.tools['arbitra_search_cases']!.execute({});
      args.onStepFinish?.({ usage: { inputTokens: 600, outputTokens: 600 } });
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    process.env['ARBITRA_ASSISTANT_TOKEN_BUDGET'] = '1000';
    const outcomeLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { executor } = makeExecutor(fn);
      const outcome = await executor.run(run, case_);

      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'bound:token_budget' });
      expect((outcome as { message: string }).message).toContain('token_budget');
      expect(stored('artifacts')).toEqual([]);
      expect(stored('evidence')).toEqual([]);
      const failure = stored('case_events').find((e) => e['type'] === 'assistant_task_failed')!;
      const payload = failure['payload'] as DocData;
      expect(payload['reason']).toBe('bound:token_budget');
      // The reads happened on the requester's behalf. A payload that says only
      // "2" leaves an audit trail that cannot name what was read.
      expect(payload['tool_calls']).toBe(2);
      expect(payload['tool_call_records']).toMatchObject([
        { name: 'arbitra_search_cases', outcome: 'ok' },
        { name: 'arbitra_search_cases', outcome: 'ok' },
      ]);
      const logLine = outcomeLog.mock.calls
        .map(([value]) => String(value))
        .find((value) => value.includes('"event":"assistant_run_outcome"'));
      expect(logLine).toBeDefined();
      expect(JSON.parse(logLine!)).toMatchObject({
        event: 'assistant_run_outcome',
        outcome: 'failed',
        run_id: run.run_id,
        case_id: case_.case_id,
        attempt: 1,
        reason: 'bound:token_budget',
        bound: 'token_budget',
        tool_call_count: 2,
      });
      expect(JSON.parse(logLine!).duration_ms).toEqual(expect.any(Number));
    } finally {
      outcomeLog.mockRestore();
      delete process.env['ARBITRA_ASSISTANT_TOKEN_BUDGET'];
    }
  });

  it('refuses to persist an answer that claims to have acted', async () => {
    const { case_, run } = seed();
    const { fn } = fakeGenerate(async () => ({ text: 'I have created a case for you.' }));
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'failed', reason: 'answer:claims_action' });
    expect(stored('evidence')).toEqual([]);
    expect(collectionStore('cases').get(case_.case_id)!['status']).toBe('in_build');
  });

  it('refuses to persist an empty answer', async () => {
    const { case_, run } = seed();
    const { fn } = fakeGenerate(async () => ({ text: '   ' }));
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'failed', reason: 'answer:empty_answer' });
    expect(stored('evidence')).toEqual([]);
  });
});

describe('AssistantTaskExecutor — an answer produced with the reads already spent', () => {
  it('completes the case, records the withholding as metadata, and stores the answer verbatim', async () => {
    const { case_, run } = seed({
      caseOverrides: { description: 'List my open cases in Arbitra.' },
    });
    const answer = 'I could not check every case. Of those I read, two are open.';
    const { fn } = fakeGenerateToCeiling('arbitra_search_cases', answer);
    // Three steps: two usable for reads, the third reserved for the answer.
    process.env['ARBITRA_ASSISTANT_MAX_STEPS'] = '3';
    try {
      const { executor, storage } = makeExecutor(fn);

      const outcome = await executor.run(run, case_);

      // Not a failed run: the requester gets the part that was checked.
      expect(outcome.outcome).toBe('completed');
      const doneCase = collectionStore('cases').get(case_.case_id)!;
      expect(doneCase['status']).toBe('done');
      // #858: this is the fact the Scheduled tab's occurrence badge reads —
      // GET /api/assistant/tasks projects it straight off
      // `assistant_context`, not off the run's `run_completed` event payload
      // (checked separately below), because the tasks list route reads
      // cases, not events. Reverting the `extraCaseUpdates` stamp in
      // `assistant-task-executor.ts` back to just `task_kind` (no
      // `reads_withheld`) makes this line fail even though every assertion
      // below it (artifact, event payloads) keeps passing.
      expect((doneCase['assistant_context'] as DocData)['reads_withheld']).toBe(true);
      expect((doneCase['assistant_context'] as DocData)['reads_withheld_reason']).toBe('step_budget');

      const document = JSON.parse(
        Buffer.from((storage.save.mock.calls[0] as unknown as string[])[2]!, 'base64').toString(
          'utf-8',
        ),
      );
      // Exactly the model's text. The gap in it is the model's own statement, in
      // its own words; nothing machine-authored asserts one on top of it, because
      // the executor cannot know whether there is one.
      expect(document.answer).toBe(answer);
      // The fact, machine-readable, for anyone auditing later.
      expect(document.reads_withheld).toBe(true);
      expect(document.reads_withheld_reason).toBe('step_budget');
      expect(document.tool_calls).toHaveLength(2);
      expect(document.bounds.max_steps).toBe(3);
      expect(document.bounds.tool_step_budget).toBe(2);

      const completion = stored('case_events').find((e) => e['type'] === 'run_completed')!;
      expect((completion['payload'] as DocData)['reads_withheld']).toBe(true);
      expect((completion['payload'] as DocData)['reads_withheld_reason']).toBe('step_budget');

      // The event whose NAME says the task is answered carries the fact too: a
      // consumer keying on it must be able to tell this apart from an attempt that
      // still had reads to spare.
      const completed = stored('case_events').find(
        (e) => e['type'] === 'assistant_task_completed',
      )!;
      expect((completed['payload'] as DocData)['reads_withheld']).toBe(true);
      expect((completed['payload'] as DocData)['reads_withheld_reason']).toBe('step_budget');

      // The evidence summary is the answer's own preview — all 280 characters of
      // it available to the model's text, none spent on a machine notice.
      const evidence = stored('evidence') as unknown as Evidence[];
      expect(evidence[0]!.summary).toBe(answer);
      const summary = collectionStore('runs').get(run.run_id)!['summary'] as string;
      expect(summary).toContain('no reads left');
      expect(summary).toContain('step_budget');
      // Nothing in the audit trail calls the answer incomplete.
      expect(summary).not.toContain('incomplete');
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_STEPS'];
    }
  });

  it('records the withholding for an attempt that spent its steps without reading anything', async () => {
    const { case_, run } = seed();
    const { fn } = fakeGenerate(async () => ({
      text: 'Nothing needed a read; here is the answer.',
      steps: 2,
      finishReason: 'stop',
    }));
    // Two steps, so the second one is the reserved one. No tool call anywhere —
    // the fact is about the step the answer came from, not about the trace.
    process.env['ARBITRA_ASSISTANT_MAX_STEPS'] = '2';
    try {
      const { executor, storage } = makeExecutor(fn);

      const outcome = await executor.run(run, case_);

      expect(outcome.outcome).toBe('completed');
      const document = JSON.parse(
        Buffer.from((storage.save.mock.calls[0] as unknown as string[])[2]!, 'base64').toString(
          'utf-8',
        ),
      );
      expect(document.answer).toBe('Nothing needed a read; here is the answer.');
      expect(document.reads_withheld).toBe(true);
      expect(document.reads_withheld_reason).toBe('step_budget');
      expect(document.tool_calls).toEqual([]);
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_STEPS'];
    }
  });

  it('keeps an answer at the length limit that the removed notice would have failed', async () => {
    const { case_, run } = seed({
      caseOverrides: { description: 'List my open cases in Arbitra.' },
    });
    // 7,900 characters against a limit of 8,000: inside the budget, but not by the
    // 142 characters a prepended notice used to cost. The same answer passed on
    // the untouched-budget path and failed `answer_too_long` here.
    const answer = `A. ${'x'.repeat(7_897)}`;
    const { fn } = fakeGenerateToCeiling('arbitra_search_cases', answer);
    process.env['ARBITRA_ASSISTANT_MAX_STEPS'] = '3';
    try {
      const { executor, storage } = makeExecutor(fn);

      const outcome = await executor.run(run, case_);

      expect(answer).toHaveLength(7_900);
      expect(outcome.outcome).toBe('completed');
      const document = JSON.parse(
        Buffer.from((storage.save.mock.calls[0] as unknown as string[])[2]!, 'base64').toString(
          'utf-8',
        ),
      );
      expect(document.answer).toHaveLength(7_900);
      expect(document.reads_withheld).toBe(true);
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_STEPS'];
    }
  });

  it('completes the case when the tool-call allowance ran out mid-step, keeping every read', async () => {
    const { case_, run } = seed({
      caseOverrides: { description: 'Summarise my four open cases in Arbitra.' },
    });
    const { fn } = fakeGenerateParallel({
      toolName: 'arbitra_search_cases',
      callsOnFirstStep: 4,
      answer: 'Three of the four cases are open; I could not read the fourth.',
    });
    // Three reads allowed, four requested in ONE step — the shape the configured
    // provider produces (`ARBITRA_LLM_PROVIDER=google` emits parallel calls).
    // Pre-fix the refusal aborted the generation and the attempt died with
    // `bound:max_tool_calls`, discarding all three completed reads.
    process.env['ARBITRA_ASSISTANT_MAX_TOOL_CALLS'] = '3';
    try {
      const { executor, storage } = makeExecutor(fn);

      const outcome = await executor.run(run, case_);

      expect(outcome.outcome).toBe('completed');
      expect(collectionStore('cases').get(case_.case_id)!['status']).toBe('done');
      const document = JSON.parse(
        Buffer.from((storage.save.mock.calls[0] as unknown as string[])[2]!, 'base64').toString(
          'utf-8',
        ),
      );
      expect(document.answer).toBe('Three of the four cases are open; I could not read the fourth.');
      expect(document.reads_withheld).toBe(true);
      // The allowance, not the ceiling: the reading ended before the reserved step.
      expect(document.reads_withheld_reason).toBe('tool_call_budget');
      // Three completed reads plus the refusal, all on the record.
      expect(document.tool_calls).toHaveLength(4);
      expect(
        (document.tool_calls as { outcome: string }[]).filter((c) => c.outcome === 'ok'),
      ).toHaveLength(3);
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_TOOL_CALLS'];
    }
  });
});

describe('AssistantTaskExecutor — preflight refusals', () => {
  it('fails an attempt whose requester lost membership of the case project', async () => {
    const { case_, run } = seed();
    collectionStore('projects').set(PROJECT, {
      project_id: PROJECT,
      name: 'Clerk',
      owner_user_id: 'usr_someone_else',
      members: [],
      reviewer_pool: [],
      tech_leads: [],
    });
    const { fn } = fakeGenerate(async () => ({ text: 'never reached' }));
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'failed', reason: 'requester_not_member' });
    expect(commits).toEqual([]);
  });

  it('fails an attempt whose requester no longer exists', async () => {
    const { case_, run } = seed();
    collectionStore('users').delete(REQUESTER);
    const { fn } = fakeGenerate(async () => ({ text: 'never reached' }));
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'failed', reason: 'requester_unknown' });
  });

  it('fails an attempt whose task text is empty', async () => {
    const { case_, run } = seed({ caseOverrides: { description: '   ' } });
    const { fn } = fakeGenerate(async () => ({ text: 'never reached' }));
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'failed', reason: 'input:empty_text' });
    expect(commits).toEqual([]);
  });

  it('discards an attempt for an already-terminal case without calling the model', async () => {
    const { case_, run } = seed({ caseOverrides: { status: 'done' } });
    const generate = fakeGenerate(async () => ({ text: 'never reached' }));
    const { executor } = makeExecutor(generate.fn);

    const outcome = await executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'discarded', reason: 'case_terminal' });
    expect(generate.calls).toEqual([]);
  });

  it('discards an attempt for a case parked in a status no attempt can complete from', async () => {
    const { case_, run } = seed({ caseOverrides: { status: 'needs_human_decision' } });
    const generate = fakeGenerate(async () => ({ text: 'never reached' }));
    const { executor } = makeExecutor(generate.fn);

    const outcome = await executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'discarded', reason: 'case_status_not_executable' });
    expect(generate.calls).toEqual([]);
  });

  it('stands down when the run was already claimed by someone else', async () => {
    const { case_, run } = seed({ runOverrides: { worker_id: 'worker_b' } });
    const generate = fakeGenerate(async () => ({ text: 'never reached' }));
    const { executor } = makeExecutor(generate.fn);

    const outcome = await executor.run({ ...run, worker_id: 'worker_a' }, case_);

    expect(outcome).toMatchObject({ outcome: 'stood_down', reason: 'run_reassigned' });
    expect(generate.calls).toEqual([]);
  });

  it('does not bind a pending run even when it carries a worker id', async () => {
    // Reverting the owned-status CAS from `running` to worker-id-only would let
    // a half-claimed attempt reach the model.
    const { case_, run } = seed({
      caseOverrides: { status: 'in_build' },
      runOverrides: { status: 'pending', attempt: 2 },
    });
    const { fn } = fakeGenerate(async () => ({ text: 'The retry answered.' }));
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome).toMatchObject({
      outcome: 'stood_down',
      reason: 'policy_bind:run_not_running',
    });
    expect(collectionStore('runs').get(run.run_id)!['status']).toBe('pending');
  });

  it('stands down on an unclaimed pending run without calling the model', async () => {
    const { case_, run } = seed({ runOverrides: { status: 'pending' } });
    delete run.worker_id;
    delete run.lease_expires_at;
    const storedRun = collectionStore('runs').get(run.run_id)!;
    delete storedRun['worker_id'];
    delete storedRun['lease_expires_at'];
    const before = { ...storedRun };
    const generate = fakeGenerate(async () => ({ text: 'never reached' }));
    const { executor } = makeExecutor(generate.fn);

    const outcome = await executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'stood_down', reason: 'run_unclaimed' });
    expect(generate.calls).toEqual([]);
    expect(collectionStore('runs').get(run.run_id)).toEqual(before);
    expect(collectionStore('runs').get(run.run_id)!['status']).toBe('pending');
  });

  it('still executes the claim-less hand-over an adapter without claimRun dispatches', async () => {
    // `RunExecutor.claimIfUnclaimed` passes an `awaiting_claim` run straight
    // through when the adapter implements no `claimRun`. That is a property of
    // the adapter, handed over as `claimCapable: false` — not something read
    // off the run document.
    const { case_, run } = seed({
      caseOverrides: { status: 'in_build' },
      runOverrides: { status: 'pending', awaiting_claim: true },
    });
    delete run.worker_id;
    delete run.lease_expires_at;
    const storedRun = collectionStore('runs').get(run.run_id)!;
    delete storedRun['worker_id'];
    delete storedRun['lease_expires_at'];
    const { fn } = fakeGenerate(async () => ({ text: 'The unclaimed hand-over answered.' }));
    const { executor } = makeExecutor(fn, undefined, { claimCapable: false });

    const outcome = await executor.run(run, case_);

    expect(outcome.outcome).toBe('completed');
    expect(collectionStore('runs').get(run.run_id)!['status']).toBe('completed');
  });

  it('stands down on an unowned run that still carries awaiting_claim when the adapter CAN claim', async () => {
    // A set `awaiting_claim` flag does not mean "no claim support": the claim
    // may have lost its race or thrown. On a claim-capable adapter an unowned
    // run is therefore never ours, whatever the flag says — otherwise one
    // transient claim error would run a real task unowned.
    const { case_, run } = seed({
      caseOverrides: { status: 'in_build' },
      runOverrides: { status: 'pending', awaiting_claim: true },
    });
    delete run.worker_id;
    delete run.lease_expires_at;
    const storedRun = collectionStore('runs').get(run.run_id)!;
    delete storedRun['worker_id'];
    delete storedRun['lease_expires_at'];
    const generate = fakeGenerate(async () => ({ text: 'never reached' }));
    const { executor } = makeExecutor(generate.fn);

    const outcome = await executor.run(run, case_);

    expect(outcome).toMatchObject({ outcome: 'stood_down', reason: 'run_unclaimed' });
    expect(generate.calls).toEqual([]);
    expect(collectionStore('runs').get(run.run_id)!['status']).toBe('pending');
  });

  it.each([['completed'], ['cancelled']])(
    'stands down on a run already %s, so a terminal run is never resurrected',
    async (status) => {
      const { case_, run } = seed({ runOverrides: { status: status as Run['status'] } });
      const generate = fakeGenerate(async () => ({ text: 'never reached' }));
      const { executor } = makeExecutor(generate.fn);

      const outcome = await executor.run(run, case_);

      expect(outcome).toMatchObject({ outcome: 'stood_down', reason: `run_${status}` });
      expect(generate.calls).toEqual([]);
    },
  );

  it('resumes an attempt on a case already in_build without transitioning again', async () => {
    const { case_, run } = seed({ caseOverrides: { status: 'in_build' } });
    const { fn } = fakeGenerate(async () => ({ text: 'A second attempt answered.' }));
    const { executor } = makeExecutor(fn);

    const outcome = await executor.run(run, case_);

    expect(outcome.outcome).toBe('completed');
    // Policy bind plus completion — no second `in_build` transition.
    expect(commits).toHaveLength(2);
  });
});
