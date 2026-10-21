import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case } from '@arbitra/shared';
import type { ConsolidatedFinding } from '../consolidation.js';
import type { ReviewContext } from '../../diff/review-context.js';

// Mock the AI SDK — generateObject is the single verdict call.
vi.mock('ai', () => ({
  generateObject: vi.fn(),
}));

// Mock the LLM provider so no real model is resolved.
vi.mock('../../../lib/llm-provider.js', () => ({
  resolveModel: vi.fn(async () => ({ modelId: 'verifier-model-x' })),
  resolveVerifierModelId: vi.fn(() => 'verifier-model-x'),
}));

import { generateObject } from 'ai';
import { extractReferencedPaths, verdictSchema, verifyFindings } from './finding-verifier.js';

const mockGenerateObject = vi.mocked(generateObject);

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Fix login',
    status: 'in_review',
    risk_level: 'medium',
    priority: 'high',
    validation_track: 'direct',
    project_id: 'proj_1',
    repository_id: 'acme/widgets',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Case;
}

function makeFinding(overrides: Partial<ConsolidatedFinding> = {}): ConsolidatedFinding {
  return {
    signature: `sig_${Math.random().toString(36).slice(2)}`,
    category: 'bug',
    severity: 'high',
    confidence: 0.8,
    severity_contested: false,
    title: 'Missing import in src/auth.ts',
    description: 'The symbol `foo` is used but never imported.',
    location: 'src/auth.ts:12-18',
    source_refs: ['llm-anthropic'],
    observations: [],
    ...overrides,
  };
}

function makeReviewContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    head_ref: 'abc123',
    changed_files: [],
    repo_tree: { paths: [], truncated: false },
    ...overrides,
  };
}

function base64(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

function verdictResult(verdict: 'confirmed' | 'refuted' | 'uncertain', citations: string[] = []) {
  return { object: { verdict, rationale: `${verdict} rationale`, citations } } as unknown as Awaited<
    ReturnType<typeof generateObject>
  >;
}

describe('extractReferencedPaths', () => {
  it('extracts the path from location, stripping the line locator', () => {
    const paths = extractReferencedPaths(makeFinding({ location: 'src/auth.ts:12-18', title: 'x', description: 'y' }));
    expect(paths).toContain('src/auth.ts');
    expect(paths).not.toContain('src/auth.ts:12-18');
  });

  it('extracts path-looking tokens from title and description', () => {
    const paths = extractReferencedPaths(
      makeFinding({
        location: undefined,
        title: 'Broken ref in packages/a/b.tsx',
        description: 'See also config/settings.json for details.',
      }),
    );
    expect(paths).toEqual(expect.arrayContaining(['packages/a/b.tsx', 'config/settings.json']));
  });

  it('ignores sentence noise without a slash or code extension', () => {
    const paths = extractReferencedPaths(
      makeFinding({ location: undefined, title: 'This is wrong, e.g. here.', description: 'Fix it.' }),
    );
    expect(paths).toHaveLength(0);
  });

  it('dedupes repeated paths', () => {
    const paths = extractReferencedPaths(
      makeFinding({ location: 'src/auth.ts:1', title: 'src/auth.ts is broken', description: 'src/auth.ts again' }),
    );
    expect(paths.filter((p) => p === 'src/auth.ts')).toHaveLength(1);
  });

  // Regression (issue #1110, instance 1 / PR #1108):
  // a Next.js dynamic-route directory segment (`[userId]`) broke
  // PATH_TOKEN_RE's directory-chain match, truncating the extracted path to
  // `chat-identity/route.ts` — which then correctly reported "NOT found in
  // repo tree" for a file that in fact existed at the PR head. Fails if
  // `PATH_TOKEN_RE`'s character class drops the `[`/`]` it was given.
  it('extracts the full path through a Next.js dynamic-route bracket segment', () => {
    const fullPath = 'packages/frontend/src/app/api/users/[userId]/chat-identity/route.ts';
    const paths = extractReferencedPaths(
      makeFinding({ location: `${fullPath}:40-60`, title: 'x', description: 'y' }),
    );
    expect(paths).toContain(fullPath);
    expect(paths).not.toContain('chat-identity/route.ts');
  });
});

describe('verifyFindings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an empty map for zero findings without calling the LLM', async () => {
    const result = await verifyFindings(makeCase(), [], { evidence: [] });
    expect(result.size).toBe(0);
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it('maps confirmed/refuted/uncertain verdicts and records the model', async () => {
    mockGenerateObject
      .mockResolvedValueOnce(verdictResult('confirmed', ['src/auth.ts']))
      .mockResolvedValueOnce(verdictResult('refuted'))
      .mockResolvedValueOnce(verdictResult('uncertain'));

    const f1 = makeFinding({ signature: 'sig_conf' });
    const f2 = makeFinding({ signature: 'sig_ref' });
    const f3 = makeFinding({ signature: 'sig_unc' });

    // Grounding must actually be available (the cited file readable and
    // untruncated) or the new deterministic fail-closed gate (#1110) short-
    // circuits to `unverified` before the mocked LLM ever runs — this test
    // is about the confirmed/refuted/uncertain MAPPING, exercised separately
    // below.
    const result = await verifyFindings(makeCase(), [f1, f2, f3], {
      reviewContext: makeReviewContext({
        changed_files: [{ path: 'src/auth.ts', content: 'import { foo } from "./foo";', truncated: false }],
      }),
      evidence: [],
    });

    expect(result.get('sig_conf')).toMatchObject({ status: 'confirmed', model: 'verifier-model-x' });
    expect(result.get('sig_conf')!.note).toContain('citations: src/auth.ts');
    expect(result.get('sig_ref')).toMatchObject({ status: 'refuted' });
    expect(result.get('sig_unc')).toMatchObject({ status: 'uncertain' });
  });

  it('resolves file existence against the repo tree and feeds it to the prompt', async () => {
    mockGenerateObject.mockResolvedValueOnce(verdictResult('refuted'));

    const finding = makeFinding({ signature: 'sig_exists', location: 'src/auth.ts:12' });
    const reviewContext = makeReviewContext({
      changed_files: [{ path: 'src/auth.ts', content: 'import { foo } from "./foo";', truncated: false }],
      repo_tree: { paths: ['src/auth.ts', 'src/foo.ts'], truncated: false },
    });

    await verifyFindings(makeCase(), [finding], { reviewContext, evidence: [] });

    const call = mockGenerateObject.mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toContain('EXISTS in repo tree');
    expect(call.prompt).toContain('import { foo }'); // changed-file contents included
  });

  it('fetches contents for a referenced path that exists in the tree but was not changed', async () => {
    const fetchMock = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ content: base64('export const other = 1;'), encoding: 'base64' }) }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    mockGenerateObject.mockResolvedValueOnce(verdictResult('confirmed'));

    const finding = makeFinding({ signature: 'sig_fetch', location: 'src/other.ts:3', title: 'x', description: 'y' });
    const reviewContext = makeReviewContext({
      changed_files: [],
      repo_tree: { paths: ['src/other.ts'], truncated: false },
    });

    await verifyFindings(makeCase(), [finding], { reviewContext, token: 'tok', evidence: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/repos/acme/widgets/contents/src/other.ts');
    expect(url).toContain('ref=abc123');
    const prompt = (mockGenerateObject.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain('export const other = 1;');
  });

  it('caps extra fetches at 3 per finding', async () => {
    const fetchMock = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ content: base64('x'), encoding: 'base64' }) }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    mockGenerateObject.mockResolvedValueOnce(verdictResult('uncertain'));

    // 5 referenced paths all present in tree, none changed.
    const finding = makeFinding({
      signature: 'sig_cap',
      location: undefined,
      title: 'refs a/one.ts b/two.ts c/three.ts d/four.ts e/five.ts',
      description: '',
    });
    const reviewContext = makeReviewContext({
      repo_tree: { paths: ['a/one.ts', 'b/two.ts', 'c/three.ts', 'd/four.ts', 'e/five.ts'], truncated: false },
    });

    await verifyFindings(makeCase(), [finding], { reviewContext, evidence: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('is fail-soft: an LLM error yields an unverified verdict', async () => {
    mockGenerateObject.mockRejectedValueOnce(new Error('model exploded'));

    // Grounding must be available so this actually reaches (and fails at)
    // the LLM call — otherwise the deterministic grounding gate (#1110)
    // short-circuits to `unverified` first for an unrelated reason.
    const finding = makeFinding({ signature: 'sig_fail' });
    const result = await verifyFindings(makeCase(), [finding], {
      reviewContext: makeReviewContext({
        changed_files: [{ path: 'src/auth.ts', content: 'import { foo } from "./foo";', truncated: false }],
      }),
      evidence: [],
    });

    const verdict = result.get('sig_fail');
    expect(verdict?.status).toBe('unverified');
    expect(verdict?.note).toContain('verification failed: model exploded');
    expect(verdict?.model).toBe('verifier-model-x');
  });

  it('never exceeds the concurrency cap of 5', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockGenerateObject.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return verdictResult('uncertain');
    });

    const findings = Array.from({ length: 12 }, (_, i) => makeFinding({ signature: `sig_${i}` }));
    // Grounding must be available for every finding or the deterministic
    // grounding gate (#1110) short-circuits before the mocked LLM runs at
    // all, which would let this assertion pass without exercising the
    // concurrency cap it claims to test.
    const result = await verifyFindings(makeCase(), findings, {
      reviewContext: makeReviewContext({
        changed_files: [{ path: 'src/auth.ts', content: 'import { foo } from "./foo";', truncated: false }],
      }),
      evidence: [],
    });

    expect(result.size).toBe(12);
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });

  it('verifies against evidence alone when no review context is provided', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mockGenerateObject.mockResolvedValueOnce(verdictResult('refuted', ['ci_result']));

    const finding = makeFinding({ signature: 'sig_noctx' });
    const result = await verifyFindings(makeCase(), [finding], {
      reviewContext: null,
      evidence: [{ type: 'ci_result', summary: 'CI passed on head' }],
    });

    expect(result.get('sig_noctx')?.status).toBe('refuted');
    expect(fetchMock).not.toHaveBeenCalled(); // no tree → no existence → no extra fetch
    const prompt = (mockGenerateObject.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain('existence could not be checked');
    expect(prompt).toContain('CI passed on head');
  });

  // Regression (issue #1110 — mandated fixture): a PR that ADDS a new file,
  // asserting the verifier actually reads it via the head-ref review context
  // (`changed_files` + `repo_tree`, exactly as `fetchReviewContext` populates
  // them from the PR head SHA). A test covering only a MODIFIED file would
  // already pass today — modified-file paths are cited in full and match
  // `changed_files`/`repo_tree` by exact string. What does NOT already work
  // is an added file cited by a shorter/relative path (e.g. an LLM reviewer
  // writing `chat-identity/route.ts` instead of the full repo-root path) —
  // exactly issue #1110 instance 2's mechanism (`approval-pin.ts`), applied
  // here to a file that exists ONLY at the PR head, never on the base
  // branch. Fails if `resolveTreePath`'s suffix-match branch is removed
  // (reverted to a bare `treePaths.has(path)` / `changedByPath.get(path)`).
  it('reads a file the PR ADDS, from the head-ref review context, even when cited by a short relative path', async () => {
    mockGenerateObject.mockResolvedValueOnce(verdictResult('confirmed'));

    const addedFullPath = 'packages/frontend/src/app/api/users/webhook/chat-identity/route.ts';
    const finding = makeFinding({
      signature: 'sig_added',
      // The LLM reviewer cites a short, relative form — NOT the full
      // repo-root path the diff and tree actually use.
      location: 'chat-identity/route.ts:40-60',
      title: 'Read-then-write race in the new chat-identity route',
      description: 'x',
    });
    const reviewContext = makeReviewContext({
      head_ref: 'pr-head-sha-added',
      changed_files: [
        { path: addedFullPath, content: 'export async function DELETE() { /* new file */ }', truncated: false, status: 'added' },
      ],
      repo_tree: { paths: [addedFullPath], truncated: false },
    });

    await verifyFindings(makeCase(), [finding], { reviewContext, evidence: [] });

    const prompt = (mockGenerateObject.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain(`\`${addedFullPath}\`: EXISTS in repo tree`);
    expect(prompt).not.toContain('NOT found in repo tree');
    expect(prompt).toContain('export async function DELETE()');
  });

  // Regression (issue #1110, instance 2 — case-sharp-leaf-4c_B / PR #1109):
  // a file present on the BASE branch (not touched by this PR, so absent
  // from `changed_files`) cited by a short path must still be resolved via
  // a live fetch at the head ref, not reported as "NOT found in repo tree".
  // Fails under the same revert as the previous test (`resolveTreePath`'s
  // suffix match).
  it('resolves a short citation for a file already on the base branch via a live fetch at the head ref', async () => {
    const fetchMock = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ content: base64('export function approvedCommitFor() {}'), encoding: 'base64' }) }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    mockGenerateObject.mockResolvedValueOnce(verdictResult('uncertain'));

    const fullPath = 'packages/backend/src/services/case/approval-pin.ts';
    const finding = makeFinding({
      signature: 'sig_base_short',
      location: 'approval-pin.ts:10',
      title: 'x',
      description: 'y',
    });
    const reviewContext = makeReviewContext({
      changed_files: [], // not touched by this PR
      repo_tree: { paths: [fullPath], truncated: false },
    });

    await verifyFindings(makeCase(), [finding], { reviewContext, token: 'tok', evidence: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    // Fetched at the review context's head ref, and by the resolved FULL
    // path — not the short citation the finding used.
    expect(url).toContain(`/contents/${fullPath}`);
    expect(url).not.toContain('/contents/approval-pin.ts');
    const prompt = (mockGenerateObject.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain(`\`${fullPath}\`: EXISTS in repo tree`);
    expect(prompt).toContain('export function approvedCommitFor()');
  });

  // A short citation that matches TWO different tree paths must NOT silently
  // resolve to either one — picking the wrong file would be worse than
  // reporting "not found" (which the grounding gate above then correctly
  // turns into `unverified`, never a confident verdict grounded in the wrong
  // file's contents). Both candidates carry real, distinct, USABLE content
  // so the two outcomes are actually distinguishable: if either one gets
  // silently picked, its content makes grounding look "available" and the
  // mocked 'confirmed' verdict comes through instead of `unverified`. Fails
  // if the ambiguity guard in `resolveTreePath`
  // (`if (match !== undefined) return undefined`) is removed.
  it('does not resolve an ambiguous short citation matching two different files', async () => {
    mockGenerateObject.mockResolvedValueOnce(verdictResult('confirmed'));

    const finding = makeFinding({ signature: 'sig_ambiguous', location: 'index.ts:1', title: 'x', description: 'y' });
    const reviewContext = makeReviewContext({
      changed_files: [
        { path: 'packages/a/index.ts', content: 'export const a = 1;', truncated: false },
        { path: 'packages/b/index.ts', content: 'export const b = 2;', truncated: false },
      ],
      repo_tree: { paths: ['packages/a/index.ts', 'packages/b/index.ts'], truncated: false },
    });

    const result = await verifyFindings(makeCase(), [finding], { reviewContext, evidence: [] });

    expect(mockGenerateObject).not.toHaveBeenCalled();
    expect(result.get('sig_ambiguous')?.status).toBe('unverified');
  });

  // Issue #1110, property 2 (the one it's "tempting to skip"): a finding
  // that cites a file the verifier genuinely could not read must land on a
  // deterministic `unverified` verdict WITHOUT ever calling the LLM — no
  // chance for it to `refuted` on the absence (the real, already-shipped
  // defect: `fnd_cba771…` was refuted on exactly this "file does not exist"
  // premise) or reason from case-evidence prose in its place. Fails if the
  // `groundingUnavailableForCitedFiles` short-circuit in `verifyOne` is
  // removed — the mocked 'refuted' verdict below would then come through.
  it('forces an unverified verdict, without calling the LLM, when a cited file cannot be read at all', async () => {
    mockGenerateObject.mockResolvedValueOnce(verdictResult('refuted'));

    const finding = makeFinding({
      signature: 'sig_unreadable',
      location: 'packages/frontend/src/app/api/users/ghost/route.ts:1',
      title: 'x',
      description: 'y',
    });
    const reviewContext = makeReviewContext({
      changed_files: [],
      repo_tree: { paths: ['packages/other/file.ts'], truncated: false }, // tree WAS available; this path is not in it
    });

    const result = await verifyFindings(makeCase(), [finding], {
      reviewContext,
      evidence: [{ type: 'ci_result', summary: 'CI passed on head' }],
    });

    expect(mockGenerateObject).not.toHaveBeenCalled();
    const verdict = result.get('sig_unreadable');
    expect(verdict?.status).toBe('unverified');
    expect(verdict?.note).toContain('grounding unavailable');
    expect(verdict?.note).toContain('could not read');
    // Must not read as though it were settled by case evidence.
    expect(verdict?.note).not.toContain('CI passed on head');
  });

  // Same property, for a truncated (not merely missing) excerpt — issue
  // #1110's second acceptance criterion names truncation explicitly (the
  // real `fnd_33656d98…` finding reasoned from evidence prose after its only
  // excerpt was truncated before the relevant function). Fails if the
  // `!r.truncated` clause is dropped from `groundingUnavailableForCitedFiles`.
  it('forces an unverified verdict, without calling the LLM, when the only cited-file content is truncated', async () => {
    mockGenerateObject.mockResolvedValueOnce(verdictResult('uncertain'));

    const fullPath = 'packages/backend/src/services/orchestration/preconditions.ts';
    const finding = makeFinding({ signature: 'sig_truncated', location: `${fullPath}:220`, title: 'x', description: 'y' });
    const reviewContext = makeReviewContext({
      changed_files: [{ path: fullPath, content: '// only the top of the file, cut off', truncated: true }],
      repo_tree: { paths: [fullPath], truncated: false },
    });

    const result = await verifyFindings(makeCase(), [finding], { reviewContext, evidence: [] });

    expect(mockGenerateObject).not.toHaveBeenCalled();
    const verdict = result.get('sig_truncated');
    expect(verdict?.status).toBe('unverified');
    expect(verdict?.note).toContain('truncated');
  });
});

describe('verdictSchema — omitted-key tolerance (#1042)', () => {
  // Claude omits a key it has nothing to say about instead of sending an
  // empty value. `citations` has nothing to report on most 'uncertain' (and
  // some 'refuted') verdicts, so the key gets omitted rather than sent as
  // `[]`. A bare `z.array(z.string())` treats a missing key as `Required`
  // and zod rejects the whole response — same failure class the review
  // adapter fixed for its own optional fields (#907). This test fails
  // without `.default([])` on `citations` in verdictSchema.
  it('parses a verdict response with `citations` omitted entirely', () => {
    const result = verdictSchema.safeParse({
      verdict: 'uncertain',
      rationale: 'The provided context does not settle this either way.',
      // citations intentionally omitted — not `citations: []`
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.citations).toEqual([]);
    }
  });

  it('still rejects a response missing a genuinely required field (verdict)', () => {
    const result = verdictSchema.safeParse({
      rationale: 'Some rationale',
      citations: [],
    });

    expect(result.success).toBe(false);
  });
});
