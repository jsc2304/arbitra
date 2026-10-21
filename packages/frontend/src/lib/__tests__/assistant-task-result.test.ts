/**
 * @file Reading a stored Clerk result — decoding, selection, and the wording
 * rule for a spent read budget.
 *
 * These cover the three things that were invisible from the case page before it
 * rendered an answer at all: that the bytes are UTF-8 (an answer contains `…`
 * and umlauts routinely), that the newest attempt's result is the one shown, and
 * that the read-budget sentence says what happened to the RUN and never judges
 * the answer.
 */
import { describe, expect, it } from 'vitest';
import type { AssistantToolPolicyTrace, CaseEvent, Evidence, Run } from '@arbitra/shared';
import {
  ASSISTANT_TASK_RESULT_SCHEMA,
  ASSISTANT_TASK_RESULT_SCHEMA_V1,
  assertAssistantResultPolicyParity,
  assistantFailureFromEvents,
  decodeBase64DataUrl,
  describeToolParams,
  parseAssistantTaskResult,
  readsWithheldFact,
  taskResultArtifactRef,
} from '../assistant-task-result';

function jsonDataUrl(document: unknown): string {
  const bytes = Buffer.from(JSON.stringify(document), 'utf-8').toString('base64');
  return `data:application/json;base64,${bytes}`;
}

function evidenceRow(over: Partial<Evidence>): Evidence {
  return {
    evidence_id: 'ev_1',
    case_id: 'case_1',
    type: 'task_result',
    source_type: 'automated',
    machine_readable: true,
    validation_track: 'direct',
    created_at: '2026-08-01T10:00:00.000Z',
    created_by: 'system:assistant',
    ...over,
  } as Evidence;
}

function event(over: Partial<CaseEvent>): CaseEvent {
  return {
    event_id: 'event_1',
    case_id: 'case_1',
    type: 'assistant_task_failed',
    actor_id: 'system:assistant',
    payload: {},
    created_at: '2026-08-01T10:00:00.000Z',
    ...over,
  } as CaseEvent;
}

const assistantToolPolicy: AssistantToolPolicyTrace = {
  schema_version: 1,
  task_kind: 'arbitra_data_question',
  enabled_tools: ['arbitra_search_cases', 'arbitra_get_case', 'arbitra_search_knowledge'],
  tool_selection_reason: 'requester_scoped_read_registry',
};

const minimalResult = {
  schema: ASSISTANT_TASK_RESULT_SCHEMA,
  answer: 'ok',
  model: 'gemini-2.5-flash',
  steps: 4,
  finish_reason: 'stop',
  duration_ms: 13_300,
  reads_withheld: false,
  reads_withheld_reason: null,
  tool_calls: [],
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  assistant_tool_policy: assistantToolPolicy,
};

describe('decodeBase64DataUrl', () => {
  it('decodes multi-byte characters as UTF-8', () => {
    const answer = 'Fälle in „Payments API“ — 18 Stück …';
    const decoded = decodeBase64DataUrl(jsonDataUrl({ ...minimalResult, answer }));
    expect(JSON.parse(decoded).answer).toBe(answer);
  });

  it('refuses content that is not a data URL', () => {
    expect(() => decodeBase64DataUrl('{"answer":"x"}')).toThrow(/data URL/);
  });
});

describe('parseAssistantTaskResult', () => {
  it('reads a v2 answer with the bound Run policy', () => {
    const result = parseAssistantTaskResult(
      jsonDataUrl({
        ...minimalResult,
        answer: '# Cases\n\n* one\n* two',
        as_of: '2026-08-04T07:39:35.000Z',
        reads_withheld: true,
        reads_withheld_reason: 'step_budget',
        tool_calls: [
          {
            name: 'arbitra_search_cases',
            params: { query_chars: 12, status: 'done', limit: 50, paged: false },
            result_bytes: 2048,
            duration_ms: 410,
            outcome: 'ok',
          },
        ],
      }),
    );

    expect(result.answer).toBe('# Cases\n\n* one\n* two');
    expect(result.as_of).toBe('2026-08-04T07:39:35.000Z');
    expect(result.steps).toBe(4);
    expect(result.finish_reason).toBe('stop');
    expect(result.reads_withheld).toBe(true);
    expect(result.reads_withheld_reason).toBe('step_budget');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.usage.total_tokens).toBe(30);
    expect(result.assistant_tool_policy_availability).toBe('bound');
    expect(result.assistant_tool_policy).toEqual(minimalResult.assistant_tool_policy);
  });

  it('reads an immutable v1 result without inventing a policy', () => {
    const result = parseAssistantTaskResult(jsonDataUrl({
      ...minimalResult,
      schema: ASSISTANT_TASK_RESULT_SCHEMA_V1,
      assistant_tool_policy: undefined,
    }));

    // Replacing this with a synthesized current policy would misrepresent the
    // historical attempt and turn classifier changes into fake audit facts.
    expect(result.schema).toBe(ASSISTANT_TASK_RESULT_SCHEMA_V1);
    expect(result.assistant_tool_policy).toBeNull();
    expect(result.assistant_tool_policy_availability).toBe('legacy_schema_v1/unavailable');
  });

  it('rejects a v2 result whose required policy snapshot is missing', () => {
    expect(() => parseAssistantTaskResult(jsonDataUrl({
      ...minimalResult,
      assistant_tool_policy: undefined,
    }))).toThrow();
  });

  it('keeps legacy v1 results without an as_of anchor readable', () => {
    const result = parseAssistantTaskResult(jsonDataUrl(minimalResult));

    expect(result.answer).toBe('ok');
    expect(result.as_of).toBeUndefined();
  });

  it('refuses an artifact that is not an assistant result', () => {
    expect(() =>
      parseAssistantTaskResult(jsonDataUrl({ schema: 'arbitra.review_result/v1', answer: 'x' })),
    ).toThrow(/Unexpected artifact schema/);
  });

  /**
   * The always-inject Clerk context trace field (#832 slice A): present on
   * a fresh artifact, defaulted on one written before the field existed.
   */
  describe('injected_context', () => {
    it('reads the entries the executor recorded', () => {
      // Reverted line: dropping the `injected_context: Array.isArray(...)
      // ? ... : []` line from `parseAssistantTaskResult` makes this fail —
      // `result.injected_context` would come back `undefined` instead of
      // the two recorded entries.
      const result = parseAssistantTaskResult(
        jsonDataUrl({
          ...minimalResult,
          injected_context: [
            { knowledge_id: 'ka_roster', title: 'Team roster' },
            { knowledge_id: 'ka_prefs', title: 'My preferences' },
          ],
        }),
      );
      expect(result.injected_context).toEqual([
        { knowledge_id: 'ka_roster', title: 'Team roster' },
        { knowledge_id: 'ka_prefs', title: 'My preferences' },
      ]);
    });

    it('defaults to an empty array on an artifact written before this field existed', () => {
      const result = parseAssistantTaskResult(jsonDataUrl(minimalResult));
      expect(result.injected_context).toEqual([]);
    });
  });
});

describe('assertAssistantResultPolicyParity', () => {
  function linkedRun(policy = minimalResult.assistant_tool_policy): Run {
    return {
      run_id: 'run_1',
      case_id: 'case_1',
      run_type: 'assistant_task_run',
      trigger_source: 'assistant-intake:web',
      status: 'completed',
      input_refs: [],
      output_refs: ['art_1'],
      assistant_policy_state: 'bound',
      assistant_tool_policy: policy,
      created_at: '2026-08-04T00:00:00.000Z',
      updated_at: '2026-08-04T00:01:00.000Z',
    };
  }

  it('accepts canonically identical v2 Run and result snapshots', () => {
    const result = parseAssistantTaskResult(jsonDataUrl(minimalResult));
    expect(() => assertAssistantResultPolicyParity(result, linkedRun())).not.toThrow();
  });

  it('rejects a v2 snapshot that differs from the bound Run', () => {
    const result = parseAssistantTaskResult(jsonDataUrl(minimalResult));
    // Removing parity would let a rewritten Artifact claim a different tool
    // boundary than the one that actually preceded the model call.
    expect(() => assertAssistantResultPolicyParity(result, linkedRun({
      ...minimalResult.assistant_tool_policy,
      task_kind: 'general_question',
    }))).toThrow(/does not match/);
  });

  it('keeps a legacy v1 result readable without a linked policy Run', () => {
    const result = parseAssistantTaskResult(jsonDataUrl({
      ...minimalResult,
      schema: ASSISTANT_TASK_RESULT_SCHEMA_V1,
      assistant_tool_policy: undefined,
    }));
    expect(() => assertAssistantResultPolicyParity(result, null)).not.toThrow();
  });
});

describe('taskResultArtifactRef', () => {
  it('takes the newest task_result and ignores other evidence', () => {
    const ref = taskResultArtifactRef([
      evidenceRow({ evidence_id: 'ev_old', artifact_ref: 'art_old', created_at: '2026-08-01T09:00:00.000Z' }),
      evidenceRow({ evidence_id: 'ev_lint', type: 'lint_result', artifact_ref: 'art_lint', created_at: '2026-08-01T23:00:00.000Z' }),
      evidenceRow({ evidence_id: 'ev_new', artifact_ref: 'art_new', created_at: '2026-08-01T12:00:00.000Z' }),
    ]);
    expect(ref).toBe('art_new');
  });

  it('is null while no result exists', () => {
    expect(taskResultArtifactRef([])).toBeNull();
    expect(taskResultArtifactRef([evidenceRow({ artifact_ref: undefined })])).toBeNull();
  });
});

describe('readsWithheldFact', () => {
  it('states what happened to the run and never judges the answer', () => {
    for (const reason of ['step_budget', 'tool_call_budget', null]) {
      const fact = readsWithheldFact(reason);
      // Two facts about the run: the budget went, and the answer was written
      // after it went. Neither is a statement about what the answer contains.
      expect(fact).toMatch(/^The run used its whole /);
      expect(fact).toMatch(/the answer was written with no reads left\.$/);
      expect(fact).not.toMatch(/incomplete|partial|truncated/i);
      // A gap claim in softer words is still a gap claim, and this flag cannot
      // support one: a request that needed exactly the whole budget finishes.
      expect(fact).not.toMatch(/\bonly\b|before it finished|rests on|did not finish/i);
    }
  });

  it('names the budget that ran out', () => {
    expect(readsWithheldFact('step_budget')).toMatch(/step budget/);
    expect(readsWithheldFact('tool_call_budget')).toMatch(/tool-call budget/);
    expect(readsWithheldFact(null)).toMatch(/read budget/);
  });
});

describe('assistantFailureFromEvents', () => {
  it('reports the newest attempt reason and whether the run was abandoned', () => {
    const failure = assistantFailureFromEvents([
      event({ event_id: 'e1', payload: { reason: 'bound:max_steps' }, created_at: '2026-08-01T10:00:00.000Z' }),
      event({ event_id: 'e2', payload: { reason: 'answer:answer_too_long' }, created_at: '2026-08-01T11:00:00.000Z' }),
      event({
        event_id: 'e3',
        type: 'assistant_task_abandoned',
        payload: { error: 'Assistant task failed after 3 attempts.' },
        created_at: '2026-08-01T11:01:00.000Z',
      }),
    ]);

    expect(failure).toEqual({
      reason: 'answer:answer_too_long',
      error: 'Assistant task failed after 3 attempts.',
      abandoned: true,
    });
  });

  it('is null when the timeline records no failure', () => {
    expect(assistantFailureFromEvents([event({ type: 'run_completed' })])).toBeNull();
    expect(assistantFailureFromEvents(undefined)).toBeNull();
  });
});

describe('describeToolParams', () => {
  it('words the declared parameter shape and drops the empty slots', () => {
    expect(
      describeToolParams({
        query_chars: 12,
        status: 'done',
        project_chars: 0,
        created_after: '',
        order_by: 'created_at',
        paged: false,
        limit: 50,
      }),
    ).toBe('free text (12 chars) · status done · ordered by created_at · limit 50');
  });

  it('words knowledge_id the way it words case_id', () => {
    // Without the `knowledge_id` case, `arbitra_get_knowledge`'s evidence row
    // falls through to the raw `key: value` default.
    expect(describeToolParams({ knowledge_id: 'ka_abcdefgh' })).toBe('knowledge ka_abcdefgh');
    expect(describeToolParams({ case_id: 'case_abc' })).toBe('case case_abc');
  });

  it('shows a parameter it has no wording for rather than hiding it', () => {
    expect(describeToolParams({ unknown_input_keys: 2 })).toBe('unknown_input_keys: 2');
  });
});
