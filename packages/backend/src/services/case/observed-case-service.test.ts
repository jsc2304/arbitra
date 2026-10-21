import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Case, Repository } from '@arbitra/shared';

/**
 * Tests `ensureObservedCaseForSignal` (issue #986) at the service seam:
 * repository resolution, the (repository, branch) → case fast path
 * (`resolveCaseByBranch`, already covered by branch-resolution.test.ts), and
 * the atomic claim that makes concurrent/duplicate signal delivery for an
 * unknown branch produce exactly one Observed Case.
 *
 * The Firestore double follows the same discipline as
 * `session-signal-service.test.ts`: `tx.create` throws (and stages nothing)
 * when the target doc already exists, which is what turns the claim into an
 * atomic dedupe instead of a check-then-insert race.
 */

type DocData = Record<string, unknown>;

const { store, fakeDb, collections } = vi.hoisted(() => {
  type DocData = Record<string, unknown>;
  const store = new Map<string, Map<string, DocData>>();

  function collectionStore(name: string): Map<string, DocData> {
    let existing = store.get(name);
    if (!existing) {
      existing = new Map();
      store.set(name, existing);
    }
    return existing;
  }

  class FakeDocRef {
    constructor(
      readonly collectionName: string,
      readonly id: string,
    ) {}

    async get() {
      const data = collectionStore(this.collectionName).get(this.id);
      return { id: this.id, exists: data !== undefined, data: () => data };
    }
  }

  interface Filter {
    field: string;
    value: unknown;
  }

  class FakeQuery {
    constructor(
      protected readonly collectionName: string,
      protected readonly filters: Filter[] = [],
    ) {}

    where(field: string, _op: string, value: unknown): FakeQuery {
      return new FakeQuery(this.collectionName, [...this.filters, { field, value }]);
    }

    async get() {
      const docs = [...collectionStore(this.collectionName).values()].filter((doc) =>
        this.filters.every(({ field, value }) => doc[field] === value),
      );
      return { docs: docs.map((data) => ({ data: () => data })) };
    }
  }

  class FakeCollection extends FakeQuery {
    doc(id: string): FakeDocRef {
      return new FakeDocRef(this.collectionName, id);
    }
  }

  type StagedWrite = { ref: FakeDocRef; data: DocData };

  const fakeDb = {
    // Real Firestore transactions auto-retry the callback on a write
    // conflict (a concurrent transaction committed a doc this one staged a
    // `create` for, in between this one's reads and its commit) — callers
    // never see that as a thrown error. Mirrored here with a bounded retry
    // loop so `Promise.all([...])` races over the SAME claim doc resolve
    // exactly like production: one winner commits, the other's callback
    // re-runs, re-reads the now-existing claim, and returns its `null`
    // no-op branch instead of retrying a doomed `create`.
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      for (let attempt = 0; attempt < 10; attempt++) {
        const writes: StagedWrite[] = [];
        const tx = {
          get: async (ref: FakeDocRef) => ref.get(),
          create: (ref: FakeDocRef, data: DocData) => {
            writes.push({ ref, data });
          },
        };
        const result = await fn(tx);

        const conflict = writes.some((write) =>
          collectionStore(write.ref.collectionName).has(write.ref.id),
        );
        if (conflict) continue; // retry: re-run fn against the now-committed state

        for (const write of writes) {
          collectionStore(write.ref.collectionName).set(write.ref.id, write.data);
        }
        return result;
      }
      throw new Error('runTransaction: exceeded retry budget');
    },
  };

  const collections = {
    cases: () => new FakeCollection('cases'),
    caseEvents: () => new FakeCollection('case_events'),
    observedCaseClaims: () => new FakeCollection('observed_case_claims'),
  };

  return { store, fakeDb, collections };
});

function collectionStore(name: string): Map<string, DocData> {
  let existing = store.get(name);
  if (!existing) {
    existing = new Map();
    store.set(name, existing);
  }
  return existing;
}

vi.mock('../../lib/firestore.js', () => ({
  getDb: () => fakeDb,
  collections,
}));

let idCounter = 0;
vi.mock('../../lib/ids.js', () => ({
  generateId: (prefix: string) => `${prefix}_${++idCounter}`,
}));

// Repository resolution: stubbed independently of the real webhook-service
// Firestore matching logic (covered by webhook-service.repo-match.test.ts) —
// this suite only needs to control what it returns.
const { resolveRepositoryForSignal } = vi.hoisted(() => ({
  resolveRepositoryForSignal: vi.fn<(repository: string) => Promise<Repository | null>>(),
}));
vi.mock('../webhook/webhook-service.js', () => ({
  WebhookService: class {
    resolveRepositoryForSignal = resolveRepositoryForSignal;
  },
}));

// Pipeline dispatch after a successful create: stubbed so this suite doesn't
// have to model the full precondition/Firestore surface RunCompletionHandler
// needs — that machinery (and the `open → in_build` transition itself) is
// covered by status-transitions.test.ts (matrix) and
// webhook-service.observed-case.test.ts (end-to-end via a real
// RunCompletionHandler + in-memory PipelineAdapter).
//
// The stub advances a case it finds at `open` to `in_build` in the fake
// store, mirroring what the real transition does — this is what lets
// `repairStuckObservedCase`'s "already repaired, no-op" branch (issue #996)
// behave the same way here as it does in production, instead of re-firing
// on every subsequent call for a case this suite never actually parks at
// `open` on purpose.
const { onRunCompleted } = vi.hoisted(() => ({
  onRunCompleted: vi.fn(async (caseId: string) => {
    const data = collectionStore('cases').get(caseId);
    if (data && data.status === 'open') {
      collectionStore('cases').set(caseId, { ...data, status: 'in_build' });
    }
  }),
}));
vi.mock('../orchestration/pipeline.js', () => ({
  RunCompletionHandler: class {
    onRunCompleted = onRunCompleted;
  },
}));
vi.mock('../orchestration/firestore-pipeline-adapter.js', () => ({
  FirestorePipelineAdapter: class {},
}));

import {
  ensureObservedCaseForSignal,
  observedCaseClaimDocId,
  repairStuckObservedCase,
} from './observed-case-service.js';

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    repository_id: 'repo_1',
    project_id: 'proj_1',
    name: 'acme/widgets',
    url: 'https://github.com/acme/widgets',
    provider: 'github',
    ...overrides,
  };
}

beforeEach(() => {
  store.clear();
  idCounter = 0;
  resolveRepositoryForSignal.mockReset();
  onRunCompleted.mockClear();
  resolveRepositoryForSignal.mockResolvedValue(makeRepo());
});

describe('ensureObservedCaseForSignal', () => {
  it('creates exactly one Observed Case, bound to the branch, for an unknown branch', async () => {
    const result = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'feat/foo' });

    expect(result).not.toBeNull();
    expect(result?.case_type).toBe('observed');
    expect(result?.current_branch).toBe('feat/foo');
    expect(result?.repository_id).toBe('repo_1');
    expect(result?.status).toBe('open');
    expect(collectionStore('cases').size).toBe(1);
    expect(onRunCompleted).toHaveBeenCalledTimes(1);
    expect(onRunCompleted).toHaveBeenCalledWith(result?.case_id);
  });

  it('attaches a subsequent signal for the same branch to the same case, without creating a second one', async () => {
    // Reverting the `resolveCaseByBranch` fast-path check (always falling
    // through to the claim transaction) would still be deduped by the claim
    // itself, but would call `onRunCompleted` a second time — this
    // assertion on the call count would then fail too.
    const first = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'feat/foo' });
    const second = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'feat/foo' });

    expect(second?.case_id).toBe(first?.case_id);
    expect(collectionStore('cases').size).toBe(1);
    expect(onRunCompleted).toHaveBeenCalledTimes(1);
  });

  it('produces exactly one case under concurrent delivery for the same unknown branch', async () => {
    // Reverting the transactional `tx.create` claim (e.g. to a
    // check-then-insert `get` + `create`) would let both concurrent calls
    // observe "no claim yet" and each create their own case, failing the
    // `cases` size assertion below.
    const [a, b] = await Promise.all([
      ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'feat/race' }),
      ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'feat/race' }),
    ]);

    expect(collectionStore('cases').size).toBe(1);
    expect(a?.case_id).toBe(b?.case_id);
  });

  // Issue #996 (F4 follow-up): the lost-race re-resolve must route through
  // repair too — not just the pre-existing `existing`-case fast path — since
  // the WINNER's own post-commit transition is exactly the one that can have
  // died, and simply handing the loser the winner's (still-stuck) case wastes
  // this touch's repair opportunity.
  it('repairs a stuck-open case reached via the lost-race re-resolve path', async () => {
    // Whichever of the two concurrent calls is first to invoke
    // `onRunCompleted` (the winner's own post-create trigger) simulates the
    // exact #996 failure window: the transition call itself throws, so the
    // claim/case commit that already landed is left at `open`.
    onRunCompleted.mockImplementationOnce(async () => {
      throw new Error('simulated post-commit failure on the winning call');
    });

    const [a, b] = await Promise.all([
      ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'feat/race-repair' }),
      ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'feat/race-repair' }),
    ]);

    expect(collectionStore('cases').size).toBe(1);
    expect(a?.case_id).toBe(b?.case_id);

    // Without routing the lost-race path through `repairStuckObservedCase`,
    // the loser hands back the winner's case exactly as re-resolved — still
    // `open`, forever, since nothing else ever retries the transition. With
    // the fix, the loser's repair attempt (the second `onRunCompleted` call,
    // not the mocked-to-throw first one) succeeds and the case reaches
    // `in_build`.
    const stored = collectionStore('cases').get(a!.case_id) as unknown as Case;
    expect(stored.status).toBe('in_build');
    expect(onRunCompleted).toHaveBeenCalledTimes(2);
  });

  it('creates independent cases for different branches in the same repository', async () => {
    const a = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'feat/a' });
    const b = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'feat/b' });

    expect(a?.case_id).not.toBe(b?.case_id);
    expect(collectionStore('cases').size).toBe(2);
  });

  it('resolves to an existing non-terminal case already bound to the branch instead of creating one', async () => {
    const existing: Case = {
      case_id: 'case_existing',
      title: 'Manual case',
      description: '',
      source_type: 'manual',
      source_ref: '',
      project_id: 'proj_1',
      repository_id: 'repo_1',
      owner_user_id: 'usr_1',
      status: 'in_build',
      validation_track: 'direct',
      risk_level: 'low',
      priority: 'normal',
      current_branch: 'feat/manual',
      active_rule_set_refs: [],
      knowledge_context_refs: [],
      jira_refs: [],
      decision_ready: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    collectionStore('cases').set('case_existing', existing as unknown as DocData);

    const result = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'feat/manual' });

    expect(result?.case_id).toBe('case_existing');
    expect(collectionStore('cases').size).toBe(1);
    expect(onRunCompleted).not.toHaveBeenCalled();
  });

  it('processes the signal but creates no case when the repository cannot be resolved', async () => {
    // Reverting the `if (!repo) return null;` early return (falling through
    // to the claim transaction with an undefined repository_id) would throw
    // or create a malformed case instead of returning null cleanly.
    resolveRepositoryForSignal.mockResolvedValue(null);

    const result = await ensureObservedCaseForSignal({ repository: 'unknown/repo', branch: 'feat/foo' });

    expect(result).toBeNull();
    expect(collectionStore('cases').size).toBe(0);
  });

  it('claim doc id is deterministic for the same (repository, branch) pair', () => {
    expect(observedCaseClaimDocId('repo_1', 'feat/foo')).toBe(observedCaseClaimDocId('repo_1', 'feat/foo'));
    expect(observedCaseClaimDocId('repo_1', 'feat/foo')).not.toBe(observedCaseClaimDocId('repo_1', 'feat/bar'));
  });

  // Issue #1013: the signal hook's own branch fallbacks (`resolveGitContext`
  // in packages/mcp/src/hooks/session-signal-hook.ts) must never grow a Case —
  // this is what produced a junk "Observed: unknown" case. Reverting
  // `isUnresolvableSignalBranch`'s guard in `ensureObservedCaseForSignal` (or
  // narrowing it to only `branch === ''`) makes each of the next three tests
  // fail: the repo resolver mock would be called and a case would be created.
  it('creates no case and does not attempt repository resolution for branch "unknown"', async () => {
    const result = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'unknown' });

    expect(result).toBeNull();
    expect(collectionStore('cases').size).toBe(0);
    expect(resolveRepositoryForSignal).not.toHaveBeenCalled();
  });

  it('creates no case for a detached-HEAD branch ref', async () => {
    const result = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'detached:abc1234' });

    expect(result).toBeNull();
    expect(collectionStore('cases').size).toBe(0);
    expect(resolveRepositoryForSignal).not.toHaveBeenCalled();
  });

  it('creates no case for an empty branch', async () => {
    const result = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: '' });

    expect(result).toBeNull();
    expect(collectionStore('cases').size).toBe(0);
    expect(resolveRepositoryForSignal).not.toHaveBeenCalled();
  });

  // Issue #1009: sessions on the repository's default branch never grow an
  // eternal Observed Case (PRs merge INTO it, never FROM it, so
  // auto-close-on-merge can never fire for one bound to it).
  describe('default branch exclusion (#1009)', () => {
    it('creates no case for the default branch, but keeps creating one for a feature branch', async () => {
      const main = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'main' });
      const feature = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'feat/foo' });

      expect(main).toBeNull();
      expect(feature).not.toBeNull();
      expect(feature?.case_type).toBe('observed');
      expect(collectionStore('cases').size).toBe(1);
    });

    it('creates no case for "master" either', async () => {
      const result = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'master' });

      expect(result).toBeNull();
      expect(collectionStore('cases').size).toBe(0);
    });

    it('never attempts the claim transaction for the default branch', async () => {
      await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'main' });

      expect(collectionStore('observed_case_claims').size).toBe(0);
    });

    it('still resolves to an existing non-observed (human-created) case bound to the default branch', async () => {
      const manualCase: Case = {
        case_id: 'case_manual_main',
        title: 'Track main branch health',
        description: '',
        source_type: 'manual',
        source_ref: '',
        project_id: 'proj_1',
        repository_id: 'repo_1',
        owner_user_id: 'usr_1',
        status: 'in_build',
        validation_track: 'direct',
        risk_level: 'low',
        priority: 'normal',
        current_branch: 'main',
        active_rule_set_refs: [],
        knowledge_context_refs: [],
        jira_refs: [],
        decision_ready: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };
      collectionStore('cases').set('case_manual_main', manualCase as unknown as DocData);

      const result = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'main' });

      expect(result?.case_id).toBe('case_manual_main');
    });

    it('stops attaching further signals to a pre-existing eternal Observed Case on the default branch', async () => {
      // Simulates a case from before this
      // fix: an Observed Case already bound to `main`, stuck non-terminal.
      // A later signal must not resolve to it (letting it keep "working")
      // nor create a second one — it should simply stop growing.
      const stuck: Case = {
        case_id: 'case_stuck_main',
        title: 'Observed: main',
        description: '',
        source_type: 'git',
        source_ref: 'main',
        project_id: 'proj_1',
        repository_id: 'repo_1',
        owner_user_id: 'system:observed-case',
        status: 'in_build',
        validation_track: 'direct',
        risk_level: 'low',
        priority: 'normal',
        case_type: 'observed',
        current_branch: 'main',
        active_rule_set_refs: [],
        knowledge_context_refs: [],
        jira_refs: [],
        decision_ready: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };
      collectionStore('cases').set('case_stuck_main', stuck as unknown as DocData);

      const result = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'main' });

      expect(result).toBeNull();
      expect(collectionStore('cases').size).toBe(1); // no second case created
      expect(onRunCompleted).not.toHaveBeenCalled();
    });
  });

  // Issue #1009 follow-up: prefer the repo's real, webhook-backfilled
  // `default_branch` over the name heuristic once it is known.
  describe('repository-aware default branch (#1009 follow-up)', () => {
    it('creates no case for the repo\'s real default branch even when it has an unconventional name', async () => {
      resolveRepositoryForSignal.mockResolvedValue(makeRepo({ default_branch: 'trunk' }));

      const result = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'trunk' });

      expect(result).toBeNull();
      expect(collectionStore('cases').size).toBe(0);
    });

    it('creates a case for a feature branch literally named "master" once the repo\'s real default branch ("main") is known', async () => {
      resolveRepositoryForSignal.mockResolvedValue(makeRepo({ default_branch: 'main' }));

      const result = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'master' });

      expect(result).not.toBeNull();
      expect(result?.case_type).toBe('observed');
      expect(result?.current_branch).toBe('master');
    });

    it('falls back to the name heuristic when the repo has no stored default_branch yet', async () => {
      resolveRepositoryForSignal.mockResolvedValue(makeRepo()); // no default_branch

      const result = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'master' });

      expect(result).toBeNull(); // heuristic still catches 'master'
    });
  });

  // Issue #996: an Observed Case whose post-commit `open → in_build`
  // transition never landed (process died, or the transition call itself
  // threw, between the claim commit and that step) must recover the next
  // time anything touches it, instead of sitting at `open` forever.
  describe('repairStuckObservedCase (#996)', () => {
    function makeObservedCase(overrides: Partial<Case> = {}): Case {
      return {
        case_id: 'case_repair',
        title: 'Observed: feat/stuck',
        description: '',
        source_type: 'git',
        source_ref: 'feat/stuck',
        project_id: 'proj_1',
        repository_id: 'repo_1',
        owner_user_id: 'system:observed-case',
        status: 'open',
        validation_track: 'direct',
        risk_level: 'low',
        priority: 'normal',
        case_type: 'observed',
        current_branch: 'feat/stuck',
        active_rule_set_refs: [],
        knowledge_context_refs: [],
        jira_refs: [],
        decision_ready: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        ...overrides,
      } as Case;
    }

    it('re-drives the open → in_build transition for a case stuck at open', async () => {
      const stuck = makeObservedCase();
      collectionStore('cases').set(stuck.case_id, stuck as unknown as DocData);

      const repaired = await repairStuckObservedCase(stuck);

      expect(onRunCompleted).toHaveBeenCalledWith(stuck.case_id);
      expect(repaired.status).toBe('in_build');
    });

    it('recovers even when the post-commit transition call throws (the exact failure window #996 targets)', async () => {
      const stuck = makeObservedCase();
      collectionStore('cases').set(stuck.case_id, stuck as unknown as DocData);

      // Simulate the process dying / the transition call itself failing right
      // after the claim transaction committed — the case is left at `open`
      // in the store, exactly like the real failure this repairs.
      onRunCompleted.mockImplementationOnce(async () => {
        throw new Error('simulated post-commit failure (process died mid-transition)');
      });

      const repaired = await repairStuckObservedCase(stuck);

      // The repair call swallows the error (logged, never thrown) — the case
      // is still `open` after a failed attempt, exactly the "not yet
      // recovered" state a later touch must retry against.
      expect(repaired.status).toBe('open');

      // The NEXT touch (e.g. the next signal, or a PR merge webhook) retries
      // and this time succeeds, reaching `in_build` — proving recovery.
      const secondAttempt = await repairStuckObservedCase(repaired);
      expect(secondAttempt.status).toBe('in_build');
    });

    it('is a no-op for a case already past open', async () => {
      const inBuild = makeObservedCase({ status: 'in_build' });
      collectionStore('cases').set(inBuild.case_id, inBuild as unknown as DocData);

      const result = await repairStuckObservedCase(inBuild);

      expect(result).toBe(inBuild);
      expect(onRunCompleted).not.toHaveBeenCalled();
    });

    it('is a no-op for a non-observed case at open', async () => {
      const manual = makeObservedCase({ case_type: undefined, status: 'open' });
      collectionStore('cases').set(manual.case_id, manual as unknown as DocData);

      const result = await repairStuckObservedCase(manual);

      expect(result).toBe(manual);
      expect(onRunCompleted).not.toHaveBeenCalled();
    });

    it('is exercised automatically when a signal touches a case stuck at open', async () => {
      const stuck = makeObservedCase({ case_id: 'case_touch_repair', current_branch: 'feat/touch' });
      collectionStore('cases').set(stuck.case_id, stuck as unknown as DocData);

      const result = await ensureObservedCaseForSignal({ repository: 'acme/widgets', branch: 'feat/touch' });

      expect(result?.case_id).toBe(stuck.case_id);
      expect(result?.status).toBe('in_build');
      expect(onRunCompleted).toHaveBeenCalledWith(stuck.case_id);
    });
  });
});
