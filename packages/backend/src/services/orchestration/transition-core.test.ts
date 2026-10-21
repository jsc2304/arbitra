import { describe, it, expect, vi } from 'vitest';
import type { Case, CaseStatus, EventType } from '@arbitra/shared';
import { TransitionError } from '@arbitra/shared';
import { FieldValue } from 'firebase-admin/firestore';

/**
 * The extracted transaction body. What matters is that it is the ONLY place the
 * state machine is consulted on the write path, that it still reads before it
 * writes (Firestore forbids the other order), and that a second caller can fold
 * its own case fields into the same document mutation — Firestore rejects more
 * than one mutation per document per commit, so "status here, my field there"
 * would abort the whole transaction.
 *
 * `OrchestrationService`'s own behaviour is pinned by its pre-existing tests,
 * which this change leaves untouched.
 */
vi.mock('../../lib/firestore.js', () => {
  const emptyQuery = () => ({ where: () => ({ get: vi.fn(async () => ({ docs: [] })) }) });
  return {
    getDb: () => ({
      runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
    }),
    collections: {
      runs: emptyQuery,
      findings: emptyQuery,
      ruleResults: emptyQuery,
      evidence: emptyQuery,
      decisions: emptyQuery,
      caseEvents: emptyQuery,
    },
  };
});

const { applyTransitionInTransaction, loadTransactionPreconditionContext } = await import(
  './transition-core.js'
);
const { StateMachine } = await import('./state-machine.js');
type PreconditionContext = import('./preconditions.js').PreconditionContext;

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case-t1',
    title: 'A case',
    description: 'about something',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'usr_owner',
    status: 'open',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    case_type: 'assistant_task',
    assistant_context: {
      channel: 'web',
      conversation_visibility: 'direct',
      requester_user_id: 'usr_owner',
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

/** Records the order of reads and writes so read-before-write is checkable. */
function makeHarness(case_: Case, context: Partial<PreconditionContext> = {}) {
  const order: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const events: Array<{ type: EventType; payload: Record<string, unknown> }> = [];

  const deps = {
    caseRepo: {
      getInTransaction: vi.fn(async () => {
        order.push('read:case');
        return case_;
      }),
      updateInTransaction: vi.fn((_tx: unknown, _id: string, patch: Record<string, unknown>) => {
        order.push('write:case');
        updates.push(patch);
      }),
    },
    eventService: {
      emitInTransaction: vi.fn(
        async (
          _tx: unknown,
          _caseId: string,
          type: EventType,
          payload: Record<string, unknown>,
        ) => {
          order.push(`write:event:${type}`);
          events.push({ type, payload });
          return {
            event_id: 'evt_x',
            case_id: case_.case_id,
            type,
            actor_id: 'a',
            payload,
            created_at: 'now',
          };
        },
      ),
    },
    stateMachine: new StateMachine(),
    loadPreconditionContext: async (loaded: Case, actorId: string) => {
      order.push('read:context');
      return {
        case_: loaded,
        runs: [],
        findings: [],
        ruleResults: [],
        evidence: [],
        decisions: [],
        events: [],
        actorId,
        ...context,
      } as PreconditionContext;
    },
  };

  return { deps, order, updates, events };
}

const RUNNING_ASSISTANT_RUN = {
  run_id: 'run_1',
  case_id: 'case-t1',
  run_type: 'assistant_task_run' as const,
  trigger_source: 'test',
  status: 'running' as const,
  input_refs: [],
  output_refs: [],
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
};

describe('applyTransitionInTransaction', () => {
  it('validates through the state machine and stages the status write and its events', async () => {
    const case_ = makeCase({ status: 'open' });
    const { deps, updates, events } = makeHarness(case_, { runs: [RUNNING_ASSISTANT_RUN] });

    const result = await applyTransitionInTransaction({} as never, case_.case_id, 'in_build', 'usr_actor', deps);

    expect(result.from).toBe('open');
    expect(result.case.status).toBe('in_build');
    expect(result.events).toEqual(['assistant_task_started']);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: 'in_build' });
    expect(updates[0]!['updated_at']).toEqual(expect.any(String));
    expect(events.map((e) => e.type)).toEqual(['assistant_task_started']);
    expect(events[0]!.payload).toEqual({ from_status: 'open', to_status: 'in_build' });
  });

  it('reads before it writes, so a caller can add its own writes after', async () => {
    const case_ = makeCase({ status: 'open' });
    const { deps, order } = makeHarness(case_, { runs: [RUNNING_ASSISTANT_RUN] });

    await applyTransitionInTransaction({} as never, case_.case_id, 'in_build', 'usr_actor', deps);

    const firstWrite = order.findIndex((step) => step.startsWith('write:'));
    const lastRead = order.map((s) => s.startsWith('read:')).lastIndexOf(true);
    expect(lastRead).toBeLessThan(firstWrite);
  });

  it('throws the state machine’s TransitionError rather than deciding anything itself', async () => {
    const case_ = makeCase({ status: 'open' });
    // No running assistant run: `assistant_run_claimed` is unsatisfied.
    const { deps, updates, events } = makeHarness(case_);

    await expect(
      applyTransitionInTransaction({} as never, case_.case_id, 'in_build', 'usr_actor', deps),
    ).rejects.toThrow(TransitionError);
    // Nothing staged — the caller's transaction aborts with it.
    expect(updates).toEqual([]);
    expect(events).toEqual([]);
  });

  it('rejects a target the matrix does not offer for this case type', async () => {
    const case_ = makeCase({ status: 'open' });
    const { deps } = makeHarness(case_);

    await expect(
      applyTransitionInTransaction(
        {} as never,
        case_.case_id,
        'exploration' as CaseStatus,
        'usr_actor',
        deps,
      ),
    ).rejects.toThrow(/Invalid transition from 'open' to 'exploration'/);
  });

  it('folds extra case fields into the SAME update as the status', async () => {
    const case_ = makeCase({ status: 'open' });
    const { deps, updates } = makeHarness(case_, { runs: [RUNNING_ASSISTANT_RUN] });

    const result = await applyTransitionInTransaction(
      {} as never,
      case_.case_id,
      'in_build',
      'usr_actor',
      deps,
      {
        extraCaseUpdates: {
          assistant_context: { ...case_.assistant_context!, task_kind: 'arbitra_data_question' },
        },
      },
    );

    // One mutation for the case document, carrying both.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: 'in_build' });
    expect((updates[0] as { assistant_context: { task_kind: string } }).assistant_context.task_kind)
      .toBe('arbitra_data_question');
    expect(result.case.assistant_context?.task_kind).toBe('arbitra_data_question');
  });

  it('cannot have its status or timestamp overridden by extra case fields', async () => {
    const case_ = makeCase({ status: 'open' });
    const { deps, updates } = makeHarness(case_, { runs: [RUNNING_ASSISTANT_RUN] });

    await applyTransitionInTransaction(
      {} as never,
      case_.case_id,
      'in_build',
      'usr_actor',
      deps,
      { extraCaseUpdates: { status: 'done', updated_at: '1999-01-01T00:00:00.000Z' } },
    );

    expect(updates[0]!['status']).toBe('in_build');
    expect(updates[0]!['updated_at']).not.toBe('1999-01-01T00:00:00.000Z');
  });

  it('clears a stale pending_gate as part of every transition write (issue #1049)', async () => {
    // The case sat in `in_review` with a `pending_gate` for the
    // review_to_approved gate; a case-level Request Changes decision now
    // drives this SAME shared write path to `in_build`. Nothing about that
    // transition targets `pending_gate` directly — the clear must be
    // unconditional, or the marker keeps pointing at a status the case has
    // already left (the #1049 freeze leg: `tryAutoTransition` refuses to
    // evaluate further auto-transitions while any `pending_gate` is set).
    const case_ = makeCase({
      status: 'in_review',
      // The default `makeCase` case_type is `assistant_task`, which is
      // scoped OUT of the unscoped engineering `in_review → in_build` edge
      // (`isInScope` in status-transitions.ts) — use a normal engineering
      // case_type so that edge is actually reachable here.
      case_type: 'bugfix',
      assistant_context: undefined,
      pending_gate: {
        gate_id: 'review_to_approved',
        target_status: 'approved',
        since: '2026-08-01T00:00:00.000Z',
      },
    });
    const { deps, updates } = makeHarness(case_, {
      decisions: [{
        decision_id: 'dec_1',
        case_id: case_.case_id,
        type: 'request_changes',
        actor_id: 'usr_1',
        rationale: 'needs rework',
        created_at: '2026-08-01T00:00:00.000Z',
      }] as any,
    });

    const result = await applyTransitionInTransaction(
      {} as never,
      case_.case_id,
      'in_build',
      'usr_actor',
      deps,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]!['pending_gate']).toBeInstanceOf(FieldValue);
    expect(result.case.pending_gate).toBeUndefined();
  });

  it('a caller cannot smuggle a live pending_gate back in through extraCaseUpdates', async () => {
    const case_ = makeCase({ status: 'open' });
    const { deps, updates } = makeHarness(case_, { runs: [RUNNING_ASSISTANT_RUN] });

    await applyTransitionInTransaction(
      {} as never,
      case_.case_id,
      'in_build',
      'usr_actor',
      deps,
      {
        extraCaseUpdates: {
          pending_gate: { gate_id: 'ready_to_build', target_status: 'in_build', since: 'now' },
        } as Partial<Case>,
      },
    );

    // `pending_gate` is applied AFTER the spread, same as status/updated_at —
    // it always wins.
    expect(updates[0]!['pending_gate']).toBeInstanceOf(FieldValue);
  });

  it('merges extra event payload keys after from_status/to_status', async () => {
    const case_ = makeCase({ status: 'open' });
    const { deps, events } = makeHarness(case_, { runs: [RUNNING_ASSISTANT_RUN] });

    await applyTransitionInTransaction(
      {} as never,
      case_.case_id,
      'in_build',
      'usr_actor',
      deps,
      { extraEventPayload: { triggered_by: 'assistant_task_executor', run_id: 'run_1' } },
    );

    expect(events[0]!.payload).toEqual({
      from_status: 'open',
      to_status: 'in_build',
      triggered_by: 'assistant_task_executor',
      run_id: 'run_1',
    });
  });
});

describe('loadTransactionPreconditionContext', () => {
  it('never installs the review auto-heal hook, whose writes would conflict on retry', async () => {
    const ctx = await loadTransactionPreconditionContext(makeCase(), 'usr_actor');

    expect(ctx.onAutoHealReviewNotApplicable).toBeUndefined();
    expect(ctx.actorId).toBe('usr_actor');
    expect(ctx.runs).toEqual([]);
  });
});

// ── Approval pin (issue #1045) ────────────────────────────────────────────

/**
 * The state machine is stubbed in this block on purpose: what is under test
 * is the WRITE STAGING for the approval pin, not which transitions are
 * legal. Preconditions for the real `→ approved` edges are covered by
 * `state-machine.test.ts` and `preconditions.test.ts`.
 */
function makePinHarness(case_: Case) {
  const { deps, updates, events } = makeHarness(case_);
  return {
    updates,
    events,
    deps: {
      ...deps,
      stateMachine: {
        validateTransition: async () => ({ events: ['case_approved'] as EventType[] }),
      },
    } as unknown as Parameters<typeof applyTransitionInTransaction>[4],
  };
}

describe('applyTransitionInTransaction — approval pin (#1045)', () => {
  it('pins the observed head SHA in the SAME write as the status', async () => {
    // Revert line: the `targetStatus === 'approved'` stamp. Without it the
    // case is approved with no pin, and every later `arbitra/case` publish
    // fails closed — or, under the original design, a detached notifier
    // wrote the pin afterwards and raced the auto `approved → pending_merge`
    // publish.
    const case_ = makeCase({ status: 'in_review', current_head_sha: 'SHA_REVIEWED' });
    const { deps, updates } = makePinHarness(case_);

    const result = await applyTransitionInTransaction(
      {} as never, case_.case_id, 'approved', 'usr_reviewer', deps,
    );

    // ONE document mutation, carrying both the status and the pin: Firestore
    // rejects a second mutation of the same document in one commit, so a
    // separate pin write could not be part of this transaction at all.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: 'approved',
      approved_head_sha: 'SHA_REVIEWED',
    });
    expect(result.case.approved_head_sha).toBe('SHA_REVIEWED');
  });

  it('CLEARS a stale pin when no head SHA has been observed', async () => {
    // Leaving an earlier approval's pin in place would describe the wrong
    // approval. `FieldValue.delete()` — not `undefined`, which this
    // Firestore instance silently drops under `ignoreUndefinedProperties`.
    const case_ = makeCase({
      status: 'in_review',
      current_head_sha: undefined,
      approved_head_sha: 'SHA_FROM_A_PREVIOUS_APPROVAL',
    });
    const { deps, updates } = makePinHarness(case_);

    const result = await applyTransitionInTransaction(
      {} as never, case_.case_id, 'approved', 'usr_reviewer', deps,
    );

    expect(updates[0]!['approved_head_sha']).toBe(FieldValue.delete());
    expect(result.case.approved_head_sha).toBeUndefined();
  });

  it('does NOT touch the pin on any other transition', async () => {
    // The downstream `approved → pending_merge → done` edges must not
    // re-pin: re-pinning there would advance the pin onto a commit pushed
    // AFTER the approval, which is the defect this whole change exists for.
    for (const target of ['pending_merge', 'done', 'in_build', 'rejected'] as CaseStatus[]) {
      const case_ = makeCase({ status: 'approved', approved_head_sha: 'SHA_REVIEWED' });
      const { deps, updates } = makePinHarness(case_);

      await applyTransitionInTransaction({} as never, case_.case_id, target, 'usr_actor', deps);

      expect(Object.keys(updates[0]!), target).not.toContain('approved_head_sha');
    }
  });

  it('a caller cannot forge the pin through extraCaseUpdates', async () => {
    const case_ = makeCase({ status: 'in_review', current_head_sha: 'SHA_REVIEWED' });
    const { deps, updates } = makePinHarness(case_);

    await applyTransitionInTransaction(
      {} as never, case_.case_id, 'approved', 'usr_reviewer', deps,
      { extraCaseUpdates: { approved_head_sha: 'SHA_ATTACKER_CHOSE' } },
    );

    expect(updates[0]!['approved_head_sha']).toBe('SHA_REVIEWED');
  });
});
