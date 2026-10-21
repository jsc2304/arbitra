import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

/**
 * The registry's job is a guarantee, not a feature: Clerk cannot be handed a
 * tool with an external effect. Everything here pins one half of that —
 *
 *  - the *shape* half: `'write'` is not a value the effect union has, and a
 *    descriptor carrying a handler that could act is refused at the boundary;
 *  - the *plumbing* half: only the tools the policy returned become `Tool`s at
 *    all, the per-attempt bounds are enforced around every call, and the trace
 *    records only what the descriptor declared belongs in evidence.
 *
 * The registry pulls in `tool-reads.ts`, which reads Firestore. It is mocked so
 * this file exercises the machinery rather than the queries (those are
 * `tool-reads.test.ts`).
 */
vi.mock('../../lib/firestore.js', () => ({
  getDb: () => {
    throw new Error('tool-registry.test.ts must not reach Firestore');
  },
  collections: {},
}));

const {
  ASSISTANT_TOOL_REGISTRY,
  COUNT_CASES_TOOL,
  GET_CASE_TOOL,
  GET_KNOWLEDGE_TOOL,
  READ_OUTCOME_KEY,
  REPEAT_READ_GUIDANCE,
  SEARCH_CASES_TOOL,
  SEARCH_KNOWLEDGE_TOOL,
  TOOL_EFFECTS,
  ToolDescriptorError,
  assertToolDescriptor,
  buildReadToolSet,
  classifiedRefusal,
  isReadToolDescriptor,
  liftReadOutcome,
  selectReadTools,
} = await import('./tool-registry.js');
type AnyToolDescriptor = import('./tool-registry.js').AnyToolDescriptor;
type AnyReadToolDescriptor = import('./tool-registry.js').AnyReadToolDescriptor;
type ToolReadContext = import('./tool-registry.js').ToolReadContext;
type ToolCallRecord = import('./tool-registry.js').ToolCallRecord;

const { AssistantLoopGuard } = await import('./assistant-loop.js');
const { resolveAssistantBounds } = await import('./assistant-bounds.js');
const { decideAssistantPolicy } = await import('./assistant-policy.js');
type Case = import('@arbitra/shared').Case;

function makeContext(): ToolReadContext {
  return { requesterUserId: 'usr_requester', caseId: 'case-x', signal: undefined };
}

function makeGuard(overrides: Partial<ReturnType<typeof resolveAssistantBounds>> = {}) {
  const bounds = { ...resolveAssistantBounds(), ...overrides };
  const controller = new AbortController();
  return { guard: new AssistantLoopGuard(bounds, controller), controller, bounds };
}

/** A synthetic read tool, so the wrapper can be tested without Firestore. */
function syntheticRead(
  read: (input: { secret: string }, ctx: ToolReadContext) => Promise<Record<string, unknown>>,
): AnyReadToolDescriptor {
  return {
    name: 'arbitra_synthetic_read',
    description: 'Synthetic read tool used by tool-registry.test.ts.',
    effect: 'read',
    inputSchema: z.object({ secret: z.string() }),
    riskClass: 'read_scoped',
    connector: 'arbitra',
    requiredScopes: ['case:read'],
    // Declares that only the LENGTH of the input belongs in evidence.
    summariseInput: (input: { secret: string }) => ({ secret_chars: input.secret.length }),
    read,
  };
}

function executeOf(set: Record<string, unknown>, name: string) {
  const entry = set[name] as { execute: (input: unknown) => Promise<unknown> };
  return entry.execute;
}

function makeCase(description: string): Case {
  return {
    case_id: 'case-policy',
    title: 'Task',
    description,
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'usr_requester',
    status: 'open',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    case_type: 'assistant_task',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
}

describe('tool registry — an externally-effecting tool is not expressible', () => {
  it('has exactly two effects, and neither of them is a write', () => {
    expect([...TOOL_EFFECTS]).toEqual(['read', 'propose']);
    expect(TOOL_EFFECTS as readonly string[]).not.toContain('write');
  });

  it('refuses a descriptor that declares a write effect', () => {
    const smuggled = {
      ...syntheticRead(async () => ({})),
      effect: 'write',
    } as unknown as AnyToolDescriptor;

    expect(() => assertToolDescriptor(smuggled)).toThrow(ToolDescriptorError);
    expect(() => assertToolDescriptor(smuggled)).toThrow(/only read \| propose exist/);
  });

  it('refuses a read descriptor that smuggles in a handler able to act', () => {
    for (const key of ['write', 'mutate', 'apply', 'commit', 'execute', 'send', 'delete']) {
      const smuggled = {
        ...syntheticRead(async () => ({})),
        [key]: async () => ({}),
      } as unknown as AnyToolDescriptor;
      expect(() => assertToolDescriptor(smuggled)).toThrow(
        new RegExp(`exposes a '${key}' handler`),
      );
    }
  });

  it('refuses a propose descriptor at the loop boundary even when cast past the types', () => {
    const propose = {
      name: 'arbitra_synthetic_propose',
      description: 'Proposes something.',
      effect: 'propose',
      inputSchema: z.object({}),
      riskClass: 'proposal',
      connector: 'arbitra',
      requiredScopes: ['case:read'],
      summariseInput: () => ({}),
      propose: async () => ({ kind: 'x', summary: 'y', payload: {} }),
    } as unknown as AnyReadToolDescriptor;

    const { guard } = makeGuard();
    expect(() => buildReadToolSet([propose], makeContext(), guard)).toThrow(
      /is not a read tool and must not reach the loop/,
    );
  });

  it('registers only read tools, each declaring scopes and what belongs in evidence', () => {
    expect(ASSISTANT_TOOL_REGISTRY.length).toBeGreaterThan(0);
    for (const descriptor of ASSISTANT_TOOL_REGISTRY) {
      expect(descriptor.effect).toBe('read');
      expect(isReadToolDescriptor(descriptor)).toBe(true);
      expect(descriptor.requiredScopes.length).toBeGreaterThan(0);
      expect(typeof descriptor.summariseInput).toBe('function');
      expect(() => assertToolDescriptor(descriptor)).not.toThrow();
    }
  });
});

describe('tool registry — classification labels but never grants reads', () => {
  it('keeps every allowlisted read visible even for a general-question label', () => {
    const policy = decideAssistantPolicy(makeCase('Rewrite this sentence more politely.'));
    expect(policy.task_kind).toBe('general_question');
    expect(policy.enabled_tools).toEqual(ASSISTANT_TOOL_REGISTRY.map((tool) => tool.name));

    const { guard } = makeGuard();
    const set = buildReadToolSet(selectReadTools(policy.enabled_tools), makeContext(), guard);
    expect(Object.keys(set)).toEqual(policy.enabled_tools);
  });

  it('honours an explicit availability boundary and cannot widen it with keywords', () => {
    const available = [SEARCH_CASES_TOOL.name, 'not_in_the_registry'];
    const policy = decideAssistantPolicy(
      makeCase('Which Arbitra knowledge assets cover our review guidelines?'),
      available,
    );
    const { guard } = makeGuard();
    const set = buildReadToolSet(selectReadTools(policy.enabled_tools), makeContext(), guard);

    // The keyword classifier asks for knowledge, but neither it nor the
    // caller-supplied unknown name may widen the explicit read boundary.
    expect(policy.task_kind).toBe('arbitra_data_question');
    expect(policy.enabled_tools).toEqual([SEARCH_CASES_TOOL.name]);
    expect(Object.keys(set)).toEqual([SEARCH_CASES_TOOL.name]);
  });

  it('fails closed instead of silently dropping an unknown bound policy name', () => {
    // Replacing the validation with a registry filter would let persisted audit
    // state claim a capability the actual model boundary quietly omitted.
    expect(() => selectReadTools(['arbitra_unknown_read'])).toThrow(
      /unknown tool 'arbitra_unknown_read'/,
    );
  });
});

/**
 * The input surface is the whole fix for issue #770: a project- and date-scoped
 * question was previously unanswerable inside the attempt's call budget because
 * these keys did not exist, so the model had to sweep every accessible project
 * and then read each candidate case one at a time.
 */
describe('arbitra_search_cases — the inputs a project- and date-scoped plan needs', () => {
  it('takes project, both creation-date bounds, the sort axis and a cursor in one call', () => {
    const parsed = SEARCH_CASES_TOOL.inputSchema.safeParse({
      project: 'Arbitra Core',
      created_after: '2026-08-04',
      created_before: '2026-08-04',
      status: 'done',
      order_by: 'updated_at',
      cursor: 'b3JkZXI',
      limit: 5,
      query: 'export',
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts a zoned instant but refuses a zone-less one, which would mean server-local time', () => {
    expect(
      SEARCH_CASES_TOOL.inputSchema.safeParse({ created_after: '2026-08-04T09:00:00Z' }).success,
    ).toBe(true);
    expect(
      SEARCH_CASES_TOOL.inputSchema.safeParse({ created_after: '2026-08-04T09:00' }).success,
    ).toBe(false);
  });

  /**
   * An empty string is not "no filter" — it passes every truthiness test the
   * query builder makes, so the clause is never added and the call returns an
   * UNFILTERED set that looks exactly like a filtered one. That is the failure
   * `.strict()` was added for, one level down: the key is spelled right and the
   * value silently removes the filter. It is also an easy value to arrive at, a
   * template slot resolving to nothing.
   */
  it('refuses an empty filter value rather than silently dropping the filter', () => {
    for (const key of ['status', 'query', 'project', 'cursor']) {
      const parsed = SEARCH_CASES_TOOL.inputSchema.safeParse({ [key]: '' });
      expect(parsed.success, `${key} = '' must be refused`).toBe(false);
    }
    for (const key of ['type', 'query']) {
      const parsed = SEARCH_KNOWLEDGE_TOOL.inputSchema.safeParse({ [key]: '' });
      expect(parsed.success, `${key} = '' must be refused`).toBe(false);
    }
  });

  it('offers only sort axes a case document actually carries', () => {
    expect(SEARCH_CASES_TOOL.inputSchema.safeParse({ order_by: 'created_at' }).success).toBe(true);
    expect(SEARCH_CASES_TOOL.inputSchema.safeParse({ order_by: 'completed_at' }).success).toBe(
      false,
    );
  });

  it('states in the model-facing description that updated_at is not a completion time', () => {
    expect(SEARCH_CASES_TOOL.description).toMatch(/no completion timestamp/i);
    expect(SEARCH_CASES_TOOL.description).toMatch(/created_at/);
    expect(SEARCH_CASES_TOOL.description).toMatch(/project_name/);
  });

  /**
   * The description is the only text the model ever sees, so a payload field whose
   * null means "unknown" rather than "no" has to be spelled out there. A model
   * reading a bare `completed_at: null` for a case that genuinely finished ranks
   * it as the older one and says so with confidence.
   */
  it('states in the model-facing description what a null completed_at means', () => {
    expect(GET_CASE_TOOL.description).toMatch(/completion_time/);
    expect(GET_CASE_TOOL.description).toMatch(/not_recorded/);
    expect(GET_CASE_TOOL.description).toMatch(/not_completed/);
    expect(GET_CASE_TOOL.description).toMatch(/does NOT mean/);
    expect(GET_CASE_TOOL.description).toMatch(/UNKNOWN/);
    // The search tool sends the model here for completion times, so it has to
    // carry the same caveat rather than promising one for every done row.
    expect(SEARCH_CASES_TOOL.description).toMatch(/completion_time/);
    expect(SEARCH_CASES_TOOL.description).toMatch(/no recorded\s+completion time/);
  });

  it('summarises the new filters for the trace without copying free text into it', () => {
    const params = SEARCH_CASES_TOOL.summariseInput({
      project: 'Arbitra Core',
      query: 'export bug',
      created_after: '2026-08-04',
      cursor: 'b3JkZXI',
    });

    expect(params.project_chars).toBe('Arbitra Core'.length);
    expect(params.created_after).toBe('2026-08-04');
    expect(params.paged).toBe(true);
    const serialised = JSON.stringify(params);
    expect(serialised).not.toContain('Arbitra Core');
    expect(serialised).not.toContain('export bug');
    expect(serialised).not.toContain('b3JkZXI');
  });
});

describe('arbitra_count_cases — bounded exact aggregation surface', () => {
  it('accepts only the filters an exact index-backed count can apply', () => {
    expect(COUNT_CASES_TOOL.inputSchema.safeParse({
      project: 'Arbitra Core',
      status: 'open',
      case_type: 'assistant_task',
      created_after: '2026-08-04',
      created_before: '2026-08-05T09:00:00Z',
      group_by_status: true,
    }).success).toBe(true);
    expect(COUNT_CASES_TOOL.inputSchema.safeParse({ query: 'invoice' }).success).toBe(false);
    expect(COUNT_CASES_TOOL.inputSchema.safeParse({ status: 'not_a_status' }).success).toBe(false);
    expect(COUNT_CASES_TOOL.inputSchema.safeParse({ created_after: '2026-08-04T09:00' }).success)
      .toBe(false);
  });

  it('tells Clerk when to count and does not imply lifecycle averages are available', () => {
    expect(COUNT_CASES_TOOL.description).toMatch(/which project has more open work/i);
    expect(COUNT_CASES_TOOL.description).toMatch(/exact server-side count/i);
    expect(COUNT_CASES_TOOL.description).toMatch(/does not calculate average lifecycle duration/i);
  });

  it('keeps typed filters in evidence but records only project-name length', () => {
    expect(COUNT_CASES_TOOL.summariseInput({
      project: 'Sensitive project name',
      status: 'open',
      case_type: 'bugfix',
      created_after: '2026-08-04',
      group_by_status: true,
    })).toEqual({
      status: 'open',
      case_type: 'bugfix',
      project_chars: 22,
      created_after: '2026-08-04',
      created_before: '',
      group_by_status: true,
      owner: '',
    });
  });
});

/**
 * #950: the `owner` filter takes the literal `'current'` for "the requester
 * themselves", so one call answers "how many of mine". Pinned at the schema
 * level; the read behaviour itself (narrows within visibility, never widens
 * it) is `tool-reads.test.ts`'s job, since this file mocks Firestore away
 * entirely.
 */
describe('arbitra_search_cases and arbitra_count_cases — owner filter (#950)', () => {
  it("accepts owner: 'current' on both tools and refuses any other value", () => {
    expect(SEARCH_CASES_TOOL.inputSchema.safeParse({ owner: 'current' }).success).toBe(true);
    expect(COUNT_CASES_TOOL.inputSchema.safeParse({ owner: 'current' }).success).toBe(true);
    expect(SEARCH_CASES_TOOL.inputSchema.safeParse({ owner: 'usr_someone' }).success).toBe(false);
    expect(COUNT_CASES_TOOL.inputSchema.safeParse({ owner: 'usr_someone' }).success).toBe(false);
    expect(SEARCH_CASES_TOOL.inputSchema.safeParse({ owner: '' }).success).toBe(false);
  });

  it('tells the model ownership is answerable and that the filter cannot widen visibility', () => {
    expect(SEARCH_CASES_TOOL.description).toMatch(/owner_name/);
    expect(SEARCH_CASES_TOOL.description).toMatch(/'current'/);
    expect(SEARCH_CASES_TOOL.description).toMatch(/which\/how many of mine/i);
    expect(SEARCH_CASES_TOOL.description).toMatch(/can never surface a case/i);
    expect(COUNT_CASES_TOOL.description).toMatch(/how many of mine/i);
    expect(COUNT_CASES_TOOL.description).toMatch(/can never make a case in an invisible project/i);
    expect(GET_CASE_TOOL.description).toMatch(/owner_name/);
    expect(GET_CASE_TOOL.description).toMatch(/assigned_reviewer_name/);
  });

  it('records the owner filter verbatim in evidence — structural, not free text', () => {
    expect(SEARCH_CASES_TOOL.summariseInput({ owner: 'current' }).owner).toBe('current');
    expect(COUNT_CASES_TOOL.summariseInput({ owner: 'current' }).owner).toBe('current');
  });
});

/**
 * `arbitra_get_knowledge` — the read `arbitra_search_knowledge` was missing:
 * search finds an asset's id and title but never its body, and nothing else
 * could read the content, so a model that found the right asset still had no
 * way to act on it. These pin the registry-level half of the fix; the actual
 * visibility and body round-trip are `tool-reads.test.ts`'s job.
 */
describe('arbitra_get_knowledge — registered as an always-on read tool', () => {
  it('is present in the registry as a read tool with the same connector and scope as search', () => {
    expect(ASSISTANT_TOOL_REGISTRY).toContain(GET_KNOWLEDGE_TOOL);
    expect(GET_KNOWLEDGE_TOOL.effect).toBe('read');
    expect(GET_KNOWLEDGE_TOOL.connector).toBe('arbitra');
    expect(GET_KNOWLEDGE_TOOL.riskClass).toBe('read_scoped');
    expect(GET_KNOWLEDGE_TOOL.requiredScopes).toEqual(['knowledge:read']);
  });

  it("rejects a call carrying anything beyond knowledge_id, so a guessed key can't silently widen it", () => {
    expect(GET_KNOWLEDGE_TOOL.inputSchema.safeParse({ knowledge_id: 'ka_1' }).success).toBe(true);
    const parsed = GET_KNOWLEDGE_TOOL.inputSchema.safeParse({
      knowledge_id: 'ka_1',
      scope_ref: 'proj_1',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.code)).toContain('unrecognized_keys');
  });

  it('points arbitra_search_knowledge\'s description at arbitra_get_knowledge for full content', () => {
    // Cheap regression anchor: search's model-facing text has to name this tool
    // so Clerk knows a follow-up read exists once it has found the right asset.
    expect(SEARCH_KNOWLEDGE_TOOL.description).toMatch(/arbitra_get_knowledge/);
    expect(SEARCH_KNOWLEDGE_TOOL.description).toMatch(/never the body/i);
  });

  it('records the knowledge_id in evidence, matching how arbitra_get_case records case_id', () => {
    // The id names WHICH asset was read, which is the point of the evidence
    // row. A length told a reader nothing and left the trace unauditable.
    const params = GET_KNOWLEDGE_TOOL.summariseInput({ knowledge_id: 'ka_abcdefgh' });
    expect(params).toEqual({ knowledge_id: 'ka_abcdefgh' });
  });
});

describe('tool registry — bounds and trace around every call', () => {
  it('hands the tool a context with identity and signal only, frozen', async () => {
    let seen: ToolReadContext | undefined;
    const descriptor = syntheticRead(async (_input, ctx) => {
      seen = ctx;
      return { ok: true };
    });
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);

    await executeOf(set, descriptor.name)({ secret: 'abc' });

    expect(Object.keys(seen!).sort()).toEqual(['caseId', 'requesterUserId', 'signal']);
    expect(Object.isFrozen(seen)).toBe(true);
    // No write surface, no database handle, no adapter.
    for (const value of Object.values(seen as Record<string, unknown>)) {
      expect(typeof value).not.toBe('function');
    }
  });

  it('records only what the descriptor declared, never the raw input', async () => {
    const descriptor = syntheticRead(async () => ({ rows: [1, 2, 3] }));
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);

    await executeOf(set, descriptor.name)({ secret: 'super-secret-value' });

    const record = guard.trace[0] as ToolCallRecord;
    expect(record.name).toBe(descriptor.name);
    expect(record.outcome).toBe('ok');
    expect(record.params).toEqual({ secret_chars: 'super-secret-value'.length });
    expect(JSON.stringify(record)).not.toContain('super-secret-value');
    expect(record.result_bytes).toBeGreaterThan(0);
  });

  it('stops the attempt when a single call outlasts the per-call bound', async () => {
    const descriptor = syntheticRead(
      () => new Promise((resolve) => setTimeout(() => resolve({ late: true }), 200)),
    );
    const { guard, controller } = makeGuard({ toolCallLimitMs: 5 });
    const set = buildReadToolSet([descriptor], makeContext(), guard);

    const result = await executeOf(set, descriptor.name)({ secret: 'x' });

    expect(result).toMatchObject({
      outcome: 'failed',
      message: 'Refused: the tool_call_limit bound is exhausted.',
    });
    expect(guard.bound).toBe('tool_call_limit');
    expect(controller.signal.aborted).toBe(true);
    expect(guard.trace[0]!.outcome).toBe('bound_exceeded');
  });

  it('refuses the call that would exceed the total tool-call bound, without running it', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    const descriptor = syntheticRead(read);
    const { guard, controller } = makeGuard({ maxToolCalls: 1 });
    const set = buildReadToolSet([descriptor], makeContext(), guard);
    const execute = executeOf(set, descriptor.name);

    await execute({ secret: 'x' });
    const second = await execute({ secret: 'x' });

    expect(read).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      outcome: 'failed',
      message: 'Refused: the max_tool_calls bound is exhausted.',
    });
    expect(guard.trace[1]!.outcome).toBe('bound_exceeded');
    // The refusal does NOT end the attempt: it goes back to the model as a tool
    // result, and `assistant-loop.ts` withholds the reads from the next step so the
    // model answers from what it already read. Aborting here would discard every
    // completed read of the step — see `AssistantLoopGuard.reportBound`.
    expect(guard.bound).toBeNull();
    expect(controller.signal.aborted).toBe(false);
    expect(guard.readsExhausted).toBe(true);
  });

  it('clips an oversized result and tells the model it was clipped', async () => {
    const descriptor = syntheticRead(async () => ({ blob: 'y'.repeat(500) }));
    const { guard } = makeGuard({ maxToolResultChars: 50 });
    const set = buildReadToolSet([descriptor], makeContext(), guard);

    const result = (await executeOf(set, descriptor.name)({ secret: 'x' })) as {
      untrusted_tool_result: { truncated?: boolean; partial?: string };
    };

    expect(result.untrusted_tool_result.truncated).toBe(true);
    expect(result.untrusted_tool_result.partial!.length).toBe(50);
    // The trace still records the true size, not the clipped one.
    expect(guard.trace[0]!.result_bytes).toBeGreaterThan(500);
  });

  it('returns an error object instead of throwing when a tool fails', async () => {
    const descriptor = syntheticRead(async () => {
      throw new Error('firestore exploded');
    });
    const { guard, controller } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);

    const result = await executeOf(set, descriptor.name)({ secret: 'x' });

    expect(result).toMatchObject({
      outcome: 'failed',
      message: 'The tool could not complete this call.',
    });
    // A tool error is not a bound: the attempt continues and can still answer.
    expect(guard.bound).toBeNull();
    expect(controller.signal.aborted).toBe(false);
    expect(guard.trace[0]!.outcome).toBe('error');
  });

  it('rejects input that does not match the declared schema, naming the field', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    const descriptor = syntheticRead(read);
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);

    const result = (await executeOf(set, descriptor.name)({ secret: 42 })) as {
      outcome: string;
      message: string;
    };

    expect(result.outcome).toBe('invalid_call');
    expect(result.message).toContain('secret');
    expect(result.message).toContain('did not run');
    expect(read).not.toHaveBeenCalled();
    expect(guard.trace[0]!.detail).toBe('invalid_input');
    expect(guard.trace[0]!.result_outcome).toBe('invalid_call');
  });

  /**
   * An unknown key used to be stripped and the drop recorded nowhere. A model
   * guessing `project_id` — a field the search RETURNS — therefore received an
   * unfiltered result set that was indistinguishable from a filtered one, and
   * reported a wrong answer rather than hitting an error.
   */
  it('refuses an unknown input key, names it, and records the refusal', async () => {
    const { guard } = makeGuard();
    const set = buildReadToolSet([SEARCH_CASES_TOOL], makeContext(), guard);

    const result = (await executeOf(set, SEARCH_CASES_TOOL.name)({
      project_id: 'proj_1',
    })) as { outcome: string; message: string };

    // `invalid_call`, not `failed`: the tool works and a corrected call answers,
    // so "say it cannot be done" would be the wrong next move.
    expect(result.outcome).toBe('invalid_call');
    expect(result.message).toContain('project_id');
    expect(result.message).toContain('unknown input key');
    // The allowed keys come back with it, so the retry is informed.
    expect(result.message).toContain('created_after');
    expect(guard.trace[0]!.outcome).toBe('error');
    expect(guard.trace[0]!.detail).toBe('unknown_input_keys');
    // The count is evidence; the model-authored key names are not.
    expect(guard.trace[0]!.params).toEqual({ unknown_input_keys: 1 });
    expect(JSON.stringify(guard.trace[0])).not.toContain('proj_1');
  });

  it('every registered tool declares a schema that refuses unknown keys', () => {
    for (const descriptor of ASSISTANT_TOOL_REGISTRY) {
      const parsed = descriptor.inputSchema.safeParse({ not_a_real_key: 'x' });
      expect(parsed.success).toBe(false);
      if (parsed.success) continue;
      expect(parsed.error.issues.map((issue) => issue.code)).toContain('unrecognized_keys');
    }
  });

  it('delimits every tool result as untrusted data', async () => {
    const descriptor = syntheticRead(async () => ({ rows: ['a'] }));
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);

    const result = await executeOf(set, descriptor.name)({ secret: 'x' });

    expect(result).toEqual({ outcome: 'ok', untrusted_tool_result: { rows: ['a'] } });
  });
});

/**
 * A call that returns no rows used to be `{ error: <message> }` whatever it
 * meant, and a model cannot branch on prose: a project filter matching no project
 * came back with the answer to the question, and the model read it as a broken
 * filter, dropped it and swept unfiltered. What is pinned here is that the class
 * is a FIELD on every result, and that the three cases which call for opposite
 * next moves carry three different values.
 */
describe('tool registry — every result says what class of outcome it is', () => {
  it('classifies a read that answered as ok, and passes its payload through unchanged', async () => {
    const payload = { rows: ['a'], has_more: false };
    const descriptor = syntheticRead(async () => payload);
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);

    const result = (await executeOf(set, descriptor.name)({ secret: 'x' })) as {
      outcome: string;
      guidance?: string;
      untrusted_tool_result: unknown;
    };

    expect(result.outcome).toBe('ok');
    // Byte-for-byte the object the read produced: a success result is not what
    // this change touches.
    expect(result.untrusted_tool_result).toBe(payload);
    expect(result.guidance).toBeUndefined();
    expect(guard.trace[0]!.result_outcome).toBe('ok');
  });

  it('carries the answer class of a read that refused, with the refusal payload', async () => {
    const descriptor = syntheticRead(async () =>
      classifiedRefusal('answer', {
        answered: false,
        project_filter: { resolved: null, reason: 'no_matching_project' },
      }),
    );
    const { guard, controller } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);

    const result = (await executeOf(set, descriptor.name)({ secret: 'x' })) as {
      outcome: string;
      guidance: string;
      untrusted_tool_result: Record<string, unknown>;
    };

    expect(result.outcome).toBe('answer');
    expect(result.guidance).toContain('This is a RESULT, not a failure');
    expect(result.guidance).toContain('answers a different question');
    // The class settles THIS CALL, not the request. Asked "how many open cases in
    // Globex and in Acme", a model told to "report it and stop" reported the typo'd
    // Globex and never searched Acme — the half of the request that had data. Both
    // halves are pinned because they pull in opposite directions and a later reword
    // will drift toward one of them.
    expect(result.guidance).toContain('they still need their own reads');
    expect(result.guidance).toMatch(/do not repeat this call/i);
    expect(result.guidance).not.toMatch(/\bstop\b/i);
    // The declaration is lifted out, so the class appears once, at the top.
    expect(result.untrusted_tool_result[READ_OUTCOME_KEY]).toBeUndefined();
    expect(result.untrusted_tool_result['answered']).toBe(false);
    // A refusal is a read that RAN: the call worked, and the attempt continues.
    expect(guard.trace[0]!.outcome).toBe('ok');
    expect(guard.trace[0]!.result_outcome).toBe('answer');
    expect(guard.bound).toBeNull();
    expect(controller.signal.aborted).toBe(false);
  });

  it('classifies an index that is still building as transient, not as a bad filter', async () => {
    // The condition behind the second observed failure: one call failed against a
    // building composite index, and the model read it as "this filter does not
    // work", abandoned every filter and enumerated.
    const descriptor = syntheticRead(async () => {
      throw Object.assign(
        new Error(
          '9 FAILED_PRECONDITION: The query requires an index. That index is currently building '
          + 'and cannot be used yet.',
        ),
        { code: 9 },
      );
    });
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);

    const result = (await executeOf(set, descriptor.name)({ secret: 'x' })) as {
      outcome: string;
      guidance: string;
      message: string;
    };

    expect(result.outcome).toBe('transient');
    expect(result.guidance).toContain('do not drop them');
    expect(result.message).toContain('says nothing about the filters you used');
    expect(guard.trace[0]!.result_outcome).toBe('transient');
  });

  /**
   * Two independent routes to `transient`, exercised separately on purpose: the
   * messages below deliberately do NOT carry the words the other route matches,
   * so neither can pass on the strength of the other. A first version used
   * Firestore's full text ("14 UNAVAILABLE: …"), which matched both, and the
   * status-code branch was therefore never actually covered.
   */
  it.each([
    ['unavailable', 14, 'The service is temporarily down. Please try again.'],
    ['quota exhausted', 8, 'Quota for this project has been used up.'],
    ['a slow backend', 4, 'The operation did not finish in time.'],
  ])('classifies %s as transient from the status code alone', async (_label, code, message) => {
    const descriptor = syntheticRead(async () => {
      throw Object.assign(new Error(message), { code });
    });
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);

    const result = (await executeOf(set, descriptor.name)({ secret: 'x' })) as { outcome: string };

    expect(result.outcome).toBe('transient');
  });

  it.each([
    ['UNAVAILABLE'],
    ['RESOURCE_EXHAUSTED'],
    ['DEADLINE_EXCEEDED'],
  ])('classifies a %s message as transient when it carries no status code', async (token) => {
    const descriptor = syntheticRead(async () => {
      throw new Error(`${token}: the read did not get through.`);
    });
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);

    const result = (await executeOf(set, descriptor.name)({ secret: 'x' })) as { outcome: string };

    expect(result.outcome).toBe('transient');
  });

  it('does not treat a missing index as transient just because it has a status code', async () => {
    // FAILED_PRECONDITION is a gRPC code like the others and is deliberately not
    // in the transient set: a missing index does not appear on its own, so
    // retrying it spends a read for nothing.
    const descriptor = syntheticRead(async () => {
      throw Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index.'), {
        code: 9,
      });
    });
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);

    const result = (await executeOf(set, descriptor.name)({ secret: 'x' })) as { outcome: string };

    expect(result.outcome).toBe('failed');
  });

  it('classifies a missing index as failed, and says the filters were not the problem', async () => {
    // The other half of the index case, and why the classification is not simply
    // "index error means retry": an index that does not exist will not appear on
    // its own, so retrying spends a read for nothing — while dropping the filter
    // answers a different question and must not look like the remedy either.
    const descriptor = syntheticRead(async () => {
      throw Object.assign(
        new Error(
          '9 FAILED_PRECONDITION: The query requires an index. You can create it here: '
          + 'https://console.firebase.google.com/project/demo-arbitra/firestore/indexes?create=abc',
        ),
        { code: 9 },
      );
    });
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);

    const result = (await executeOf(set, descriptor.name)({ secret: 'x' })) as {
      outcome: string;
      message: string;
    };

    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('The filters themselves are valid');
    expect(result.message).toContain('would answer a different question');
    // Fixed text, never the caught message: a Firestore index error carries the
    // query shape and a project console URL, neither of which belongs in the
    // model's context or, through the answer, in a case artifact.
    expect(result.message).not.toContain('console.firebase.google.com');
    expect(result.message).not.toContain('demo-arbitra');
  });

  it('lifts nothing from a payload that declares no class', () => {
    const payload = { rows: [], outcome: 'not a declaration' };
    expect(liftReadOutcome(payload)).toEqual({ outcome: 'ok', payload });
  });

  it('refuses to read a class out of a value that is not one', () => {
    // A payload key is data. An unrecognised value must not become an outcome, or
    // a read could talk the envelope into any class it liked.
    const payload = { [READ_OUTCOME_KEY]: 'answer_please' };
    expect(liftReadOutcome(payload).outcome).toBe('ok');
  });
});

/**
 * Observed defect: four consecutive pages of one free-text search, each ~525
 * bytes of no rows, burned four of five reads on information the first page had
 * already delivered. The remedy is visibility, not a block — a warning FIELD on
 * the result, in the channel the model actually branches on, from the third
 * identical read of an attempt. Pagination through real rows stays unmarked:
 * a follow-up page is an ordinary second occurrence, and pages with content
 * differ in size.
 */
describe('buildReadToolSet — a read that keeps returning the same thing says so', () => {
  type RepeatEnvelope = {
    outcome: string;
    untrusted_tool_result: unknown;
    repeat_read?: boolean;
    repeat_read_guidance?: string;
  };

  it('marks the third identical read, and not the first two', async () => {
    const descriptor = syntheticRead(async () => ({ cases: [], has_more: true }));
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);
    const execute = executeOf(set, descriptor.name);

    const first = (await execute({ secret: 'q' })) as RepeatEnvelope;
    const second = (await execute({ secret: 'q' })) as RepeatEnvelope;
    const third = (await execute({ secret: 'q' })) as RepeatEnvelope;
    const fourth = (await execute({ secret: 'q' })) as RepeatEnvelope;

    expect(first.repeat_read).toBeUndefined();
    expect(first.repeat_read_guidance).toBeUndefined();
    expect(second.repeat_read).toBeUndefined();
    // Field plus sentence, additive: the payload underneath is untouched.
    expect(third.repeat_read).toBe(true);
    expect(third.repeat_read_guidance).toBe(REPEAT_READ_GUIDANCE);
    expect(third.outcome).toBe('ok');
    expect(third.untrusted_tool_result).toEqual({ cases: [], has_more: true });
    expect(fourth.repeat_read).toBe(true);
  });

  it('keeps reads with different parameters or clearly different results apart', async () => {
    let large = false;
    const descriptor = syntheticRead(async () => (large ? { rows: 'y'.repeat(600) } : { rows: [] }));
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);
    const execute = executeOf(set, descriptor.name);

    // Different parameter summaries (the secret LENGTH is what the trace
    // records) never share a signature, however often each shape runs.
    await execute({ secret: 'a' });
    await execute({ secret: 'bb' });
    const differentParams = (await execute({ secret: 'ccc' })) as RepeatEnvelope;
    expect(differentParams.repeat_read).toBeUndefined();

    // Same parameters, but the third result lands in a different size bucket —
    // a page that came back with real content is not the repetition.
    await execute({ secret: 'a' });
    large = true;
    const differentSize = (await execute({ secret: 'a' })) as RepeatEnvelope;
    expect(differentSize.repeat_read).toBeUndefined();
  });

  it('marks a repeated refusal too, which is also a read that will not change', async () => {
    const descriptor = syntheticRead(async () =>
      classifiedRefusal('invalid_call', { answered: false, message: 'same rejection' }),
    );
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);
    const execute = executeOf(set, descriptor.name);

    await execute({ secret: 'q' });
    await execute({ secret: 'q' });
    const third = (await execute({ secret: 'q' })) as RepeatEnvelope & { guidance: string };

    // The class guidance stays; the repeat marker rides beside it.
    expect(third.outcome).toBe('invalid_call');
    expect(third.guidance).toBeDefined();
    expect(third.repeat_read).toBe(true);
  });
});

/**
 * P0 regression: the repeat-read signature is built from `summariseInput`'s
 * output, and `SEARCH_CASES_TOOL.summariseInput` collapses `cursor` to a
 * boolean (`paged`) so the trace never carries the opaque continuation token
 * verbatim. That is correct for the audit record and wrong for this check —
 * every page of a real pagination run from the second on then differs from
 * every other page ONLY by its byte count, and several full ~3.7KB pages of
 * real rows land in the same 100-byte bucket on their own (rows are not
 * uniform size). Six such pages tripped `repeat_read: true` from the third
 * same-bucket page on — a false positive on exactly the legitimate use the
 * mechanism must not flag.
 *
 * This suite drives the REAL `SEARCH_CASES_TOOL` descriptor — its actual
 * `inputSchema` and `summariseInput`, only `read` swapped for a double — not a
 * synthetic descriptor: the existing repeat-read tests above use
 * `syntheticRead`, whose result sizes jump by hundreds of bytes between calls
 * and so never land in the same bucket. That wide gap is how the defect
 * shipped unnoticed.
 */
describe('buildReadToolSet — repeat-read distinguishes pagination pages (SEARCH_CASES_TOOL)', () => {
  type RepeatEnvelope = {
    outcome: string;
    untrusted_tool_result: unknown;
    repeat_read?: boolean;
  };

  /** A payload padded to an exact byte count once serialised, so the bucket the reviewer named is exact. */
  function casesPayloadOfSize(targetBytes: number): Record<string, unknown> {
    const shape = {
      cases: [
        { case_id: 'case-1', title: 'Acme Atlas review', status: 'open', project_name: 'Atlas' },
      ],
      has_more: true,
      next_cursor: 'unused',
      padding: '',
    };
    const baseLen = JSON.stringify(shape).length;
    const padLen = Math.max(0, targetBytes - baseLen);
    return { ...shape, padding: 'x'.repeat(padLen) };
  }

  /** `SEARCH_CASES_TOOL` with the real schema and `summariseInput`, only `read` replaced. */
  function pagedSearchCasesTool(resultBytes: readonly number[]): AnyReadToolDescriptor {
    let call = 0;
    return {
      ...SEARCH_CASES_TOOL,
      read: async () => casesPayloadOfSize(resultBytes[call++]!),
    };
  }

  it('does not flag six same-bucket pages of one search, because each carries a distinct cursor', async () => {
    // The reviewer's production trace: six ~3.7KB pages, sizes close enough
    // that most of them floor to the same 100-byte bucket.
    const sizes = [3710, 3740, 3695, 3780, 3712, 3733];
    const descriptor = pagedSearchCasesTool(sizes);
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);
    const execute = executeOf(set, descriptor.name);

    // Page 1 has no cursor; pages 2-6 continue with the cursor the previous
    // page would have returned. Every other filter stays identical, exactly as
    // the tool's own description requires of a paging client.
    const cursors: (string | undefined)[] = [undefined, 'page-2', 'page-3', 'page-4', 'page-5', 'page-6'];

    const results: RepeatEnvelope[] = [];
    for (const cursor of cursors) {
      const input: Record<string, unknown> = { query: 'acme atlas' };
      if (cursor !== undefined) input.cursor = cursor;
      results.push((await execute(input)) as RepeatEnvelope);
    }

    results.forEach((result, i) => {
      expect(result.repeat_read, `page ${i + 1} of 6`).toBeUndefined();
    });
  });

  it('still flags the third call when the SAME page (identical cursor) is fetched repeatedly', async () => {
    // Same-bucket sizes on purpose: a page that keeps coming back at
    // essentially the same size IS the repetition the mechanism must still
    // catch when the cursor does not change between calls.
    const descriptor = pagedSearchCasesTool([3710, 3712, 3733]);
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);
    const execute = executeOf(set, descriptor.name);
    const input = { query: 'acme atlas', cursor: 'page-2' };

    const first = (await execute(input)) as RepeatEnvelope;
    const second = (await execute(input)) as RepeatEnvelope;
    const third = (await execute(input)) as RepeatEnvelope;

    expect(first.repeat_read).toBeUndefined();
    expect(second.repeat_read).toBeUndefined();
    expect(third.repeat_read).toBe(true);
  });

  it('still flags a repeated FIRST page (no cursor at all) fetched three times running', async () => {
    const descriptor = pagedSearchCasesTool([3710, 3712, 3733]);
    const { guard } = makeGuard();
    const set = buildReadToolSet([descriptor], makeContext(), guard);
    const execute = executeOf(set, descriptor.name);
    const input = { query: 'acme atlas' };

    const first = (await execute(input)) as RepeatEnvelope;
    const second = (await execute(input)) as RepeatEnvelope;
    const third = (await execute(input)) as RepeatEnvelope;

    expect(first.repeat_read).toBeUndefined();
    expect(second.repeat_read).toBeUndefined();
    expect(third.repeat_read).toBe(true);
  });
});
