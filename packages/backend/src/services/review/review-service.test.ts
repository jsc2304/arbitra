import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case, KnowledgeAsset } from '@arbitra/shared';
import type { ReviewAdapterConfig, ReviewObservation } from './adapters/reviewer-adapter.js';
import { computeFindingSignature } from './finding-signature.js';

// ---------------------------------------------------------------------------
// In-memory Firestore double. Only the collections ReviewService touches.
// ---------------------------------------------------------------------------

interface Stores {
  runs: Map<string, Record<string, unknown>>;
  findings: Map<string, Record<string, unknown>>;
  cases: Map<string, Record<string, unknown>>;
  rawObs: Map<string, Record<string, unknown>>;
  evidence: Map<string, Record<string, unknown>>;
}

const stores: Stores = {
  runs: new Map(),
  findings: new Map(),
  cases: new Map(),
  rawObs: new Map(),
  evidence: new Map(),
};

function resetStores() {
  stores.runs.clear();
  stores.findings.clear();
  stores.cases.clear();
  stores.rawObs.clear();
  stores.evidence.clear();
}

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

function queryApi(store: Map<string, Record<string, unknown>>) {
  const filters: Array<{ field: string; value: unknown }> = [];
  const api: Record<string, unknown> = {
    where: (field: string, _op: string, value: unknown) => {
      filters.push({ field, value });
      return api;
    },
    get: async () => {
      let rows = Array.from(store.values());
      for (const f of filters) {
        rows = rows.filter((r) => r[f.field] === f.value);
      }
      return { docs: rows.map((r) => ({ data: () => r })) };
    },
  };
  return api;
}

function collectionApi(store: Map<string, Record<string, unknown>>) {
  const api = queryApi(store) as Record<string, unknown>;
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
  },
  // Minimal transaction fake for `lib/finding-idempotency.ts`'s
  // create-or-reactivate write (issue #739). No real optimistic-concurrency
  // enforcement — the concurrency tests rely on the deterministic finding id
  // itself collapsing racing writes onto the same map key.
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

// Control the verifier from tests: default returns a verdict per finding.
const verifyFindingsMock = vi.fn();
vi.mock('./verification/finding-verifier.js', () => ({
  verifyFindings: (...args: unknown[]) => verifyFindingsMock(...args),
}));

// Deterministic ids
let idCounter = 0;
vi.mock('../../lib/ids.js', () => ({
  generateId: (prefix: string) => `${prefix}_${++idCounter}`,
  deriveFindingId: (signature: string) => `fnd_${signature.slice(0, 32)}`,
}));

// No consensus config → single-model default path
vi.mock('../../lib/llm-provider.js', () => ({
  getConsensusConfig: vi.fn(async () => nextConsensusConfig),
}));

// Capture the config passed to the adapter's review().
const capturedConfigs: Array<ReviewAdapterConfig | undefined> = [];
// Observations the fake adapter returns (default: none → zero findings).
let nextObservations: unknown[] = [];
// Controllable consensus config + adapter list (used by the reviewerCount test).
// Default null/[] keeps every other suite on the single-model path.
let nextConsensusConfig: unknown = null;
let nextConsensusAdapters: Array<{
  name: string;
  review: (...a: unknown[]) => Promise<unknown>;
}> = [];
vi.mock('./adapters/adapter-registry.js', () => ({
  getAllAdapters: () => [
    {
      name: 'fake-adapter',
      review: async (_case: Case, _diff: string, config?: ReviewAdapterConfig) => {
        capturedConfigs.push(config);
        return { observations: nextObservations };
      },
    },
  ],
  buildConsensusAdapters: () => nextConsensusAdapters,
}));

// Diff detection is not under test here
vi.mock('../diff/submodule-detection.js', () => ({
  detectSubmodulePaths: () => new Set<string>(),
  isPathInSubmodule: () => false,
}));
vi.mock('../diff/vendored-detection.js', () => ({
  detectVendoredPaths: () => new Set<string>(),
  isPathInVendored: () => false,
}));

// Retry hook: replace the real RunCompletionHandler (which would reach
// for `getDb()`/case-pipeline-lock — out of scope for this file's Firestore
// double) with a spy so we can assert ReviewService wires failures into it,
// without exercising the pipeline's own internals here (covered by
// pipeline.test.ts).
const handleRunFailureMock = vi.fn(async () => {});
const onRunCompletedMock = vi.fn(async () => ({}));
vi.mock('../orchestration/pipeline.js', () => ({
  RunCompletionHandler: class {
    handleRunFailure = handleRunFailureMock;
    onRunCompleted = onRunCompletedMock;
  },
}));

import { ReviewService } from './review-service.js';
import type { KnowledgeRepository } from '../knowledge/knowledge-repository.js';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Fix login bug',
    description: 'desc',
    status: 'in_review',
    risk_level: 'medium',
    priority: 'high',
    validation_track: 'direct',
    owner_id: 'user_1',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Case;
}

function makeAsset(overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  return {
    knowledge_id: 'ka_1',
    type: 'review_guideline',
    title: 'Verify vendor API signatures',
    summary: 'summary',
    body: 'real content',
    scope_type: 'project',
    scope_ref: 'proj_1',
    status: 'verified',
    version: 1,
    trust_level: 1,
    source_case_refs: [],
    source_decision_refs: [],
    tags: [],
    artifact_refs: [],
    created_by: 'usr_1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const eventStub = { emit: vi.fn(async () => ({})) } as unknown as ConstructorParameters<
  typeof ReviewService
>[0];

function makeKnowledgeRepo(
  assets: KnowledgeAsset[],
  opts: { throwOnList?: boolean } = {},
): { repo: KnowledgeRepository; patch: ReturnType<typeof vi.fn> } {
  const patch = vi.fn(async () => {});
  const repo = {
    listForReviewScope: vi.fn(async () => {
      if (opts.throwOnList) throw new Error('knowledge store unavailable');
      return assets;
    }),
    patch,
  } as unknown as KnowledgeRepository;
  return { repo, patch };
}

describe('ReviewService — knowledge injection', () => {
  beforeEach(() => {
    resetStores();
    capturedConfigs.length = 0;
    nextObservations = [];
    nextConsensusConfig = null;
    nextConsensusAdapters = [];
    idCounter = 0;
    vi.clearAllMocks();
    verifyFindingsMock.mockReset();
    delete process.env.ARBITRA_REVIEW_VERIFICATION;
  });

  // One test below deliberately dirties the consensus config to force a run
  // failure; later describes in this file assume it stays null/[] (they
  // don't reset it in their own beforeEach), so clean up unconditionally.
  afterEach(() => {
    nextConsensusConfig = null;
    nextConsensusAdapters = [];
  });

  it('injects selected knowledge assets into the adapter config', async () => {
    const asset = makeAsset();
    const { repo } = makeKnowledgeRepo([asset]);
    const service = new ReviewService(eventStub, undefined, repo);

    await service.runReview(makeCase(), 'diff', 'user_1');

    expect(capturedConfigs).toHaveLength(1);
    const config = capturedConfigs[0];
    expect(config?.knowledge_assets).toBeDefined();
    expect(config?.knowledge_assets!.map((a) => a.knowledge_id)).toEqual(['ka_1']);
  });

  it('populates run.input_refs with injected knowledge ids', async () => {
    const asset = makeAsset({ knowledge_id: 'ka_42' });
    const { repo } = makeKnowledgeRepo([asset]);
    const service = new ReviewService(eventStub, undefined, repo);

    const { run } = await service.runReview(makeCase(), 'diff', 'user_1');

    // In-memory run object
    expect(run.input_refs).toEqual(['ka_42']);
    // Persisted run doc
    const persisted = stores.runs.get(run.run_id);
    expect(persisted?.input_refs).toEqual(['ka_42']);
    expect(persisted?.status).toBe('completed');
  });

  it('bumps last_referenced_at on each injected asset after success', async () => {
    const { repo, patch } = makeKnowledgeRepo([makeAsset({ knowledge_id: 'ka_9' })]);
    const service = new ReviewService(eventStub, undefined, repo);

    await service.runReview(makeCase(), 'diff', 'user_1');

    expect(patch).toHaveBeenCalledTimes(1);
    const [id, updates] = patch.mock.calls[0]!;
    expect(id).toBe('ka_9');
    expect(updates).toHaveProperty('last_referenced_at');
  });

  it('filters out non-eligible assets before injection', async () => {
    const { repo } = makeKnowledgeRepo([
      makeAsset({ knowledge_id: 'ka_ok', status: 'verified' }),
      makeAsset({ knowledge_id: 'ka_suggested', status: 'suggested' }),
      makeAsset({ knowledge_id: 'ka_note', type: 'implementation_note' }),
    ]);
    const service = new ReviewService(eventStub, undefined, repo);

    await service.runReview(makeCase(), 'diff', 'user_1');

    const ids = capturedConfigs[0]?.knowledge_assets!.map((a) => a.knowledge_id);
    expect(ids).toEqual(['ka_ok']);
  });

  it('completes the review and leaves input_refs empty when knowledge fetch throws', async () => {
    const { repo } = makeKnowledgeRepo([], { throwOnList: true });
    const service = new ReviewService(eventStub, undefined, repo);

    const { run } = await service.runReview(makeCase(), 'diff', 'user_1');

    expect(run.status).toBe('completed');
    expect(capturedConfigs[0]?.knowledge_assets).toBeUndefined();
    expect(run.input_refs).toEqual([]);
    const persisted = stores.runs.get(run.run_id);
    expect(persisted?.status).toBe('completed');
  });

  it('omits knowledge_assets from adapterConfig when no eligible assets exist', async () => {
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    await service.runReview(makeCase(), 'diff', 'user_1');

    expect(capturedConfigs[0]?.knowledge_assets).toBeUndefined();
  });

  it('still records the selected knowledge ids on input_refs when the run subsequently fails', async () => {
    // Knowledge selection succeeds and completes before the adapter call
    // throws, so the failure-path run update must not lose that context
    // (issue #709 follow-up: the failure path previously only wrote
    // {status, error_message, finished_at, updated_at}).
    nextConsensusConfig = [{ provider: 'anthropic', model: 'claude-x' }];
    nextConsensusAdapters = [
      {
        name: 'llm-anthropic',
        review: async () => {
          throw new Error('adapter exploded after knowledge was selected');
        },
      },
    ];
    const asset = makeAsset({ knowledge_id: 'ka_failed_run' });
    const { repo } = makeKnowledgeRepo([asset]);
    const service = new ReviewService(eventStub, undefined, repo);

    const { run } = await service.runReview(makeCase(), 'diff', 'user_1');

    expect(run.status).toBe('failed');
    expect(run.input_refs).toEqual(['ka_failed_run']);
    const persisted = stores.runs.get(run.run_id);
    expect(persisted?.status).toBe('failed');
    expect(persisted?.input_refs).toEqual(['ka_failed_run']);
  });
});

// ---------------------------------------------------------------------------
// Verification step
// ---------------------------------------------------------------------------

interface ObsOverrides {
  title?: string;
  location?: string;
  confidence?: number;
  severity?: string;
}

function makeObs(overrides: ObsOverrides = {}): Record<string, unknown> {
  return {
    source: 'llm-anthropic',
    model: 'claude-x',
    location: 'src/a.ts:1',
    category: 'bug',
    severity: 'high',
    confidence: 0.8,
    title: 'Finding A',
    description: 'desc',
    ...overrides,
  };
}

/** Verdict-per-finding by title prefix: confirm* / refute* / else uncertain. */
function verdictByTitle(): void {
  verifyFindingsMock.mockImplementation(
    async (_case: unknown, findings: Array<{ signature: string; title: string }>) => {
      const m = new Map<string, { status: string; note: string; model: string }>();
      for (const f of findings) {
        const status = f.title.startsWith('confirm')
          ? 'confirmed'
          : f.title.startsWith('refute')
            ? 'refuted'
            : 'uncertain';
        m.set(f.signature, { status, note: `${status} note`, model: 'verifier-model-x' });
      }
      return m;
    },
  );
}

describe('ReviewService — finding verification', () => {
  beforeEach(() => {
    resetStores();
    capturedConfigs.length = 0;
    nextObservations = [];
    idCounter = 0;
    vi.clearAllMocks();
    verifyFindingsMock.mockReset();
    delete process.env.ARBITRA_REVIEW_VERIFICATION;
  });

  it('persists verdicts onto findings and remaps confidence per verdict', async () => {
    nextObservations = [
      makeObs({ title: 'confirm me', location: 'src/c.ts:1', confidence: 0.8 }),
      makeObs({ title: 'refute me', location: 'src/r.ts:1', confidence: 0.8 }),
      makeObs({ title: 'uncertain me', location: 'src/u.ts:1', confidence: 0.8 }),
    ];
    verdictByTitle();
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    await service.runReview(makeCase(), 'diff', 'user_1');

    const persisted = Array.from(stores.findings.values());
    const byTitle = (t: string) => persisted.find((f) => f.title === t)!;

    const confirmed = byTitle('confirm me');
    expect(confirmed.verification_status).toBe('confirmed');
    expect(confirmed.verification_note).toBe('confirmed note');
    expect(confirmed.verifier_model).toBe('verifier-model-x');
    expect(confirmed.verified_at).toBeDefined();
    expect(confirmed.confidence).toBe(0.9); // max(0.8, 0.9)

    expect(byTitle('refute me').confidence).toBe(0.05);
    expect(byTitle('refute me').verification_status).toBe('refuted');

    expect(byTitle('uncertain me').confidence).toBe(0.5); // min(0.8, 0.5)
    expect(byTitle('uncertain me').verification_status).toBe('uncertain');
  });

  it('leaves confidence untouched for an unverified (fail-soft) verdict', async () => {
    nextObservations = [makeObs({ title: 'flaky', location: 'src/f.ts:1', confidence: 0.72 })];
    verifyFindingsMock.mockImplementation(
      async (_case: unknown, findings: Array<{ signature: string }>) => {
        const m = new Map();
        m.set(findings[0]!.signature, {
          status: 'unverified',
          note: 'verification failed: boom',
          model: 'verifier-model-x',
        });
        return m;
      },
    );
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    await service.runReview(makeCase(), 'diff', 'user_1');

    const f = Array.from(stores.findings.values())[0]!;
    expect(f.verification_status).toBe('unverified');
    expect(f.confidence).toBe(0.72);
  });

  it('passes the case evidence (type + summary) to the verifier', async () => {
    stores.evidence.set('ev_1', {
      evidence_id: 'ev_1',
      case_id: 'case_1',
      type: 'ci_result',
      summary: 'CI green',
    });
    stores.evidence.set('ev_other', {
      evidence_id: 'ev_other',
      case_id: 'other_case',
      type: 'unit_test_result',
      summary: 'nope',
    });
    nextObservations = [makeObs({ title: 'x', location: 'src/x.ts:1' })];
    verdictByTitle();
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    await service.runReview(makeCase(), 'diff', 'user_1');

    expect(verifyFindingsMock).toHaveBeenCalledTimes(1);
    const opts = verifyFindingsMock.mock.calls[0]![2] as { evidence: Array<{ type: string; summary: string }> };
    expect(opts.evidence).toEqual([{ type: 'ci_result', summary: 'CI green' }]);
  });

  it('records verification stats on the run doc and the review_completed event', async () => {
    nextObservations = [
      makeObs({ title: 'confirm one', location: 'src/c.ts:1' }),
      makeObs({ title: 'refute one', location: 'src/r.ts:1' }),
    ];
    verdictByTitle();
    const emit = vi.fn(async () => ({}));
    const service = new ReviewService(
      { emit } as unknown as ConstructorParameters<typeof ReviewService>[0],
      undefined,
      makeKnowledgeRepo([]).repo,
    );

    const { run } = await service.runReview(makeCase(), 'diff', 'user_1');

    const persistedRun = stores.runs.get(run.run_id);
    expect(persistedRun?.verification).toEqual({ confirmed: 1, refuted: 1, uncertain: 0, unverified: 0 });

    const completed = emit.mock.calls.find((c) => c[1] === 'review_completed');
    expect(completed).toBeDefined();
    const payload = completed![2] as { verified?: Record<string, number> };
    expect(payload.verified).toEqual({ confirmed: 1, refuted: 1, uncertain: 0, unverified: 0 });
  });

  it('opt-out (ARBITRA_REVIEW_VERIFICATION=false): no verifier call, no fields, no stats', async () => {
    process.env.ARBITRA_REVIEW_VERIFICATION = 'false';
    nextObservations = [makeObs({ title: 'untouched', location: 'src/u.ts:1', confidence: 0.77 })];
    const emit = vi.fn(async () => ({}));
    const service = new ReviewService(
      { emit } as unknown as ConstructorParameters<typeof ReviewService>[0],
      undefined,
      makeKnowledgeRepo([]).repo,
    );

    const { run } = await service.runReview(makeCase(), 'diff', 'user_1');

    expect(verifyFindingsMock).not.toHaveBeenCalled();
    const f = Array.from(stores.findings.values())[0]!;
    expect(f.confidence).toBe(0.77);
    expect(f.verification_status).toBeUndefined();
    expect(f.verified_at).toBeUndefined();
    expect(stores.runs.get(run.run_id)?.verification).toBeUndefined();
    const completed = emit.mock.calls.find((c) => c[1] === 'review_completed');
    expect((completed![2] as { verified?: unknown }).verified).toBeUndefined();
  });

  it('skips verification when there are zero findings', async () => {
    nextObservations = [];
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    await service.runReview(makeCase(), 'diff', 'user_1');

    expect(verifyFindingsMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Diff-coverage findings (#877)
// ---------------------------------------------------------------------------

describe('ReviewService — diff coverage findings (#877)', () => {
  beforeEach(() => {
    resetStores();
    capturedConfigs.length = 0;
    nextObservations = [];
    nextConsensusConfig = null;
    nextConsensusAdapters = [];
    idCounter = 0;
    vi.clearAllMocks();
    verifyFindingsMock.mockReset();
    process.env.ARBITRA_REVIEW_VERIFICATION = 'false';
  });

  const findingsByCategory = (category: string) =>
    Array.from(stores.findings.values()).filter((f) => f.category === category);

  it('raises a high diff_exceeds_limit finding when the diff was truncated', async () => {
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    const { run, findings } = await service.runReview(
      makeCase(), 'partial diff', 'system:pipeline', null, undefined, 1,
      { truncated: true, lineCount: 12_500 },
    );

    const raised = findingsByCategory('diff_exceeds_limit');
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe('high');
    expect(raised[0]!.status).toBe('open');
    // Both fields are what make the finding actually gate: the precondition
    // helpers count only `authored` findings, and the re-review dedup query
    // filters on `origin_type == 'reviewer'`.
    expect(raised[0]!.origin).toBe('authored');
    expect(raised[0]!.origin_type).toBe('reviewer');
    // The run itself still completes, so `review_run_completed` is satisfied
    // by a real run and the case keeps an edge out of `in_review`.
    expect(run.status).toBe('completed');
    expect(findings.some((f) => f.category === 'diff_exceeds_limit')).toBe(true);
  });

  it('records the truncation on the run doc and the review_completed event', async () => {
    const emit = vi.fn(async () => ({}));
    const service = new ReviewService(
      { emit } as unknown as ConstructorParameters<typeof ReviewService>[0],
      undefined,
      makeKnowledgeRepo([]).repo,
    );

    const { run } = await service.runReview(
      makeCase(), 'partial diff', 'system:pipeline', null, undefined, 1,
      { truncated: true, lineCount: 12_500 },
    );

    const persisted = stores.runs.get(run.run_id);
    expect(persisted?.diff_truncated).toBe(true);
    expect(persisted?.diff_line_count).toBe(12_500);

    const completed = emit.mock.calls.find((c) => c[1] === 'review_completed');
    const payload = completed![2] as { diff_truncated?: boolean; diff_line_count?: number };
    expect(payload.diff_truncated).toBe(true);
    expect(payload.diff_line_count).toBe(12_500);
  });

  // Issue #1054: `reviewedHeadSha` is how `DiffResolver`'s resolved commit
  // reaches `Run.reviewed_head_sha`, which is what
  // `review_run_completed` / `auto_approve_criteria_met` compare against
  // `Case.current_head_sha`. Asserting on the persisted doc (not just the
  // returned `run` object) proves the field actually reaches Firestore,
  // not just the in-memory return value.
  it('stamps reviewedHeadSha onto the persisted run doc as reviewed_head_sha', async () => {
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    const { run } = await service.runReview(
      makeCase(), 'partial diff', 'system:pipeline', null, undefined, 1,
      { truncated: false, lineCount: 5, reviewedHeadSha: 'sha_reviewed_abc123' },
    );

    expect(run.reviewed_head_sha).toBe('sha_reviewed_abc123');
    const persisted = stores.runs.get(run.run_id);
    expect(persisted?.reviewed_head_sha).toBe('sha_reviewed_abc123');
  });

  it('leaves reviewed_head_sha unset when the caller supplies no reviewedHeadSha', async () => {
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    const { run } = await service.runReview(
      makeCase(), 'partial diff', 'system:pipeline', null, undefined, 1,
      { truncated: false, lineCount: 5 },
    );

    expect(run.reviewed_head_sha).toBeUndefined();
    const persisted = stores.runs.get(run.run_id);
    expect(persisted?.reviewed_head_sha).toBeUndefined();
  });

  it('never sends the truncation finding to the adversarial verifier', async () => {
    // A `refuted` verdict drops a finding out of every high/critical gate
    // (`authorBlockingFindings` filters refuted findings). Truncation is a
    // measured fact, not a claim about the code, so it must never be put in
    // front of a verifier that could refute it.
    delete process.env.ARBITRA_REVIEW_VERIFICATION;
    nextObservations = [makeObs({ title: 'llm claim', location: 'src/a.ts:1' })];
    verifyFindingsMock.mockImplementation(
      async (_case: unknown, findings: Array<{ signature: string }>) => {
        const m = new Map();
        for (const f of findings) {
          m.set(f.signature, { status: 'refuted', note: 'n', model: 'v' });
        }
        return m;
      },
    );
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    await service.runReview(
      makeCase(), 'partial diff', 'system:pipeline', null, undefined, 1,
      { truncated: true, lineCount: 12_500 },
    );

    const submitted = verifyFindingsMock.mock.calls[0]![1] as Array<{ category: string }>;
    expect(submitted.map((f) => f.category)).toEqual(['bug']);

    const raised = findingsByCategory('diff_exceeds_limit')[0]!;
    expect(raised.verification_status).toBeUndefined();
    expect(raised.confidence).toBe(1);
  });

  it('raises an info large_diff_warning for a 600-line diff and still reviews normally', async () => {
    nextObservations = [makeObs({ title: 'real issue', location: 'src/a.ts:1' })];
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    const { run } = await service.runReview(
      makeCase(), 'complete diff', 'system:pipeline', null, undefined, 1,
      { truncated: false, lineCount: 600 },
    );

    const warnings = findingsByCategory('large_diff_warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('info');
    expect(findingsByCategory('diff_exceeds_limit')).toHaveLength(0);
    // The LLM review is unaffected — its finding is persisted as usual.
    expect(Array.from(stores.findings.values()).some((f) => f.title === 'real issue')).toBe(true);
    expect(stores.runs.get(run.run_id)?.diff_truncated).toBe(false);
  });

  it('raises nothing for a small complete diff', async () => {
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    await service.runReview(
      makeCase(), 'a\nb\nc', 'system:pipeline', null, undefined, 1,
      { truncated: false, lineCount: 3 },
    );

    expect(findingsByCategory('diff_exceeds_limit')).toHaveLength(0);
    expect(findingsByCategory('large_diff_warning')).toHaveLength(0);
  });

  it('does not duplicate the truncation finding on a re-review', async () => {
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    await service.runReview(
      makeCase(), 'partial diff', 'system:pipeline', null, undefined, 1,
      { truncated: true, lineCount: 12_500 },
    );
    // Second run sees the first run's finding via the previous-findings query.
    await service.runReview(
      makeCase(), 'partial diff', 'system:pipeline', null, undefined, 2,
      { truncated: true, lineCount: 13_100 },
    );

    expect(findingsByCategory('diff_exceeds_limit')).toHaveLength(1);
  });
});

describe('ReviewService — consensus reviewerCount denominator', () => {
  beforeEach(() => {
    resetStores();
    capturedConfigs.length = 0;
    nextObservations = [];
    nextConsensusConfig = null;
    nextConsensusAdapters = [];
    idCounter = 0;
    vi.clearAllMocks();
    verifyFindingsMock.mockReset();
    delete process.env.ARBITRA_REVIEW_VERIFICATION;
  });

  it('divides consensus agreement by SUCCEEDED adapters, not the configured count', async () => {
    // Verification is orthogonal to the denominator under test — keep it off.
    process.env.ARBITRA_REVIEW_VERIFICATION = 'false';
    // 3 configured consensus models; 2 fail transiently, 1 returns a real finding.
    nextConsensusConfig = [
      { provider: 'google', model: 'gemini-2.5-pro' },
      { provider: 'anthropic', model: 'claude-x' },
      { provider: 'openai', model: 'gpt-x' },
    ];
    const crit = makeObs({
      source: 'llm-google',
      model: 'gemini-2.5-pro',
      title: 'real critical',
      location: 'src/a.ts:1',
      severity: 'critical',
      confidence: 0.8,
    });
    nextConsensusAdapters = [
      {
        name: 'llm-google',
        review: async () => ({ observations: [crit] }),
      },
      {
        name: 'llm-anthropic',
        review: async () => {
          throw new Error('transient timeout');
        },
      },
      {
        name: 'llm-openai',
        review: async () => {
          throw new Error('transient 5xx');
        },
      },
    ];

    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    await service.runReview(makeCase(), 'diff', 'user_1');

    // Run doc records the configured-vs-succeeded split.
    const run = Array.from(stores.runs.values())[0]!;
    expect(run.configured_reviewer_count).toBe(3);
    expect(run.succeeded_reviewer_count).toBe(1);

    // The surviving finding must NOT be confidence-penalized for the two
    // adapters that never ran (denominator = 1 → ratio 1.0, no <0.34 penalty).
    const finding = Array.from(stores.findings.values()).find(
      (f) => f.title === 'real critical',
    )!;
    expect(finding).toBeDefined();
    expect(finding.confidence as number).toBeGreaterThanOrEqual(0.8);

    // User-facing consensus reporting must not claim 3 models when only 1 ran.
    expect(String(run.summary)).not.toContain('consensus');
  });
});

describe('ReviewService — run-level retry hook', () => {
  beforeEach(() => {
    resetStores();
    capturedConfigs.length = 0;
    nextObservations = [];
    nextConsensusConfig = null;
    nextConsensusAdapters = [];
    idCounter = 0;
    vi.clearAllMocks();
    verifyFindingsMock.mockReset();
    delete process.env.ARBITRA_REVIEW_VERIFICATION;
  });

  it('stamps the provided attempt number on the run doc', async () => {
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    const { run } = await service.runReview(makeCase(), 'diff', 'user_1', null, undefined, 3);

    expect(run.attempt).toBe(3);
    const persisted = Array.from(stores.runs.values())[0]!;
    expect(persisted.attempt).toBe(3);
  });

  it('defaults attempt to 1 when not provided', async () => {
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    const { run } = await service.runReview(makeCase(), 'diff', 'user_1');

    expect(run.attempt).toBe(1);
  });

  it('calls pipeline.handleRunFailure and onRunCompleted when the review run fails', async () => {
    process.env.ARBITRA_REVIEW_VERIFICATION = 'false';
    nextConsensusConfig = [{ provider: 'anthropic', model: 'claude-x' }];
    nextConsensusAdapters = [
      {
        name: 'llm-anthropic',
        review: async () => {
          throw new Error('all adapters down — transient timeout');
        },
      },
    ];
    const { repo } = makeKnowledgeRepo([]);
    // Truthy pipelineAdapter so ReviewService constructs the (mocked) RunCompletionHandler.
    const service = new ReviewService(eventStub, {} as never, repo);

    const { run, findings } = await service.runReview(makeCase(), 'diff', 'user_1', null, undefined, 1);

    expect(findings).toEqual([]);
    expect(run.status).toBe('failed');
    expect(handleRunFailureMock).toHaveBeenCalledTimes(1);
    expect(handleRunFailureMock.mock.calls[0]![0]).toMatchObject({
      run_id: run.run_id,
      status: 'failed',
    });
    expect(onRunCompletedMock).toHaveBeenCalledWith('case_1');
  });

  it('does not touch the pipeline when no pipelineAdapter was provided', async () => {
    process.env.ARBITRA_REVIEW_VERIFICATION = 'false';
    nextConsensusConfig = [{ provider: 'anthropic', model: 'claude-x' }];
    nextConsensusAdapters = [
      {
        name: 'llm-anthropic',
        review: async () => {
          throw new Error('boom');
        },
      },
    ];
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    await service.runReview(makeCase(), 'diff', 'user_1');

    expect(handleRunFailureMock).not.toHaveBeenCalled();
    expect(onRunCompletedMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Idempotency under a racing double-run (issue #739)
// ---------------------------------------------------------------------------

function reviewerFindingId(caseId: string, obs: ReviewObservation): string {
  return `fnd_${computeFindingSignature(caseId, obs).slice(0, 32)}`;
}

describe('ReviewService — finding idempotency under a racing double-run (issue #739)', () => {
  beforeEach(() => {
    resetStores();
    capturedConfigs.length = 0;
    nextObservations = [];
    nextConsensusConfig = null;
    nextConsensusAdapters = [];
    idCounter = 0;
    vi.clearAllMocks();
    verifyFindingsMock.mockReset();
    // Verification is orthogonal to the dedup mechanism under test here.
    process.env.ARBITRA_REVIEW_VERIFICATION = 'false';
  });

  afterEach(() => {
    delete process.env.ARBITRA_REVIEW_VERIFICATION;
  });

  it('creates exactly one finding when two review runs race on the same observation', async () => {
    // Two `runReview` calls racing on the same case each read
    // `previousFindings` before either has written (both see the store
    // empty), exactly the interleaving #739 describes for `review-service.ts`.
    // Fails if the deterministic-id / create-only write is reverted to
    // `generateId('finding')` + `.set()`: each racing call mints its own
    // random id and both writes land, producing two findings for the one
    // observation.
    const obs = makeObs({ title: 'Duplicate risk', location: 'src/a.ts:1' }) as ReviewObservation;
    nextObservations = [obs];
    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    await Promise.all([
      service.runReview(makeCase(), 'diff', 'user_1'),
      service.runReview(makeCase(), 'diff', 'user_1'),
    ]);

    const persisted = Array.from(stores.findings.values());
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!['finding_id']).toBe(reviewerFindingId('case_1', obs));
    expect(persisted[0]!['status']).toBe('open');
  });

  it('reopens a previously resolved finding under the same signature instead of duplicating it', async () => {
    const obs = makeObs({ title: 'Recurring risk', location: 'src/b.ts:1' }) as ReviewObservation;
    nextObservations = [obs];
    const signature = computeFindingSignature('case_1', obs);
    const findingId = `fnd_${signature.slice(0, 32)}`;
    // A prior iteration already fixed this exact defect; regression
    // re-detection (see the comment above `existingSignatures` in
    // `review-service.ts`) is supposed to re-raise it under the same
    // signature rather than staying silent.
    stores.findings.set(findingId, {
      finding_id: findingId,
      case_id: 'case_1',
      category: 'bug',
      severity: 'high',
      confidence: 0.8,
      status: 'resolved',
      title: 'Recurring risk',
      description: 'desc',
      origin_type: 'reviewer',
      source_refs: ['llm-anthropic'],
      evidence_refs: [],
      rule_refs: [],
      signature,
      resolution: 'Fixed in a prior iteration.',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const { repo } = makeKnowledgeRepo([]);
    const service = new ReviewService(eventStub, undefined, repo);

    await service.runReview(makeCase(), 'diff', 'user_1');

    // Reactivated in place — same doc id, not a second document.
    expect(stores.findings.size).toBe(1);
    const reopened = stores.findings.get(findingId)!;
    expect(reopened['status']).toBe('open');
    expect(reopened['finding_id']).toBe(findingId);
  });
});
