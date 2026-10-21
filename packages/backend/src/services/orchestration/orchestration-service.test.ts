import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CaseEvent, Case, CaseStatus, EventType, TransitionDefinition } from '@arbitra/shared';
import type { CaseRepository } from '../case/case-repository.js';
import type { EventService } from '../event/event-service.js';
import type { StateMachine } from './state-machine.js';

// Captured calls to the completion closer (issue #751).
const closerCalls: { value: Array<[string, string]> } = { value: [] };

vi.mock('./waiver-completion.js', () => ({
  closeOutstandingWaiverProposalsOnCompletion: vi.fn(
    async (caseId: string, context: string) => {
      closerCalls.value.push([caseId, context]);
      return { closed: 0 };
    },
  ),
}));

vi.mock('../../lib/firestore.js', () => {
  // Transaction bodies run inline; every precondition-context query is empty.
  const emptyQuery = () => ({ where: () => ({ get: vi.fn(async () => ({ docs: [] })) }) });

  // Minimal in-memory Firestore double for `case-pipeline-lock.ts`: supports
  // collection().doc() refs plus a runTransaction(tx.get/set/delete) surface.
  // The SAME `runTransaction` also backs `OrchestrationService.transition`'s
  // own outer transaction — the mocked caseRepo/eventService below treat the
  // `transaction` value opaquely, so serving the richer lock-capable tx
  // object there too is harmless. Mirrors the double in `pipeline.test.ts`
  // (issue #754 gives `orchestration-service.ts` the same lock dependency).
  const lockStore = new Map<string, unknown>();

  interface FakeRef {
    __path: string;
  }
  interface FakeTx {
    get(ref: FakeRef): Promise<{ exists: boolean; data: () => unknown }>;
    set(ref: FakeRef, data: unknown): void;
    delete(ref: FakeRef): void;
  }

  const fakeDb = {
    collection: (name: string) => ({
      doc: (id: string): FakeRef => ({ __path: `${name}/${id}` }),
    }),
    runTransaction: async <T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> => {
      const tx: FakeTx = {
        get: async (ref) => {
          const data = lockStore.get(ref.__path);
          return { exists: data !== undefined, data: () => data };
        },
        set: (ref, data) => {
          lockStore.set(ref.__path, data);
        },
        delete: (ref) => {
          lockStore.delete(ref.__path);
        },
      };
      return fn(tx);
    },
  };

  return {
    getDb: () => fakeDb,
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

import { OrchestrationService } from './orchestration-service.js';
// Imported (not just mocked above) so the test can inspect
// `.mock.invocationCallOrder` and verify actual ordering against the
// transactional status write, rather than merely that both happened.
import { closeOutstandingWaiverProposalsOnCompletion } from './waiver-completion.js';
// NOT mocked — exercised directly against the fake Firestore above so the
// pipeline-lock tests (issue #754) observe the real acquire/release
// semantics `transition()` depends on, not a stand-in.
import { acquireCasePipelineLock, CasePipelineLockHeldError } from './case-pipeline-lock.js';

function makeCase(status: CaseStatus, overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1', title: 'Test', description: '', source_type: 'manual',
    source_ref: '', project_id: 'p1', repository_id: 'r1', owner_user_id: 'usr_owner',
    status, validation_track: 'direct', risk_level: 'medium',
    priority: 'normal', active_rule_set_refs: [], knowledge_context_refs: [],
    decision_ready: true, created_at: '', updated_at: '',
    ...overrides,
  };
}

function makeService(
  fromStatus: CaseStatus,
  targetStatus: CaseStatus,
  options: {
    events?: EventType[];
    validateTransition?: () => Promise<TransitionDefinition>;
    caseOverrides?: Partial<Case>;
  } = {},
) {
  const updateInTransaction = vi.fn();
  const caseRepo = {
    getInTransaction: vi.fn(async () => makeCase(fromStatus, options.caseOverrides)),
    updateInTransaction,
  } as unknown as CaseRepository;
  const emitInTransaction = vi.fn(
    async (
      _tx: unknown,
      caseId: string,
      type: EventType,
      payload: Record<string, unknown>,
      actorId: string,
    ): Promise<CaseEvent> => ({
      event_id: `evt_${type}`,
      case_id: caseId,
      type,
      payload,
      actor_id: actorId,
      created_at: '2026-08-07T00:00:00.000Z',
    }),
  );
  const notifyCommitted = vi.fn();
  const eventService = {
    emitInTransaction,
    notifyCommitted,
  } as unknown as EventService;
  const stateMachine = {
    validateTransition: vi.fn(
      options.validateTransition
        ?? (async (): Promise<TransitionDefinition> => ({
          from: fromStatus,
          to: targetStatus,
          preconditions: [],
          events: options.events ?? [],
        })),
    ),
  } as unknown as StateMachine;

  return {
    service: new OrchestrationService(caseRepo, eventService, stateMachine),
    updateInTransaction,
    emitInTransaction,
    notifyCommitted,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  closerCalls.value = [];
});

describe('OrchestrationService.transition — waiver cleanup on completion (issue #751)', () => {
  it('closes outstanding waiver proposals after committing a transition to done', async () => {
    const { service, updateInTransaction } = makeService('pending_merge', 'done');

    const result = await service.transition('case_1', 'done', 'usr_reviewer');

    expect(result.status).toBe('done');
    expect(closerCalls.value).toEqual([['case_1', 'completion']]);
    expect(updateInTransaction).toHaveBeenCalledTimes(1);
    // Ordering matters: the closer's writes are non-transactional, so it must
    // run only after the status write committed. A call-count check alone
    // can't tell us that — compare each mock's invocation order directly.
    const statusWriteOrder = updateInTransaction.mock.invocationCallOrder[0]!;
    const closerOrder = vi.mocked(closeOutstandingWaiverProposalsOnCompletion).mock
      .invocationCallOrder[0]!;
    expect(closerOrder).toBeGreaterThan(statusWriteOrder);
  });

  it('does not run the closer for a transition to a non-done status', async () => {
    const { service } = makeService('approved', 'pending_merge');

    const result = await service.transition('case_1', 'pending_merge', 'usr_reviewer');

    expect(result.status).toBe('pending_merge');
    expect(closerCalls.value).toEqual([]);
  });
});

describe('OrchestrationService.transition — post-commit notification (transactional bypass fix)', () => {
  it('notifies for the events the transition committed, after the transaction resolves', async () => {
    // Pre-fix, `case_completed`/`case_approved`/etc. emitted via a transition
    // NEVER notified — `emitInTransaction` staged the write and nothing else
    // ever called the notifier for it. Reverting the `notifyCommitted` call
    // in `orchestration-service.ts` (or dropping `committedEvents` from
    // `transition-core.ts`'s return) would fail this.
    const { service, notifyCommitted } = makeService('pending_merge', 'done', {
      events: ['case_completed'],
    });

    await service.transition('case_1', 'done', 'usr_reviewer');

    expect(notifyCommitted).toHaveBeenCalledTimes(1);
    const [notified] = notifyCommitted.mock.calls[0]!;
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      case_id: 'case_1',
      type: 'case_completed',
      actor_id: 'usr_reviewer',
    });
  });

  it('never notifies when the transaction throws — a rolled-back transition must stay silent', async () => {
    // The state machine rejecting the transition is the most common abort:
    // `applyTransitionInTransaction` throws `TransitionError` before staging
    // any event, so `transition()`'s own `runTransaction` call rejects and
    // its callback's `committedEvents = result.committedEvents` assignment
    // never runs. `notifyCommitted` must never be called in that case — a
    // notification for a transition that never happened would be a lie.
    const { service, notifyCommitted, emitInTransaction } = makeService('pending_merge', 'done', {
      events: ['case_completed'],
      validateTransition: async () => {
        throw new Error('no matching transition');
      },
    });

    await expect(service.transition('case_1', 'done', 'usr_reviewer')).rejects.toThrow('no matching transition');

    expect(emitInTransaction).not.toHaveBeenCalled();
    expect(notifyCommitted).not.toHaveBeenCalled();
  });
});

describe('OrchestrationService.transition — case pipeline lock (issue #754)', () => {
  it('holds the case pipeline lock for the duration of the transaction, then releases it', async () => {
    // Assert the lock is actually held WHILE the transaction body runs by
    // trying (and expecting to fail) to acquire it a second time from inside
    // `caseRepo.getInTransaction` — the first read the transaction body
    // performs. Observing `LOCK_HELD` there proves `transition()` acquired
    // the lock BEFORE opening its transaction, not merely that acquire/
    // release were called at some point during the call.
    let heldDuringTransaction: unknown;
    const updateInTransaction = vi.fn();
    const caseRepo = {
      getInTransaction: vi.fn(async () => {
        try {
          const reentrant = await acquireCasePipelineLock('case_1');
          heldDuringTransaction = null; // acquired again — lock was NOT held
          await reentrant.release();
        } catch (err) {
          heldDuringTransaction = err;
        }
        return makeCase('pending_merge');
      }),
      updateInTransaction,
    } as unknown as CaseRepository;
    const eventService = {
      emitInTransaction: vi.fn(async (): Promise<CaseEvent> => ({
        event_id: 'evt_1',
        case_id: 'case_1',
        type: 'case_completed',
        payload: {},
        actor_id: 'usr_reviewer',
        created_at: '2026-08-07T00:00:00.000Z',
      })),
      notifyCommitted: vi.fn(),
    } as unknown as EventService;
    const stateMachine = {
      validateTransition: vi.fn(async (): Promise<TransitionDefinition> => ({
        from: 'pending_merge',
        to: 'done',
        preconditions: [],
        events: [],
      })),
    } as unknown as StateMachine;
    const service = new OrchestrationService(caseRepo, eventService, stateMachine);

    await service.transition('case_1', 'done', 'usr_reviewer');

    expect(heldDuringTransaction).toBeInstanceOf(CasePipelineLockHeldError);

    // Released afterward: a fresh acquire from outside must now succeed
    // immediately (it would reject with LOCK_HELD if `transition()` had
    // leaked its own hold).
    const handle = await acquireCasePipelineLock('case_1');
    await handle.release();
  });

  it('releases the lock even when the transition fails', async () => {
    const { service } = makeService('pending_merge', 'done', {
      validateTransition: async () => {
        throw new Error('no matching transition');
      },
    });

    await expect(
      service.transition('case_1', 'done', 'usr_reviewer'),
    ).rejects.toThrow('no matching transition');

    // Released despite the failure — the `finally` block must run release()
    // regardless of how the transaction body exits. A fresh acquire from
    // outside must succeed immediately.
    const handle = await acquireCasePipelineLock('case_1');
    await handle.release();
  });

  it('surfaces a retryable 409 conflict when the pipeline lock is already held, instead of transitioning', async () => {
    // Simulates the race from issue #754: the pipeline's own auto-transition
    // cycle (`RunCompletionHandler.onRunCompleted`) is mid-evaluation for
    // this case and holds the lock when an explicit transition request comes
    // in. Pre-#754, `transition()` ignored the lock entirely and could
    // double-fire transition side effects; it must now fail fast instead of
    // silently proceeding.
    const { service, updateInTransaction } = makeService('pending_merge', 'done');
    const externalHandle = await acquireCasePipelineLock('case_1');

    try {
      await expect(
        service.transition('case_1', 'done', 'usr_reviewer'),
      ).rejects.toMatchObject({
        name: 'ArbitraError',
        code: 'CASE_PIPELINE_LOCKED',
        statusCode: 409,
      });
      // The transaction body must never have run — no status write staged.
      expect(updateInTransaction).not.toHaveBeenCalled();
    } finally {
      await externalHandle.release();
    }
  });
});


describe('OrchestrationService.transition — approval pin (issue #1045)', () => {
  it('pins the observed head SHA when a human approve reaches `approved`', async () => {
    // The THIRD route into `approved`, and the only one that goes through
    // the transactional core: `DecisionService.approve` calls this method.
    // Driven end to end rather than by constructing an approved case —
    // building the end state is what let the two pipeline routes ship
    // unpinned in the first cut of this fix.
    const { service, updateInTransaction } = makeService('in_review', 'approved', {
      events: ['case_approved'],
      caseOverrides: { current_head_sha: 'SHA_REVIEWED' },
    });

    const result = await service.transition('case_1', 'approved', 'usr_reviewer');

    expect(result.status).toBe('approved');
    // ONE document mutation carrying both — Firestore rejects a second
    // mutation of the same document in one commit, so the pin could not be
    // a separate write inside this transaction even if someone tried.
    expect(updateInTransaction).toHaveBeenCalledTimes(1);
    expect(updateInTransaction.mock.calls[0]![2]).toMatchObject({
      status: 'approved',
      approved_head_sha: 'SHA_REVIEWED',
    });
    expect(result.approved_head_sha).toBe('SHA_REVIEWED');
  });

  it('does not touch the pin on a human transition to any other status', async () => {
    const { service, updateInTransaction } = makeService('approved', 'pending_merge', {
      events: ['merge_ready'],
      caseOverrides: { current_head_sha: 'SHA_PUSHED_LATER', approved_head_sha: 'SHA_REVIEWED' },
    });

    await service.transition('case_1', 'pending_merge', 'usr_reviewer');

    expect(Object.keys(updateInTransaction.mock.calls[0]![2] as object))
      .not.toContain('approved_head_sha');
  });
});
