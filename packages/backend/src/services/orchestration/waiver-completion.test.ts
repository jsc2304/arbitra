import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case, CaseEvent, Decision, Finding } from '@arbitra/shared';

// Findings returned by `collections.findings().where(...).where(...).get()` —
// the outstanding `waiver_proposed` docs the closer operates on.
const findingsQueryDocs: { value: { data: () => Finding }[] } = { value: [] };

// Captured Decision writes, in order.
const writtenDecisions: { value: Decision[] } = { value: [] };

// Captured finding updates, keyed by finding id, so a test can assert the status
// flip and — crucially — that `resolution` was never touched.
const findingUpdates: { value: Array<{ id: string; payload: Record<string, unknown> }> } = {
  value: [],
};

// Finding ids whose transactional `.update(...)` must throw, to exercise
// per-finding isolation (and atomicity with the paired decision `.create(...)`
// AND the `decision_created` event staged in the SAME transaction, issue #913).
const failingFindingIds = new Set<string>();

// Committed decisions, keyed by deterministic decision id — persists across
// separate `closeOutstandingWaiverProposalsOnCompletion` calls within a test,
// the same way a real Firestore collection would. This is what lets a test
// simulate two racing closer runs (issue #754): both call the function with
// the SAME seeded pending finding (as if both queried before either wrote),
// and the second call's transactional `.get(decisionRef)` sees what the first
// call already committed here.
const decisionsStore: Map<string, Decision> = new Map();

// Committed `CaseEvent`s, in commit order — populated ONLY when the whole
// per-finding transaction (decision + finding-update + event, issue #913)
// resolves without throwing, exactly like `writtenDecisions`/`findingUpdates`.
// This module does NOT mock `event-service.js`: `EventService.emitInTransaction`
// and `notifyCommitted` run for real here (only `EventNotifier`, the actual
// I/O boundary, is mocked below), so what lands in this array is whatever the
// real `emitInTransaction` really staged into the fake transaction — not a
// value this test file invented, which is what a mocked `EventService` would
// have given us (stubbed-seam tests prove nothing).
const writtenEvents: { value: CaseEvent[] } = { value: [] };

// Legacy shape (`caseId`/`actorId` instead of `case_id`/`actor_id`) kept so
// the existing assertions below don't need touching — derived from
// `writtenEvents` at commit time, not from a mocked `emit()` call.
const emittedEvents: {
  value: Array<{ caseId: string; type: string; payload: Record<string, unknown>; actorId: string }>;
} = { value: [] };

// Global commit log shared between decision and event staging, tagged by
// finding id. Both entries for one finding are pushed together, in the same
// commit step, because the fix (issue #913) stages the event in the SAME
// transaction as the decision — there is no ordering between them to assert
// anymore (see the "atomicity" test below for what replaced that assertion).
const callLog: { value: string[] } = { value: [] };

// Spy on the one real I/O boundary `EventService.notifyCommitted` reaches:
// the notifier. `notifyCommitted` itself is synchronous fire-and-forget and
// writes nothing this test can observe directly — this is the "separate
// mock/spy" its assertions need (see event-service.ts:76-84's own doc
// comment on why `notifyCommitted` never throws).
const notifierOnCaseEvent = vi.fn().mockResolvedValue(undefined);

const caseDocState: { exists: boolean; data: Case | undefined } = {
  exists: false,
  data: undefined,
};

vi.mock('../../lib/firestore.js', () => {
  const findingDoc = (id: string) => ({
    // Mirrors real Firestore's `DocumentReference.id` — the transaction stub
    // below reads this to know which finding a `txn.update(ref, ...)` call
    // targets (the update payload itself never carries the finding id).
    id,
    get: vi.fn().mockResolvedValue({ exists: false }),
    set: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  });
  // Mirrors real Firestore's `DocumentReference.id` — the transaction stub
  // below reads/writes `decisionsStore` keyed on this id, which is what lets
  // the create-only check see a decision a PRIOR call already committed.
  const decisionDoc = (id: string) => ({
    id,
    get: vi.fn(async () => ({
      exists: decisionsStore.has(id),
      data: () => decisionsStore.get(id),
    })),
    set: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  });
  // The REAL `EventRepository.createInTransaction` (unmocked, see below)
  // resolves a ref through here and calls `transaction.set(ref, event)` on
  // current main — issue #1063, racing this fix on the same main, changes
  // that call to `transaction.create(ref, event)`. `kind: 'event'` is what
  // lets the transaction fake below accept EITHER verb for this ref, so this
  // test passes regardless of which of the two PRs merges first.
  const caseEventDoc = (id: string) => ({ id, kind: 'event' as const });
  const findingsCollection = () => ({
    doc: findingDoc,
    // The closer chains two `where` clauses (case_id + status).
    where: () => ({
      where: () => ({
        get: vi.fn(async () => ({ docs: findingsQueryDocs.value })),
      }),
    }),
  });

  // Transaction stub for the read-then-create-only decision write, paired
  // atomically with the finding-status update AND (issue #913) the
  // `decision_created` event staged via `EventService.emitInTransaction`.
  // Mirrors real Firestore semantics: writes are staged locally while the
  // callback runs and only flushed into the shared capture arrays
  // (`decisionsStore` / `writtenDecisions` / `findingUpdates` /
  // `writtenEvents`) if the callback resolves. A throw (e.g. a failing
  // finding's `txn.update`) discards everything staged for that transaction
  // — including the decision `txn.create` AND the event write staged just
  // before it — so all three writes fail together instead of leaving a
  // decision (or an event) orphaned from its finding update. This is what the
  // atomicity assertions in the "closes the remaining findings when one
  // fails" test rely on. `txn.get` reads the same `decisionsStore` the
  // previous call's commit wrote to, which is what makes the
  // two-calls-same-finding tests a faithful simulation of two racing closer
  // runs.
  const runTransaction = async <T>(
    fn: (txn: {
      get: (ref: { id: string }) => Promise<{ exists: boolean; data: () => Decision | undefined }>;
      create: (ref: { id: string; kind?: 'event' }, data: Decision | CaseEvent) => void;
      set: (ref: { id: string; kind?: 'event' }, data: Decision | CaseEvent) => void;
      update: (ref: { id: string }, payload: Record<string, unknown>) => void;
    }) => Promise<T>,
  ): Promise<T> => {
    let stagedDecision: { id: string; data: Decision } | undefined;
    let stagedEvent: { id: string; data: CaseEvent } | undefined;
    const stagedFindingUpdates: Array<{ id: string; payload: Record<string, unknown> }> = [];
    const stageEvent = (ref: { id: string }, data: CaseEvent) => {
      stagedEvent = { id: ref.id, data };
    };
    const result = await fn({
      get: async (ref) => ({
        exists: decisionsStore.has(ref.id),
        data: () => decisionsStore.get(ref.id),
      }),
      create: (ref, data) => {
        if (ref.kind === 'event') {
          stageEvent(ref, data as CaseEvent);
          return;
        }
        if (decisionsStore.has(ref.id)) {
          throw new Error(`ALREADY_EXISTS: decision ${ref.id}`);
        }
        stagedDecision = { id: ref.id, data: data as Decision };
      },
      set: (ref, data) => {
        if (ref.kind !== 'event') {
          throw new Error(`Unexpected txn.set on non-event ref ${ref.id}`);
        }
        stageEvent(ref, data as CaseEvent);
      },
      update: (ref, payload) => {
        if (failingFindingIds.has(ref.id)) {
          throw new Error(`firestore update failed for ${ref.id}`);
        }
        stagedFindingUpdates.push({ id: ref.id, payload });
      },
    });
    // "Commit": only reached when the callback didn't throw. Decision,
    // finding-update, and event are staged together above and flushed
    // together here.
    if (stagedDecision) {
      decisionsStore.set(stagedDecision.id, stagedDecision.data);
      writtenDecisions.value.push(stagedDecision.data);
      callLog.value.push(`decision:${stagedDecision.data.finding_id}`);
    }
    if (stagedEvent) {
      writtenEvents.value.push(stagedEvent.data);
      const findingId = stagedEvent.data.payload['finding_id'] as string;
      emittedEvents.value.push({
        caseId: stagedEvent.data.case_id,
        type: stagedEvent.data.type,
        payload: stagedEvent.data.payload,
        actorId: stagedEvent.data.actor_id,
      });
      callLog.value.push(`event:${findingId}`);
    }
    for (const update of stagedFindingUpdates) {
      findingUpdates.value.push(update);
    }
    return result;
  };

  return {
    getDb: () => ({ runTransaction }),
    collections: {
      findings: findingsCollection,
      decisions: () => ({ doc: decisionDoc }),
      caseEvents: () => ({ doc: caseEventDoc }),
      cases: () => ({
        doc: () => ({
          get: vi.fn(async () => ({
            exists: caseDocState.exists,
            data: () => caseDocState.data,
          })),
        }),
      }),
    },
  };
});

// `EventService`/`EventRepository` are deliberately NOT mocked (issue #913):
// `emitInTransaction` must really stage its write through the transaction
// fake above for the atomicity test to prove anything. `EventNotifier` is the
// actual I/O boundary (Firestore reads for recipients, Chat/webhook calls)
// and stays stubbed here, same as it would be behind a real Firestore in
// production integration tests.
vi.mock('../notification/event-notifier.js', () => ({
  EventNotifier: vi.fn(() => ({ onCaseEvent: notifierOnCaseEvent })),
}));

// The snapshot builder does its own Firestore reads; stub it so the unit test
// stays off the policy/rule-set path (its behaviour is covered by
// completeness-evaluator tests).
const snapshotBuild = vi.fn(async () => ({
  active_rule_set_versions: { rs_1: 3 },
  evidence_policy_id: 'ep_1',
  evidence_policy_version: 2,
  knowledge_asset_refs: [],
  snapshot_fidelity: 'exact' as const,
}));

vi.mock('../evidence/completeness-evaluator.js', () => ({
  buildDecisionSnapshot: (...args: unknown[]) => snapshotBuild(...(args as [])),
  CompletenessEvaluator: vi.fn(() => ({})),
}));

vi.mock('../rule/rule-repository.js', () => ({
  RuleRepository: vi.fn(() => ({})),
}));

import {
  closeOutstandingWaiverProposalsOnCompletion,
  waiverCompletionDecisionId,
} from './waiver-completion.js';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: 'fnd_1',
    case_id: 'case_1',
    category: 'bug',
    severity: 'medium',
    confidence: 0.8,
    status: 'waiver_proposed',
    title: 'Finding',
    description: 'desc',
    origin_type: 'reviewer',
    source_refs: [],
    evidence_refs: [],
    rule_refs: [],
    resolution: 'agent rationale: false positive, verified against production usage',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function seedFindings(findings: Finding[]) {
  findingsQueryDocs.value = findings.map((f) => ({ data: () => f }));
}

function makeCase(): Case {
  return {
    case_id: 'case_1', title: 'Test', description: '', source_type: 'manual',
    source_ref: '', project_id: 'p1', repository_id: 'r1', owner_user_id: 'usr_owner',
    status: 'done', validation_track: 'direct', risk_level: 'medium',
    priority: 'normal', active_rule_set_refs: [], knowledge_context_refs: [],
    decision_ready: true, created_at: '', updated_at: '',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findingsQueryDocs.value = [];
  writtenDecisions.value = [];
  findingUpdates.value = [];
  writtenEvents.value = [];
  emittedEvents.value = [];
  callLog.value = [];
  failingFindingIds.clear();
  decisionsStore.clear();
  caseDocState.exists = true;
  caseDocState.data = makeCase();
  snapshotBuild.mockResolvedValue({
    active_rule_set_versions: { rs_1: 3 },
    evidence_policy_id: 'ep_1',
    evidence_policy_version: 2,
    knowledge_asset_refs: [],
    snapshot_fidelity: 'exact' as const,
  });
});

describe('closeOutstandingWaiverProposalsOnCompletion', () => {
  it('writes a waived_on_completion decision per outstanding proposal', async () => {
    seedFindings([
      makeFinding({ finding_id: 'fnd_a' }),
      makeFinding({ finding_id: 'fnd_b', severity: 'high' }),
    ]);

    const result = await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');

    expect(result.closed).toBe(2);
    expect(writtenDecisions.value).toHaveLength(2);
    for (const decision of writtenDecisions.value) {
      expect(decision.type).toBe('waived_on_completion');
      expect(decision.actor_id).toBe('system:pipeline');
      expect(decision.case_id).toBe('case_1');
      expect(decision.rationale.length).toBeGreaterThan(0);
      expect(decision.snapshot).toBeDefined();
    }
    expect(writtenDecisions.value.map((d) => d.finding_id)).toEqual(['fnd_a', 'fnd_b']);
  });

  it('flips the finding status without touching the agent resolution', async () => {
    seedFindings([makeFinding({ finding_id: 'fnd_a' })]);

    await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');

    expect(findingUpdates.value).toHaveLength(1);
    const update = findingUpdates.value[0]!;
    expect(update.id).toBe('fnd_a');
    expect(update.payload.status).toBe('waived_on_completion');
    expect(update.payload.updated_at).toBeTruthy();
    // The agent's original proposal rationale must survive — it is the only
    // record of WHY the waiver was proposed.
    expect(update.payload).not.toHaveProperty('resolution');
  });

  it('emits a decision_created event per closed finding', async () => {
    seedFindings([makeFinding({ finding_id: 'fnd_a' })]);

    await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');

    expect(emittedEvents.value).toHaveLength(1);
    const event = emittedEvents.value[0]!;
    expect(event.type).toBe('decision_created');
    expect(event.caseId).toBe('case_1');
    expect(event.actorId).toBe('system:pipeline');
    expect(event.payload).toMatchObject({
      type: 'waived_on_completion',
      finding_id: 'fnd_a',
      decision_id: writtenDecisions.value[0]!.decision_id,
    });
  });

  it('records a distinct backfill rationale for the cleanup script', async () => {
    // Distinct finding ids: since the decision id is now deterministic per
    // finding (issue #754), reusing 'fnd_a' for both calls would make the
    // second one a same-finding replay (skipped, no new decision) rather
    // than the two independent decisions this test means to compare.
    seedFindings([makeFinding({ finding_id: 'fnd_a' })]);
    await closeOutstandingWaiverProposalsOnCompletion('case_1', 'backfill');
    const backfillRationale = writtenDecisions.value[0]!.rationale;

    writtenDecisions.value = [];
    seedFindings([makeFinding({ finding_id: 'fnd_b' })]);
    await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');
    const completionRationale = writtenDecisions.value[0]!.rationale;

    expect(backfillRationale).not.toBe(completionRationale);
    expect(backfillRationale).toMatch(/retroactively/i);
  });

  it('writes nothing for a case without outstanding proposals', async () => {
    seedFindings([]);

    const result = await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');

    expect(result.closed).toBe(0);
    expect(writtenDecisions.value).toHaveLength(0);
    expect(findingUpdates.value).toHaveLength(0);
    expect(emittedEvents.value).toHaveLength(0);
    // No snapshot read either — the early return happens before that work.
    expect(snapshotBuild).not.toHaveBeenCalled();
  });

  it('closes the remaining findings when one fails, and still resolves', async () => {
    seedFindings([
      makeFinding({ finding_id: 'fnd_a' }),
      makeFinding({ finding_id: 'fnd_boom' }),
      makeFinding({ finding_id: 'fnd_c' }),
    ]);
    // fnd_boom's failure happens INSIDE the transaction (txn.update throws —
    // see the `runTransaction` stub above), not as an independent write.
    failingFindingIds.add('fnd_boom');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');

    expect(result.closed).toBe(2);
    expect(findingUpdates.value.map((u) => u.id)).toEqual(['fnd_a', 'fnd_c']);
    expect(emittedEvents.value.map((e) => e.payload.finding_id)).toEqual(['fnd_a', 'fnd_c']);
    expect(consoleError).toHaveBeenCalled();

    // Atomicity (issue #913): fnd_boom's decision-create, finding-update, AND
    // its `decision_created` event are staged in the SAME transaction, so its
    // failed `txn.update` must discard all three together — no decision or
    // event is left pointing at a finding that never actually left
    // `waiver_proposed`. Before the fix the event was emitted in its own
    // try/catch AFTER the transaction committed, so this finding's event
    // could never have existed in the first place; after the fix it is
    // staged INSIDE the same transaction as the decision, so proving
    // atomicity means proving the failed transaction discarded it too, not
    // asserting an ordering between two independent writes (the previous
    // version of this test asserted "decision fires before event", which is
    // exactly the premise the fix inverts — the event no longer fires
    // separately at all).
    expect(writtenDecisions.value.map((d) => d.finding_id)).toEqual(['fnd_a', 'fnd_c']);
    expect(writtenEvents.value.map((e) => e.payload['finding_id'])).toEqual(['fnd_a', 'fnd_c']);
    expect(emittedEvents.value.map((e) => e.payload['finding_id'])).toEqual(['fnd_a', 'fnd_c']);

    // Both the decision and the event for a given finding land in the same
    // commit — same finding id, same relative position — because one
    // `runTransaction` call stages both.
    expect(callLog.value).toEqual(['decision:fnd_a', 'event:fnd_a', 'decision:fnd_c', 'event:fnd_c']);
    // fnd_boom's failed transaction never committed, so NEITHER of its
    // staged writes ever appears in the commit log at all — this is the
    // discard-together guarantee the fix relies on.
    expect(callLog.value).not.toContain('decision:fnd_boom');
    expect(callLog.value).not.toContain('event:fnd_boom');

    // The notifier only fires for the transactions that actually committed —
    // `notifyCommitted` is called once per closed finding, after its own
    // transaction resolved, and never for fnd_boom's discarded one.
    expect(notifierOnCaseEvent).toHaveBeenCalledTimes(2);
    const notifiedFindingIds = notifierOnCaseEvent.mock.calls.map(
      (call) => (call[2] as Record<string, unknown>)['finding_id'],
    );
    expect(notifiedFindingIds).toEqual(['fnd_a', 'fnd_c']);

    consoleError.mockRestore();
  });

  it('still closes outstanding waiver proposals when the case status is rejected (issue #752)', async () => {
    // This is the system-internal completion path from issue #751: it writes
    // the decision + finding update directly via `collections.decisions()` /
    // a Firestore transaction and never calls `DecisionService.createDecision`.
    // The client-submitted-decision guard added there for #752 has no import
    // of, and no call path into, this module, so a terminal case status
    // (`rejected`, not previously exercised by this suite — the other cases
    // above default to `done`) must not change this function's behavior.
    caseDocState.data = { ...makeCase(), status: 'rejected' };
    seedFindings([makeFinding({ finding_id: 'fnd_a' })]);

    const result = await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');

    expect(result.closed).toBe(1);
    expect(writtenDecisions.value).toHaveLength(1);
    expect(writtenDecisions.value[0]!.type).toBe('waived_on_completion');
    expect(writtenDecisions.value[0]!.actor_id).toBe('system:pipeline');
    expect(findingUpdates.value[0]).toMatchObject({ id: 'fnd_a', payload: { status: 'waived_on_completion' } });
  });

  it('falls back to a legacy-fidelity snapshot when the snapshot build fails', async () => {
    seedFindings([makeFinding({ finding_id: 'fnd_a' })]);
    snapshotBuild.mockRejectedValueOnce(new Error('policy read failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');

    expect(result.closed).toBe(1);
    // Missing `snapshot_fidelity` is the honest marker — the UI renders it as
    // "snapshot unavailable (legacy)" rather than a fabricated exact capture.
    expect(writtenDecisions.value[0]!.snapshot.snapshot_fidelity).toBeUndefined();
    consoleError.mockRestore();
  });

  describe('idempotency across a racing double-run (issue #754)', () => {
    // Two calls with the SAME seeded pending finding simulate a concurrent
    // double-transition into `done`: both runs' initial query would observe
    // the finding still `waiver_proposed` before either has written, exactly
    // as the closer's own query-then-write race is described in #754.

    it('produces exactly one decision for the finding, with the deterministic id, across both runs', async () => {
      // Fails if the leading `txn.get(decisionRef)` existence check in
      // closeOutstandingWaiverProposalsOnCompletion is removed (reverting to
      // an unconditional `txn.set`/`txn.create`) — the second run would then
      // write a SECOND decision for `fnd_a` instead of skipping.
      seedFindings([makeFinding({ finding_id: 'fnd_a' })]);
      const first = await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');

      seedFindings([makeFinding({ finding_id: 'fnd_a' })]);
      const second = await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');

      expect(first.closed).toBe(1);
      expect(first.skipped).toBe(0);
      expect(second.closed).toBe(0);
      expect(second.skipped).toBe(1);

      expect(writtenDecisions.value).toHaveLength(1);
      expect(writtenDecisions.value[0]!.decision_id).toBe(waiverCompletionDecisionId('fnd_a'));
      expect(writtenDecisions.value[0]!.finding_id).toBe('fnd_a');
      // The skip path touches neither write — only one finding-status update
      // landed across both runs.
      expect(findingUpdates.value).toHaveLength(1);
    });

    it('does not emit a second decision_created event on the skipped run', async () => {
      // Fails if the event emit is moved outside the `if (!wasCreated) { ...
      // continue; }` guard (i.e. it always runs regardless of whether this
      // run actually created the decision) — the second run would then emit
      // a duplicate decision_created event for the same decision id.
      seedFindings([makeFinding({ finding_id: 'fnd_a' })]);
      await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');

      seedFindings([makeFinding({ finding_id: 'fnd_a' })]);
      await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');

      expect(emittedEvents.value).toHaveLength(1);
      expect(emittedEvents.value[0]).toMatchObject({
        type: 'decision_created',
        payload: { finding_id: 'fnd_a', decision_id: waiverCompletionDecisionId('fnd_a') },
      });
    });

    it('does not notify on the skipped run either (issue #913)', async () => {
      // The skip path returns `undefined` from the transaction (no event was
      // staged, because `emitInTransaction` was never called for it) — this
      // fails if `notifyCommitted` were ever called unconditionally instead
      // of only on the `committedEvent` branch.
      seedFindings([makeFinding({ finding_id: 'fnd_a' })]);
      await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');
      expect(notifierOnCaseEvent).toHaveBeenCalledTimes(1);

      seedFindings([makeFinding({ finding_id: 'fnd_a' })]);
      await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');

      // Still exactly one notification total: the second (skipped) run never
      // staged a new event, so it has nothing to hand to `notifyCommitted`.
      expect(notifierOnCaseEvent).toHaveBeenCalledTimes(1);
    });

    it('skips only the already-closed finding, still closing a newly-outstanding one in the same run', async () => {
      // Fails if the create-only check is applied per-call instead of
      // per-finding (e.g. bailing out of the whole loop on the first skip) —
      // `fnd_new` would then never get closed in the second run.
      seedFindings([makeFinding({ finding_id: 'fnd_a' })]);
      await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');

      seedFindings([
        makeFinding({ finding_id: 'fnd_a' }),
        makeFinding({ finding_id: 'fnd_new' }),
      ]);
      const second = await closeOutstandingWaiverProposalsOnCompletion('case_1', 'completion');

      expect(second.closed).toBe(1);
      expect(second.skipped).toBe(1);
      expect(writtenDecisions.value.map((d) => d.finding_id).sort()).toEqual(['fnd_a', 'fnd_new']);
    });
  });
});

describe('waiverCompletionDecisionId', () => {
  it('derives a stable dec_-prefixed id from the finding id alone (issue #754)', () => {
    // Fails if the closer reverts to `generateId('decision')` (a random
    // nanoid) for the decision id — two calls with the same finding id would
    // then produce DIFFERENT ids instead of matching, breaking create-only
    // idempotency.
    const idA = waiverCompletionDecisionId('fnd_a');
    const idB = waiverCompletionDecisionId('fnd_a');
    const idC = waiverCompletionDecisionId('fnd_b');

    expect(idA).toBe(idB);
    expect(idA).not.toBe(idC);
    expect(idA).toMatch(/^dec_[0-9a-f]{32}$/);
  });
});
