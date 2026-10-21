/**
 * Parity suite for the decode/parse/select logic moved here from
 * `packages/frontend/src/lib/assistant-task-result.ts` (Slice F,
 * `docs/specs/clerk-config-scheduling-chat.md`). This exercises the SHARED
 * implementation directly; `packages/frontend/src/lib/__tests__/assistant-task-result.test.ts`
 * continues to exercise the exact same behaviour through the frontend
 * module's re-export, unmodified — the two suites together are the parity
 * proof that the move changed nothing observable.
 */
import { describe, expect, it } from 'vitest';
import type { AssistantToolPolicyTrace } from '../types/run.js';
import type { Evidence } from '../types/evidence.js';
import {
  ASSISTANT_TASK_RESULT_SCHEMA,
  ASSISTANT_TASK_RESULT_SCHEMA_V1,
  decodeBase64DataUrl,
  parseAssistantTaskResult,
  taskResultArtifactRef,
} from './assistant-task-result.js';

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

  it('refuses an artifact that is not an assistant result', () => {
    expect(() =>
      parseAssistantTaskResult(jsonDataUrl({ schema: 'arbitra.review_result/v1', answer: 'x' })),
    ).toThrow(/Unexpected artifact schema/);
  });

  describe('injected_context', () => {
    it('reads the entries the executor recorded', () => {
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
