/**
 * End-to-end guard for issue #877: a review that only saw a prefix of the
 * change must not be able to auto-approve it.
 *
 * The test drives the real production path — `ReviewService.runReview` →
 * the findings it persists → the real `preconditions.ts` evaluators → the real
 * `StateMachine` against the real transition matrix — because that composition
 * is where the bug lived. Neither `preconditions.ts` nor `status-transitions.ts`
 * is touched by the fix; both are used here exactly as they ship.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case, Finding, Run } from '@arbitra/shared';
import { TransitionError } from '@arbitra/shared';

// ---------------------------------------------------------------------------
// In-memory Firestore double (ReviewService writes; preconditions read only
// what we hand them in the context).
// ---------------------------------------------------------------------------

const stores = {
  runs: new Map<string, Record<string, unknown>>(),
  findings: new Map<string, Record<string, unknown>>(),
  cases: new Map<string, Record<string, unknown>>(),
  rawObs: new Map<string, Record<string, unknown>>(),
  evidence: new Map<string, Record<string, unknown>>(),
};

function docApi(store: Map<string, Record<string, unknown>>, id: string) {
  return {
    set: async (data: Record<string, unknown>) => {
      store.set(id, { ...data });
    },
    update: async (updates: Record<string, unknown>) => {
      store.set(id, { ...(store.get(id) ?? {}), ...updates });
    },
    get: async () => {
      const data = store.get(id);
      return { exists: data !== undefined, data: () => data };
    },
  };
}

function collectionApi(store: Map<string, Record<string, unknown>>) {
  const filters: Array<{ field: string; value: unknown }> = [];
  const api: Record<string, unknown> = {
    where: (field: string, _op: string, value: unknown) => {
      filters.push({ field, value });
      return api;
    },
    get: async () => {
      let rows = Array.from(store.values());
      for (const f of filters) rows = rows.filter((r) => r[f.field] === f.value);
      return { docs: rows.map((r) => ({ data: () => r })), empty: rows.length === 0 };
    },
  };
  api.doc = (id: string) => docApi(store, id);
  return api;
}

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    runs: () => collectionApi(stores.runs),
    findings: () => collectionApi(stores.findings),
    cases: () => collectionApi(stores.cases),
    rawReviewObservations: () => collectionApi(stores.rawObs),
    evidence: () => collectionApi(stores.evidence),
    evidencePolicies: () => collectionApi(new Map()),
  },
  // Minimal transaction fake for `lib/finding-idempotency.ts`'s
  // create-or-reactivate write (issue #739): runs the callback against a
  // `tx` that reads/writes through the same doc API the rest of this double
  // uses, no real optimistic-concurrency semantics needed for this test.
  getDb: () => ({
    runTransaction: async (fn: (tx: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      create: (ref: { set: (data: unknown) => Promise<void> }, data: unknown) => void;
      update: (ref: { update: (data: unknown) => Promise<void> }, data: unknown) => void;
    }) => Promise<unknown>) =>
      fn({
        get: (ref) => ref.get(),
        create: (ref, data) => void ref.set(data),
        update: (ref, data) => void ref.update(data),
      }),
  }),
}));

vi.mock('./verification/finding-verifier.js', () => ({
  verifyFindings: vi.fn(async () => new Map()),
}));

let idCounter = 0;
vi.mock('../../lib/ids.js', () => ({
  generateId: (prefix: string) => `${prefix}_${++idCounter}`,
  deriveFindingId: (signature: string) => `fnd_${signature.slice(0, 32)}`,
}));

vi.mock('../../lib/llm-provider.js', () => ({
  getConsensusConfig: vi.fn(async () => null),
}));

// The fake reviewer finds nothing — an entirely clean review of the prefix.
// That is the dangerous case: without the guard nothing at all stands between
// a half-read pull request and `approved`.
vi.mock('./adapters/adapter-registry.js', () => ({
  getAllAdapters: () => [{ name: 'fake-adapter', review: async () => ({ observations: [] }) }],
  buildConsensusAdapters: () => [],
}));

vi.mock('../diff/submodule-detection.js', () => ({
  detectSubmodulePaths: () => new Set<string>(),
  isPathInSubmodule: () => false,
}));
vi.mock('../diff/vendored-detection.js', () => ({
  detectVendoredPaths: () => new Set<string>(),
  isPathInVendored: () => false,
}));
vi.mock('../orchestration/pipeline.js', () => ({
  RunCompletionHandler: class {
    handleRunFailure = async () => {};
    onRunCompleted = async () => ({});
  },
}));

import { ReviewService } from './review-service.js';
import { createPreconditionEvaluator } from '../orchestration/preconditions.js';
import { StateMachine } from '../orchestration/state-machine.js';
import type { KnowledgeRepository } from '../knowledge/knowledge-repository.js';

const knowledgeRepo = {
  listForReviewScope: async () => [],
  patch: async () => {},
} as unknown as KnowledgeRepository;

const eventStub = { emit: vi.fn(async () => ({})) } as unknown as ConstructorParameters<
  typeof ReviewService
>[0];

// Every review in this file reviewed the case's current commit (issue
// #1054) — that's not what this test file is about, so it's held fixed
// rather than exercised. `preconditions.test.ts` covers a MISMATCHED
// commit; this file stays focused on diff-truncation gating.
const REVIEWED_HEAD_SHA = 'sha_reviewed_head';

function makeCase(): Case {
  return {
    case_id: 'case_1',
    title: 'Large refactor',
    description: '',
    status: 'in_review',
    // Not high/critical: a high-risk case is blocked from auto-approve by an
    // unrelated clause, which would mask what this test is checking.
    risk_level: 'medium',
    priority: 'normal',
    validation_track: 'direct',
    project_id: 'p1',
    repository_id: 'acme/widgets',
    current_head_sha: REVIEWED_HEAD_SHA,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as Case;
}

/** Run a review, then evaluate the real gates against what it produced. */
async function reviewAndEvaluate(diffMeta: { truncated: boolean; lineCount: number }) {
  const service = new ReviewService(eventStub, undefined, knowledgeRepo);
  const case_ = makeCase();
  const { run } = await service.runReview(
    case_, 'diff text', 'system:pipeline', null, undefined, 1,
    { ...diffMeta, reviewedHeadSha: REVIEWED_HEAD_SHA },
  );

  const findings = Array.from(stores.findings.values()) as unknown as Finding[];
  const persistedRun = { ...(stores.runs.get(run.run_id) as unknown as Run) };

  const evaluator = createPreconditionEvaluator({
    case_,
    runs: [persistedRun],
    findings,
    ruleResults: [],
    evidence: [],
    decisions: [],
    events: [],
    actorId: 'system:pipeline',
  });

  return { findings, evaluator, machine: new StateMachine() };
}

describe('truncated diff cannot auto-approve (#877)', () => {
  beforeEach(() => {
    for (const store of Object.values(stores)) store.clear();
    idCounter = 0;
    process.env.ARBITRA_REVIEW_VERIFICATION = 'false';
  });

  it('blocks in_review → approved and routes to needs_human_decision', async () => {
    const { findings, evaluator, machine } = await reviewAndEvaluate({
      truncated: true,
      lineCount: 12_500,
    });

    expect(findings.map((f) => f.category)).toEqual(['diff_exceeds_limit']);

    // The auto-approve edge is closed …
    await expect(
      machine.validateTransition('in_review', 'approved', evaluator),
    ).rejects.toBeInstanceOf(TransitionError);
    expect(await evaluator.evaluate('auto_approve_criteria_met')).toMatchObject({
      satisfied: false,
    });

    // … and the case is not parked: the review run completed, so the
    // escalation edge into human review is open.
    expect(await evaluator.evaluate('review_run_completed')).toMatchObject({ satisfied: true });
    const transition = await machine.validateTransition(
      'in_review', 'needs_human_decision', evaluator,
    );
    expect(transition.to).toBe('needs_human_decision');
  });

  it('control: an untruncated 600-line diff still auto-approves', async () => {
    const { findings, evaluator, machine } = await reviewAndEvaluate({
      truncated: false,
      lineCount: 600,
    });

    // The informational warning is raised but gates nothing.
    expect(findings.map((f) => f.category)).toEqual(['large_diff_warning']);
    expect(findings[0]!.severity).toBe('info');

    const transition = await machine.validateTransition('in_review', 'approved', evaluator);
    expect(transition.to).toBe('approved');
  });
});
