/**
 * Adversarial finding verification.
 *
 * LLM review findings historically landed unverified with a self-reported,
 * miscalibrated confidence — in one day 3 of 6 findings were false positives,
 * all refutable mechanically against ground truth. This module runs, after
 * consolidation and BEFORE findings are persisted, a single adversarial LLM
 * verdict call per finding whose sole job is to try to REFUTE the finding using
 * pre-fetched ground truth (repo contents at the PR head + registered case
 * evidence). Refuted findings then stop gating the case lifecycle.
 *
 * The verifier judges against GROUND TRUTH, not the diff: it is given the
 * finding, file-existence results, relevant file contents, and case evidence
 * summaries — never the raw diff (a diff can't disprove a claim about the tree).
 *
 * Fail-soft everywhere: ANY error (path resolution, GitHub fetch, LLM call,
 * schema mismatch) degrades that finding's verdict to `unverified`. This module
 * never throws out of {@link verifyFindings}.
 *
 * Fail-CLOSED on missing grounding (issue #1110): a finding whose cited
 * file(s) could not actually be read — not in the tree, unfetchable, or only
 * available truncated — is forced to `unverified` in code, without an LLM
 * call, rather than left to an LLM that might otherwise treat "I could not
 * read this" as grounds to confirm, refute, or reason from the case's own
 * evidence prose in place of the source it never saw. See
 * {@link groundingUnavailableForCitedFiles}.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import type { Case, FindingVerificationStatus } from '@arbitra/shared';
import type { ConsolidatedFinding } from '../consolidation.js';
import type { ReviewContext } from '../../diff/review-context.js';
import { parseOwnerRepo } from '../../diff/diff-resolver.js';
import { resolveModel, resolveVerifierModelId } from '../../../lib/llm-provider.js';
import { STRUCTURED_OUTPUT_PROVIDER_OPTIONS } from '../../../lib/structured-output.js';

/** A single finding's verification outcome. */
export interface Verdict {
  status: FindingVerificationStatus;
  /** Verifier rationale, with citations appended when present. */
  note: string;
  /** Model id that produced (or would have produced) the verdict. */
  model: string;
}

/** Minimal evidence projection the verifier needs (type + summary only). */
export interface VerifierEvidence {
  type: string;
  summary: string;
}

export interface VerifyFindingsOptions {
  reviewContext?: ReviewContext | null;
  token?: string;
  evidence: VerifierEvidence[];
  /** The registered repository's URL, for `owner/repo` when the case holds an internal id. */
  repositoryUrl?: string;
}

/** Max verification LLM calls in flight at once. */
const CONCURRENCY = 5;
/** Max extra file fetches (beyond changed_files) per finding. */
const MAX_EXTRA_FETCHES = 3;
/** GitHub fetch timeout — mirrors review-context.ts. */
const FETCH_TIMEOUT_MS = 15_000;
/** Per-file content cap fed to the verifier prompt. */
const MAX_FILE_CHARS = 20_000;
/** NUL byte — binary-content heuristic (kept as an escape, never a literal). */
const NUL = String.fromCharCode(0);

// ---------------------------------------------------------------------------
// Verdict schema — the LLM returns one of three DECIDABLE verdicts. The fourth
// status, `unverified`, is reserved for fail-soft and never comes from the LLM.
// ---------------------------------------------------------------------------

export const verdictSchema = z.object({
  verdict: z
    .enum(['confirmed', 'refuted', 'uncertain'])
    .describe(
      'confirmed = ground truth supports the finding; refuted = ground truth ' +
        'disproves it; uncertain = the provided context cannot decide',
    ),
  rationale: z
    .string()
    .describe('Why you reached this verdict, referencing the provided ground truth'),
  // .default([]), not a bare required array: when there is nothing to cite
  // (most often on an 'uncertain' verdict) Claude omits the key rather than
  // sending `[]`, and a required-but-missing key fails zod validation —
  // same failure class as the review adapter's .nullish() fields (#907,
  // #1042). Fail-soft in verifyFindings() degraded this to `unverified`
  // instead of crashing the run, which is why it looked like a partial
  // failure rather than the review adapter's full "No object generated".
  citations: z
    .array(z.string())
    .default([])
    .describe('Specific file paths / evidence entries that justify the verdict'),
});

// ---------------------------------------------------------------------------
// Path extraction
// ---------------------------------------------------------------------------

/**
 * Matches path-looking tokens: an optional dir chain followed by a
 * `name.ext`, with an optional trailing `:line` / `:line-line` locator
 * (e.g. `src/foo.ts`, `packages/a/b.tsx:12-18`).
 *
 * The character class includes `[` / `]` for Next.js dynamic-route segments
 * (`app/api/users/[userId]/route.ts`) — over 100 files in this repo's own
 * `packages/frontend/src/app` tree use that convention. Without them the
 * regex loses the match at the bracket and restarts after it, silently
 * truncating e.g. `app/api/users/[userId]/chat-identity/route.ts` down to
 * `chat-identity/route.ts` — a path that then correctly reports "NOT found
 * in repo tree" even though the real file exists (issue #1110, instance 1 /
 * PR #1108).
 */
const PATH_TOKEN_RE = /(?:[A-Za-z0-9_.[\]-]+\/)*[A-Za-z0-9_.[\]-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?/g;

/** Extensions we treat as code/text files even when the token has no `/`. */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'go', 'rs', 'java',
  'kt', 'rb', 'php', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'scala',
  'sql', 'sh', 'bash', 'yml', 'yaml', 'toml', 'md', 'css', 'scss', 'html',
  'vue', 'svelte', 'proto', 'graphql', 'gql', 'tf', 'dockerfile', 'env',
]);

/** Strip a trailing `:line` / `:line-line` locator from a path token. */
function stripLineLocator(token: string): string {
  return token.replace(/:\d+(?:-\d+)?$/, '');
}

/**
 * Extract referenced file paths from a finding's `location` (authoritative)
 * plus any path-looking tokens in its title/description. Deterministic, no LLM.
 *
 * A token is kept only when it either contains a `/` (clearly a path) or ends
 * in a recognised code/text extension — this filters sentence noise like
 * "e.g." while still catching bare filenames. Deduped, order-preserved, capped.
 */
export function extractReferencedPaths(finding: ConsolidatedFinding): string[] {
  const sources: string[] = [];
  if (finding.location) sources.push(finding.location);
  if (finding.title) sources.push(finding.title);
  if (finding.description) sources.push(finding.description);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    const matches = source.match(PATH_TOKEN_RE);
    if (!matches) continue;
    for (const raw of matches) {
      const path = stripLineLocator(raw);
      if (!path) continue;
      const hasSlash = path.includes('/');
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      if (!hasSlash && !CODE_EXTENSIONS.has(ext)) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
      if (out.length >= 10) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ground-truth gathering (per finding)
// ---------------------------------------------------------------------------

interface PathResolution {
  path: string;
  existsInTree: boolean;
  /** Present when contents were resolved (changed_files or an extra fetch). */
  content?: string;
  truncated?: boolean;
  /** Where the contents came from, for the prompt. */
  source?: 'changed_file' | 'fetched';
}

interface GroundTruth {
  resolutions: PathResolution[];
  treeAvailable: boolean;
  treeTruncated: boolean;
}

function encodeContentsPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Fetch a single file's decoded contents via the GitHub Contents API. Fail-soft → null. */
async function fetchFileContents(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  token: string | undefined,
): Promise<{ content: string; truncated: boolean } | null> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Arbitra/1.0',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeContentsPath(path)}?ref=${encodeURIComponent(ref)}`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as unknown;
    if (!json || typeof json !== 'object') return null;
    const rec = json as Record<string, unknown>;
    if (typeof rec.content !== 'string' || rec.encoding !== 'base64') return null;
    let decoded: string;
    try {
      decoded = Buffer.from(rec.content, 'base64').toString('utf8');
    } catch {
      return null;
    }
    if (decoded.includes(NUL)) return null; // binary heuristic
    if (decoded.length > MAX_FILE_CHARS) {
      return { content: decoded.slice(0, MAX_FILE_CHARS), truncated: true };
    }
    return { content: decoded, truncated: false };
  } catch {
    return null;
  }
}

/**
 * Resolve a cited path against a set of known real (repo-root-relative)
 * paths — the union of the repo tree and the diff's changed files.
 *
 * Handles two cases:
 *   - an exact match (the common case: `finding.location` already carries
 *     the repo-root-relative path the diff itself uses), and
 *   - an UNAMBIGUOUS suffix match, for a citation that is a shorter or
 *     relative reference (e.g. an LLM reviewer citing `approval-pin.ts`
 *     for `packages/backend/src/services/case/approval-pin.ts` — issue
 *     #1110, instance 2: `case-sharp-leaf-4c_B` / PR #1109, where that file
 *     has been on the base branch since PR #1052 and still reported "NOT
 *     found in repo tree").
 *
 * A suffix match is accepted ONLY when exactly one known path ends with
 * `/${path}` (or equals it) — two files sharing a basename must never
 * silently resolve to one of them. Ambiguous or absent → `undefined`,
 * which keeps the existing "NOT found in repo tree" (safe) behavior.
 */
function resolveTreePath(path: string, knownPaths: Set<string>): string | undefined {
  if (knownPaths.has(path)) return path;
  const suffix = `/${path}`;
  let match: string | undefined;
  for (const candidate of knownPaths) {
    if (candidate.endsWith(suffix)) {
      if (match !== undefined) return undefined; // ambiguous — do not guess
      match = candidate;
    }
  }
  return match;
}

/**
 * Resolve each referenced path against the review context: existence via the
 * repo tree (see {@link resolveTreePath}), contents via changed_files first,
 * then (for paths that exist in the tree but weren't changed) up to
 * {@link MAX_EXTRA_FETCHES} live fetches.
 */
async function gatherGroundTruth(
  paths: string[],
  reviewContext: ReviewContext | null | undefined,
  ownerRepo: { owner: string; repo: string } | null,
  token: string | undefined,
): Promise<GroundTruth> {
  const treePaths = new Set(reviewContext?.repo_tree?.paths ?? []);
  const changedByPath = new Map(
    (reviewContext?.changed_files ?? []).map((f) => [f.path, f]),
  );
  // Resolve against the UNION of tree paths and changed-file paths, not the
  // tree alone: a changed (e.g. newly-added) file necessarily exists at head
  // regardless of whether the separately-fetched tree listing happens to
  // (re)confirm it, and a short/relative citation of a changed file must
  // resolve exactly the same way a short citation of an unchanged file does.
  const knownPaths = new Set<string>([...treePaths, ...changedByPath.keys()]);

  const resolutions: PathResolution[] = [];
  let extraFetches = 0;

  for (const path of paths) {
    const resolvedPath = resolveTreePath(path, knownPaths);
    // Report the resolved, full repo-root-relative path when we found one —
    // the LLM should see (and cite) the real path, not the short citation.
    const displayPath = resolvedPath ?? path;
    const changed = resolvedPath ? changedByPath.get(resolvedPath) : undefined;
    if (changed) {
      // A changed file necessarily exists at head.
      resolutions.push({
        path: displayPath,
        existsInTree: true,
        content: changed.content,
        truncated: changed.truncated,
        source: 'changed_file',
      });
      continue;
    }

    // Not in the diff. If it exists in the tree, try a bounded live fetch.
    if (
      resolvedPath !== undefined &&
      ownerRepo &&
      reviewContext?.head_ref &&
      extraFetches < MAX_EXTRA_FETCHES
    ) {
      extraFetches++;
      const fetched = await fetchFileContents(
        ownerRepo.owner,
        ownerRepo.repo,
        reviewContext.head_ref,
        resolvedPath,
        token,
      );
      if (fetched) {
        resolutions.push({
          path: displayPath,
          existsInTree: true,
          content: fetched.content,
          truncated: fetched.truncated,
          source: 'fetched',
        });
        continue;
      }
    }

    resolutions.push({ path: displayPath, existsInTree: resolvedPath !== undefined });
  }

  return {
    resolutions,
    treeAvailable: (reviewContext?.repo_tree?.paths?.length ?? 0) > 0,
    treeTruncated: reviewContext?.repo_tree?.truncated ?? false,
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are an adversarial verifier of code-review findings.',
  'Your job is to try to REFUTE the finding below using ONLY the provided ground truth',
  '(repository file existence, file contents, and case evidence).',
  'Confirm the finding ONLY when the evidence positively supports it.',
  'Answer "refuted" when the ground truth mechanically disproves it',
  '(e.g. the finding claims a file/import/symbol is missing but it is present).',
  'Answer "uncertain" when the provided context cannot decide either way —',
  'do NOT guess or rely on outside knowledge.',
  'You are NOT given the diff: judge the finding against ground truth, not against the change.',
  'When a cited file is marked "NOT found in repo tree" or its contents are not',
  'shown below, that means this file could NOT be inspected — it is NOT evidence',
  'that the file is missing, and it is NOT license to reason from case evidence',
  'instead. A claim about that file\'s contents must be "uncertain", never',
  '"refuted" or "confirmed", unless a DIFFERENT shown file already settles it.',
].join('\n');

function buildUserPrompt(
  finding: ConsolidatedFinding,
  ground: GroundTruth,
  evidence: VerifierEvidence[],
): string {
  const lines: string[] = [];

  lines.push('## Finding under verification');
  lines.push(`- **Title:** ${finding.title}`);
  lines.push(`- **Severity:** ${finding.severity}`);
  lines.push(`- **Category:** ${finding.category}`);
  if (finding.location) lines.push(`- **Location:** ${finding.location}`);
  lines.push(`- **Description:** ${finding.description}`);
  lines.push('');

  lines.push('## File existence (ground truth)');
  if (!ground.treeAvailable) {
    lines.push('No repository file listing was available; existence could not be checked.');
  } else if (ground.resolutions.length === 0) {
    lines.push('No file paths were referenced by this finding.');
  } else {
    for (const r of ground.resolutions) {
      lines.push(`- \`${r.path}\`: ${r.existsInTree ? 'EXISTS in repo tree' : 'NOT found in repo tree'}`);
    }
    if (ground.treeTruncated) {
      lines.push('(The repository listing was truncated — absence above does NOT prove a path is missing.)');
    }
  }
  lines.push('');

  const withContent = ground.resolutions.filter((r) => r.content !== undefined);
  if (withContent.length > 0) {
    lines.push('## Referenced file contents (ground truth)');
    for (const r of withContent) {
      lines.push(`### ${r.path}${r.truncated ? ' (truncated)' : ''}`);
      lines.push('```');
      lines.push(r.content ?? '');
      lines.push('```');
      lines.push('');
    }
  }

  if (evidence.length > 0) {
    lines.push('## Case evidence (ground truth)');
    lines.push('Registered evidence for this case (CI, tests, etc.):');
    for (const e of evidence) {
      lines.push(`- **[${e.type}]** ${e.summary || '(no summary)'}`);
    }
    lines.push('');
  }

  lines.push(
    'Return your verdict. Try to refute the finding; confirm only if the ground truth supports it;',
    'answer uncertain when the provided context cannot decide.',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Split an array into fixed-size chunks. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * True iff `ground` gives no USABLE (present, untruncated) content for any of
 * a finding's cited paths, while a real review context was actually fetched
 * for this case (`reviewContext` non-null — we tried).
 *
 * This is the deterministic, code-level fail-closed gate for issue #1110: a
 * finding that names a specific file is a claim about that file's CONTENTS,
 * and evidence prose (CI results, case summaries) cannot mechanically confirm
 * or refute a claim about code neither of us can see. Historically the LLM
 * was trusted to recognise this on its own and didn't — one finding was
 * `refuted` on the self-contradictory grounds that a file "does not exist"
 * yet "its tests cover the call", and another reasoned from case-evidence
 * prose after noting its only file excerpt was truncated before the relevant
 * function. Both were fed the same evidence section as the
 * "no review context" evidence-only mode below — the difference the LLM was
 * supposed to draw (and didn't) is exactly what this function draws instead.
 *
 * Scoped to `reviewContext != null` on purpose: when there is genuinely no
 * review context for the whole case (no PR/branch ref, or the resolve failed
 * outright), the module's sanctioned evidence-only mode still applies — a
 * finding making a claim evidence CAN speak to directly (e.g. "the build is
 * broken", refuted by a passing CI result) is still verifiable that way. What
 * must never happen is treating "we tried to fetch ground truth for this case
 * and specifically failed to read the file THIS finding is about" the same as
 * that legitimate degraded mode.
 */
function groundingUnavailableForCitedFiles(
  reviewContext: ReviewContext | null | undefined,
  paths: string[],
  ground: GroundTruth,
): boolean {
  if (reviewContext == null) return false;
  if (paths.length === 0) return false;
  return !ground.resolutions.some((r) => r.content !== undefined && !r.truncated);
}

/**
 * Build the deterministic `unverified` verdict for
 * {@link groundingUnavailableForCitedFiles}, naming which cited path(s)
 * could not be read at all vs. which were only available truncated — so the
 * note is actionable rather than a bare "unverified".
 */
function buildGroundingUnavailableVerdict(ground: GroundTruth, modelId: string): Verdict {
  const unread = ground.resolutions.filter((r) => r.content === undefined).map((r) => r.path);
  const truncatedOnly = ground.resolutions
    .filter((r) => r.content !== undefined && r.truncated)
    .map((r) => r.path);
  const parts: string[] = [];
  if (unread.length > 0) parts.push(`could not read: ${unread.join(', ')}`);
  if (truncatedOnly.length > 0) parts.push(`only a truncated excerpt available: ${truncatedOnly.join(', ')}`);
  return {
    status: 'unverified',
    note:
      `grounding unavailable for cited file(s) — ${parts.join('; ')}. ` +
      'Verdict withheld rather than inferred from case evidence.',
    model: modelId,
  };
}

/**
 * Verify each consolidated finding against ground truth, returning a map keyed
 * by finding signature. One adversarial `generateObject` call per finding, run
 * at most {@link CONCURRENCY} in flight. Fail-soft: any per-finding error yields
 * an `unverified` verdict; this function never throws.
 *
 * A finding whose cited file(s) could not be read from a review context that
 * WAS fetched short-circuits to `unverified` in code, before any LLM call —
 * see {@link groundingUnavailableForCitedFiles}. `unverified` gates identically
 * to `uncertain` (both keep blocking an authored high/critical finding; only
 * `refuted` lifts the block — `authorBlockingFindings` in preconditions.ts),
 * so this never weakens the gate; it only removes the LLM's chance to
 * `refuted`/`confirmed` off evidence prose in place of source it never saw.
 *
 * When no review context is available AT ALL for the case, the verifier still
 * runs, judging against case evidence alone (with empty file-existence/
 * contents sections) — an evidence-only refutation (e.g. "CI passed, so the
 * claimed build break is false") is still valuable. The verdict simply has
 * less ground truth to work with and will more often be `uncertain`.
 */
export async function verifyFindings(
  case_: Case,
  findings: ConsolidatedFinding[],
  opts: VerifyFindingsOptions,
): Promise<Map<string, Verdict>> {
  const results = new Map<string, Verdict>();
  if (findings.length === 0) return results;

  const modelId = resolveVerifierModelId();
  const ownerRepo = parseOwnerRepo(case_.repository_id ?? '', case_.current_pr_ref, opts.repositoryUrl);

  const verifyOne = async (finding: ConsolidatedFinding): Promise<void> => {
    let verdict: Verdict;
    try {
      const paths = extractReferencedPaths(finding);
      const ground = await gatherGroundTruth(
        paths,
        opts.reviewContext,
        ownerRepo,
        opts.token,
      );

      if (groundingUnavailableForCitedFiles(opts.reviewContext, paths, ground)) {
        results.set(finding.signature, buildGroundingUnavailableVerdict(ground, modelId));
        return;
      }

      const model = await resolveModel(undefined, modelId);
      const { object } = await generateObject({
        model,
        schema: verdictSchema,
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt(finding, ground, opts.evidence),
        providerOptions: STRUCTURED_OUTPUT_PROVIDER_OPTIONS,
      });
      const citations = object.citations.length > 0
        ? ` (citations: ${object.citations.join('; ')})`
        : '';
      verdict = {
        status: object.verdict,
        note: `${object.rationale}${citations}`,
        model: modelId,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      verdict = {
        status: 'unverified',
        note: `verification failed: ${reason}`,
        model: modelId,
      };
    }
    results.set(finding.signature, verdict);
  };

  for (const group of chunk(findings, CONCURRENCY)) {
    await Promise.allSettled(group.map(verifyOne));
  }

  return results;
}
