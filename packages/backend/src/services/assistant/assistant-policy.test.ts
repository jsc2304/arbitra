import { describe, it, expect, vi } from 'vitest';
import type { Case } from '@arbitra/shared';

/**
 * #786 regression contract: keyword classification labels telemetry only. The
 * read boundary is the allowlisted registry narrowed by requester
 * authorization, never words in the request.
 */
vi.mock('../../lib/firestore.js', () => ({
  getDb: () => {
    throw new Error('assistant-policy.test.ts must not reach Firestore');
  },
  collections: {},
}));

const { checkAssistantTaskInput, decideAssistantPolicy } = await import('./assistant-policy.js');
const {
  ASSISTANT_TOOL_REGISTRY,
  COUNT_CASES_TOOL,
  SEARCH_CASES_TOOL,
  GET_CASE_TOOL,
  SEARCH_KNOWLEDGE_TOOL,
  isReadToolDescriptor,
} = await import('./tool-registry.js');

function makeCase(text: string, overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case-policy',
    title: text.split('\n')[0] ?? text,
    description: text,
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
    assistant_context: {
      channel: 'web',
      conversation_visibility: 'direct',
      requester_user_id: 'usr_requester',
      risk_level: 'low',
      policy_version: 'assistant_policy:v1',
      prompt_version: 'assistant_task:v1',
    },
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('decideAssistantPolicy — the enabled subset', () => {
  // Derived from the live registry, not a hardcoded list of names: the
  // default `availableNames` this function falls back to (no explicit
  // narrowing passed in) is EVERY registry read tool.
  const allReadTools = ASSISTANT_TOOL_REGISTRY.filter(isReadToolDescriptor).map((d) => d.name);

  it.each([
    'Rewrite this paragraph in plainer language.',
    'How do I phrase a polite follow-up in German?',
    'What is the difference between idempotency and atomicity?',
    'Fasse diesen Absatz kürzer zusammen.',
  ])('keeps requester-scoped reads available while labelling a general task: %s', (text) => {
    const decision = decideAssistantPolicy(makeCase(text));
    expect(decision.enabled_tools).toEqual(allReadTools);
    expect(decision.task_kind).toBe('general_question');
    expect(decision.tool_selection_reason).toBe('requester_scoped_read_registry');
  });

  it('does not let a case keyword remove the knowledge read tool', () => {
    const decision = decideAssistantPolicy(
      makeCase('Which of my cases are still waiting for a decision?'),
    );
    expect(decision.enabled_tools).toEqual(allReadTools);
    expect(decision.task_kind).toBe('arbitra_data_question');
  });

  it('gives a knowledge question the knowledge tool', () => {
    const decision = decideAssistantPolicy(
      makeCase('Do we have a knowledge asset about retry patterns?'),
    );
    expect(decision.enabled_tools).toContain(SEARCH_KNOWLEDGE_TOOL.name);
  });

  it('classifies without changing tools for the verbatim #786 project comparison', () => {
    const comparison = decideAssistantPolicy(makeCase(
      "Compare the projects 'Payments API' and 'Acme Atlas': which has more open work, and which was active more recently?",
    ));
    const explicitCaseQuestion = decideAssistantPolicy(makeCase('Show me my open Arbitra cases.'));

    // Reverting #786 to the outer keyword gate makes this assertion fail with [].
    expect(comparison.enabled_tools).toEqual(allReadTools);
    expect(comparison.enabled_tools).toEqual(explicitCaseQuestion.enabled_tools);
    expect(comparison.task_kind).toBe('general_question');
    expect(explicitCaseQuestion.task_kind).toBe('arbitra_data_question');
  });

  it('classifies a request for an outward action, and still refuses to enable a writing tool', () => {
    const decision = decideAssistantPolicy(makeCase('Please close the case for the invoice bug.'));
    expect(decision.task_kind).toBe('action_request');
    // Only read tools exist, so even an action request gets reads at most.
    for (const name of decision.enabled_tools) {
      expect(name.startsWith('arbitra_')).toBe(true);
    }
  });

  it('does not read ordinary English as an action request', () => {
    // "open" as an adjective, "change" as a noun, "comment" as a noun.
    for (const text of [
      'Which cases are still open in Arbitra?',
      'Was there any change to the evidence on my cases?',
      'Summarise the review comment on my case.',
    ]) {
      expect(decideAssistantPolicy(makeCase(text)).task_kind).toBe('arbitra_data_question');
    }
  });

  it('never returns a name that is not a registered read tool', () => {
    const decision = decideAssistantPolicy(makeCase('Show me my cases.'), [
      'arbitra_search_cases',
      'arbitra_delete_everything',
    ]);
    expect(decision.enabled_tools).toEqual([SEARCH_CASES_TOOL.name]);
  });

  it('cannot be widened past the registry by the caller', () => {
    const decision = decideAssistantPolicy(makeCase('Show me my cases.'), []);
    expect(decision.enabled_tools).toEqual([]);
  });
});

describe('decideAssistantPolicy — trace shape', () => {
  it('every decision is schema_version 1 and carries exactly the documented fields', () => {
    const decision = decideAssistantPolicy(makeCase('Show me my cases.'));
    expect(decision.schema_version).toBe(1);
    expect(Object.keys(decision).sort()).toEqual([
      'enabled_tools',
      'schema_version',
      'task_kind',
      'tool_selection_reason',
    ]);
  });

  it('the keyword classifier never grants or denies a tool', () => {
    // #786's invariant: task_kind changes with the text, enabled_tools does
    // not — it comes only from the explicit availableNames argument.
    const dataQuestion = decideAssistantPolicy(
      makeCase('Which of my cases are open?'),
      [SEARCH_CASES_TOOL.name],
    );
    const generalQuestion = decideAssistantPolicy(
      makeCase('Rewrite this sentence more politely.'),
      [SEARCH_CASES_TOOL.name],
    );
    expect(dataQuestion.task_kind).toBe('arbitra_data_question');
    expect(generalQuestion.task_kind).toBe('general_question');
    expect(dataQuestion.enabled_tools).toEqual(generalQuestion.enabled_tools);
  });
});

describe('checkAssistantTaskInput — mechanical runnability', () => {
  it('accepts an ordinary task', () => {
    expect(checkAssistantTaskInput(makeCase('Which cases are open?'), 8000)).toEqual({ ok: true });
  });

  it('rejects a case with no requester, because no access scope could be resolved', () => {
    const case_ = makeCase('Which cases are open?');
    delete case_.assistant_context!.requester_user_id;
    expect(checkAssistantTaskInput(case_, 8000)).toMatchObject({
      ok: false,
      reason: 'missing_requester',
    });
  });

  it('rejects empty text', () => {
    expect(checkAssistantTaskInput(makeCase('   \n '), 8000)).toMatchObject({
      ok: false,
      reason: 'empty_text',
    });
  });

  it('re-checks the length against the CURRENT limit, not the one intake used', () => {
    expect(checkAssistantTaskInput(makeCase('x'.repeat(200)), 100)).toMatchObject({
      ok: false,
      reason: 'text_too_long',
    });
  });
});
