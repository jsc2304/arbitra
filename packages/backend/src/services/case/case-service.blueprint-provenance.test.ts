/**
 * Issue #858: `assistantContextSchema` (shared by `createCaseSchema` and
 * `updateCaseSchema`) has no `blueprint_id`/`blueprint_context` fields, so
 * `PATCH /api/cases/:caseId` can never forge a blueprint reference — but
 * `ref.update()` replaces the whole `assistant_context` map, not a deep
 * merge, so ANY update that touches `assistant_context` at all (even just to
 * add `wait_reason`) would silently drop an existing blueprint reference,
 * since the validated input can never carry it back. These tests pin the
 * server-side re-attach in `CaseService.updateCase` that closes that gap.
 *
 * PR #887: the same schema also has no `reads_withheld`/
 * `reads_withheld_reason` fields (stamped only by `AssistantTaskExecutor`'s
 * own write, a different path), so they sit in the identical hazard. A
 * partial `assistant_context` PATCH through this service — e.g. from
 * `arbitra-mcp`'s `update_case` tool — would silently drop the flag off a
 * completed Clerk case. The last two tests below pin the re-attach that now
 * also covers those two fields.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case } from '@arbitra/shared';

const state: { cases: Map<string, Case> } = { cases: new Map() };

function reset(): void {
  state.cases = new Map();
}

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    cases: () => ({
      doc: (id: string) => ({
        get: async () => {
          const c = state.cases.get(id);
          return { exists: c !== undefined, data: () => c };
        },
        update: async (patch: Partial<Case>) => {
          const existing = state.cases.get(id);
          if (!existing) throw new Error(`no doc ${id}`);
          // Mirrors real Firestore semantics for this test's purposes: a
          // plain-object value assigned to a top-level key REPLACES that
          // nested map wholesale, it does not deep-merge into it.
          state.cases.set(id, { ...existing, ...patch });
        },
      }),
    }),
  },
  getDb: () => ({}),
}));

import { CaseService } from './case-service.js';
import { CaseRepository } from './case-repository.js';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'T',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_a',
    repository_id: 'repo_1',
    owner_user_id: 'usr_owner',
    status: 'open',
    validation_track: 'direct',
    risk_level: 'medium',
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

const stubEventService = { emit: vi.fn().mockResolvedValue(undefined) };

function makeService(): CaseService {
  return new CaseService(new CaseRepository(), stubEventService as never);
}

describe('CaseService.updateCase — blueprint provenance re-attach (#858)', () => {
  beforeEach(() => {
    reset();
    stubEventService.emit.mockClear();
  });

  it('re-attaches blueprint_id and blueprint_context that the validated input cannot carry', async () => {
    state.cases.set(
      'case_1',
      makeCase({
        assistant_context: {
          channel: 'blueprint',
          conversation_visibility: 'direct',
          risk_level: 'low',
          policy_version: 'assistant_policy:v1',
          prompt_version: 'assistant_task:v1',
          blueprint_id: 'taskBlueprint_roster_check',
          blueprint_context: {
            blueprint_id: 'taskBlueprint_roster_check',
            blueprint_version: 2,
            prompt_text: "Every Monday at 9, summarize my team's open cases",
          },
        },
      }),
    );
    const service = makeService();

    // Simulates the executor's own classification write reaching this same
    // service — or any other update touching assistant_context — via the
    // shape `updateCaseSchema` actually allows: no blueprint_id/blueprint_context
    // in it, because the schema does not have those fields.
    const updated = await service.updateCase(
      'case_1',
      {
        assistant_context: {
          channel: 'blueprint',
          conversation_visibility: 'direct',
          risk_level: 'low',
          policy_version: 'assistant_policy:v1',
          prompt_version: 'assistant_task:v1',
          task_kind: 'general_question',
        },
      },
      'usr_owner',
    );

    expect(updated.assistant_context?.blueprint_id).toBe('taskBlueprint_roster_check');
    expect(updated.assistant_context?.blueprint_context).toEqual({
      blueprint_id: 'taskBlueprint_roster_check',
      blueprint_version: 2,
      prompt_text: "Every Monday at 9, summarize my team's open cases",
    });
    // The update's own field still lands — this is a re-attach, not a
    // rejection of the rest of the change.
    expect(updated.assistant_context?.task_kind).toBe('general_question');
  });

  it('does not fabricate blueprint fields on a case that never had them', async () => {
    state.cases.set(
      'case_1',
      makeCase({
        assistant_context: {
          channel: 'web',
          conversation_visibility: 'direct',
          risk_level: 'low',
          policy_version: 'assistant_policy:v1',
          prompt_version: 'assistant_task:v1',
        },
      }),
    );
    const service = makeService();

    const updated = await service.updateCase(
      'case_1',
      {
        assistant_context: {
          channel: 'web',
          conversation_visibility: 'direct',
          risk_level: 'low',
          policy_version: 'assistant_policy:v1',
          prompt_version: 'assistant_task:v1',
          task_kind: 'general_question',
        },
      },
      'usr_owner',
    );

    expect(updated.assistant_context?.blueprint_id).toBeUndefined();
    expect(updated.assistant_context?.blueprint_context).toBeUndefined();
  });

  it('leaves assistant_context untouched when the update does not mention it at all', async () => {
    const original = makeCase({
      assistant_context: {
        channel: 'blueprint',
        conversation_visibility: 'direct',
        risk_level: 'low',
        policy_version: 'assistant_policy:v1',
        prompt_version: 'assistant_task:v1',
        blueprint_id: 'taskBlueprint_roster_check',
      },
    });
    state.cases.set('case_1', original);
    const service = makeService();

    const updated = await service.updateCase('case_1', { title: 'New title' }, 'usr_owner');

    expect(updated.assistant_context).toEqual(original.assistant_context);
    expect(updated.title).toBe('New title');
  });

  it('re-attaches reads_withheld and reads_withheld_reason that the validated input cannot carry', async () => {
    state.cases.set(
      'case_1',
      makeCase({
        status: 'done',
        assistant_context: {
          channel: 'blueprint',
          conversation_visibility: 'direct',
          risk_level: 'low',
          policy_version: 'assistant_policy:v1',
          prompt_version: 'assistant_task:v1',
          task_kind: 'general_question',
          reads_withheld: true,
          reads_withheld_reason: 'read_budget_exhausted',
        },
      }),
    );
    const service = makeService();

    // Simulates a partial `assistant_context` PATCH reaching this service via
    // the shape `updateCaseSchema` actually allows — e.g. `arbitra-mcp`'s
    // `update_case` tool adding a `wait_reason` — with no
    // reads_withheld/reads_withheld_reason in it, because the schema does
    // not have those fields either.
    const updated = await service.updateCase(
      'case_1',
      {
        assistant_context: {
          channel: 'blueprint',
          conversation_visibility: 'direct',
          risk_level: 'low',
          policy_version: 'assistant_policy:v1',
          prompt_version: 'assistant_task:v1',
          task_kind: 'general_question',
          wait_reason: 'clarification',
        },
      },
      'usr_owner',
    );

    expect(updated.assistant_context?.reads_withheld).toBe(true);
    expect(updated.assistant_context?.reads_withheld_reason).toBe('read_budget_exhausted');
    // The update's own field still lands — this is a re-attach, not a
    // rejection of the rest of the change.
    expect(updated.assistant_context?.wait_reason).toBe('clarification');
  });

  it('preserves the Chat double-post guard across an assistant_context update', async () => {
    // `chat_reply_posted_at` is what stops the same Clerk answer being posted
    // into a Chat space twice. `assistant_context` is not phase-gated, so an
    // update can legally arrive even on a terminal case — losing the stamp
    // here would re-open the duplicate-post window.
    state.cases.set(
      'case_1',
      makeCase({
        assistant_context: {
          channel: 'google_chat',
          conversation_visibility: 'space',
          risk_level: 'low',
          policy_version: 'assistant_policy:v1',
          prompt_version: 'assistant_task:v1',
          chat_reply_posted_at: '2026-08-20T18:00:00.000Z',
        },
      }),
    );
    const service = makeService();

    const updated = await service.updateCase(
      'case_1',
      {
        assistant_context: {
          channel: 'google_chat',
          conversation_visibility: 'space',
          risk_level: 'low',
          policy_version: 'assistant_policy:v1',
          prompt_version: 'assistant_task:v1',
          wait_reason: 'clarification',
        },
      },
      'usr_owner',
    );

    expect(updated.assistant_context?.chat_reply_posted_at).toBe('2026-08-20T18:00:00.000Z');
    expect(updated.assistant_context?.wait_reason).toBe('clarification');
  });


  it('does not fabricate reads_withheld on a case that never had it', async () => {
    state.cases.set(
      'case_1',
      makeCase({
        assistant_context: {
          channel: 'web',
          conversation_visibility: 'direct',
          risk_level: 'low',
          policy_version: 'assistant_policy:v1',
          prompt_version: 'assistant_task:v1',
        },
      }),
    );
    const service = makeService();

    const updated = await service.updateCase(
      'case_1',
      {
        assistant_context: {
          channel: 'web',
          conversation_visibility: 'direct',
          risk_level: 'low',
          policy_version: 'assistant_policy:v1',
          prompt_version: 'assistant_task:v1',
          task_kind: 'general_question',
        },
      },
      'usr_owner',
    );

    expect(updated.assistant_context?.reads_withheld).toBeUndefined();
    expect(updated.assistant_context?.reads_withheld_reason).toBeUndefined();
  });
});
