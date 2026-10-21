import type { Case } from '@arbitra/shared';
import { parseOwnerRepo, parsePrUrl } from './diff-resolver.js';

/**
 * Server-side review context enrichment.
 *
 * The review pipeline runs on Cloud Run with NO repository checkout — the LLM
 * reviewer only ever sees the raw unified diff. That causes diff-blindspot
 * false positives ("missing import" for an import that exists above the diff
 * hunk, "referenced file missing" for a file that exists elsewhere in the
 * tree). This module fetches, via the GitHub REST API, (1) the post-change
 * contents of the files touched by the diff and (2) a full repository file
 * listing, so the reviewer can check its own claims before reporting them.
 *
 * Fail-soft everywhere: any error (missing token, 4xx/5xx, timeout, malformed
 * response) degrades to `null` or partial data. This module must never throw.
 */

export interface ReviewContextFile {
  path: string;
  content: string;
  truncated: boolean;
  status?: string;
}

export interface ReviewContext {
  head_ref: string;
  changed_files: ReviewContextFile[];
  repo_tree: { paths: string[]; truncated: boolean };
}

const FETCH_TIMEOUT_MS = 15_000;

const MAX_FILES = 20;
const MAX_FILE_LINES = 800;
const MAX_FILE_CHARS = 60_000;
const MAX_FILE_PREVIEW_LINES = 120;
const MAX_TOTAL_CHARS = 200_000;

const MAX_TREE_PATHS = 3_000;

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'pdf',
  'zip', 'gz', 'tgz', 'tar', 'jar', 'war', '7z', 'rar',
  'class', 'so', 'dll', 'dylib', 'exe', 'bin', 'wasm', 'pyc',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'flac', 'wav',
  'psd', 'ai', 'sketch', 'db', 'sqlite', 'parquet',
]);

type ContextTarget =
  | { owner: string; repo: string; mode: 'pr'; number: number }
  | { owner: string; repo: string; mode: 'branch'; branch: string };

interface ChangedFileEntry {
  path: string;
  status?: string;
}

/**
 * Resolve the (owner, repo, ref-strategy) for a case, mirroring
 * `DiffResolver.resolve`'s target selection: PR case takes priority, falling
 * back to branch-only when no PR reference is present.
 */
function resolveContextTarget(case_: Case, repositoryUrl?: string): ContextTarget | null {
  if (case_.current_pr_ref) {
    const parsed = parsePrUrl(case_.current_pr_ref);
    if (parsed) {
      return { owner: parsed.owner, repo: parsed.repo, mode: 'pr', number: parsed.number };
    }
  }

  if (case_.current_branch) {
    const ownerRepo = parseOwnerRepo(case_.repository_id ?? '', case_.current_pr_ref, repositoryUrl);
    if (ownerRepo) {
      return { owner: ownerRepo.owner, repo: ownerRepo.repo, mode: 'branch', branch: case_.current_branch };
    }
  }

  return null;
}

function isLikelyBinaryPath(path: string): boolean {
  const idx = path.lastIndexOf('.');
  if (idx === -1) return false;
  const ext = path.slice(idx + 1).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function encodeContentsPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Fetch a GitHub REST API endpoint and parse it as JSON. Fail-soft: never throws, returns null on any error. */
async function githubFetchJson(url: string, token: string | undefined): Promise<unknown | null> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Arbitra/1.0',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[ReviewContext] GitHub fetch failed: ${response.status} ${response.statusText} for ${url}`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.warn(`[ReviewContext] GitHub fetch error for ${url}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function extractChangedEntries(filesJson: unknown): ChangedFileEntry[] {
  if (!Array.isArray(filesJson)) return [];
  const entries: ChangedFileEntry[] = [];
  for (const f of filesJson) {
    if (f && typeof f === 'object' && typeof (f as Record<string, unknown>).filename === 'string') {
      const rec = f as Record<string, unknown>;
      entries.push({
        path: rec.filename as string,
        status: typeof rec.status === 'string' ? rec.status : undefined,
      });
    }
  }
  return entries;
}

/**
 * Fetch post-change contents for the changed files, capped by file count,
 * per-file size, and a total character budget across all files.
 */
async function fetchChangedFileContents(
  owner: string,
  repo: string,
  ref: string,
  entries: ChangedFileEntry[],
  token: string | undefined,
): Promise<ReviewContextFile[]> {
  const candidates = entries
    .filter((e) => e.status !== 'removed' && !isLikelyBinaryPath(e.path))
    .slice(0, MAX_FILES);

  const result: ReviewContextFile[] = [];
  let totalChars = 0;

  for (const entry of candidates) {
    if (totalChars >= MAX_TOTAL_CHARS) break;

    const fileJson = await githubFetchJson(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeContentsPath(entry.path)}?ref=${encodeURIComponent(ref)}`,
      token,
    );
    if (!fileJson || typeof fileJson !== 'object') continue;
    const rec = fileJson as Record<string, unknown>;
    if (typeof rec.content !== 'string' || rec.encoding !== 'base64') continue; // dir, submodule, or unexpected shape

    let decoded: string;
    try {
      decoded = Buffer.from(rec.content, 'base64').toString('utf8');
    } catch {
      continue; // skip: decode failure implies binary content
    }
    if (decoded.includes('\u0000')) continue; // binary heuristic (NUL byte)

    let content = decoded;
    let truncated = false;
    const lineCount = decoded.split('\n').length;
    if (lineCount > MAX_FILE_LINES || decoded.length > MAX_FILE_CHARS) {
      content = decoded.split('\n').slice(0, MAX_FILE_PREVIEW_LINES).join('\n');
      truncated = true;
    }

    const remainingBudget = MAX_TOTAL_CHARS - totalChars;
    if (content.length > remainingBudget) {
      content = content.slice(0, remainingBudget);
      truncated = true;
    }

    totalChars += content.length;
    result.push({ path: entry.path, content, truncated, status: entry.status });
  }

  return result;
}

/** Fetch the full repository tree (blob paths only) at `ref`, capped at MAX_TREE_PATHS. */
async function fetchRepoTree(
  owner: string,
  repo: string,
  ref: string,
  token: string | undefined,
): Promise<{ paths: string[]; truncated: boolean }> {
  const treeJson = await githubFetchJson(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    token,
  );
  if (!treeJson || typeof treeJson !== 'object' || !Array.isArray((treeJson as Record<string, unknown>).tree)) {
    return { paths: [], truncated: false };
  }
  const rec = treeJson as Record<string, unknown>;
  const tree = rec.tree as unknown[];
  const paths: string[] = [];
  for (const entry of tree) {
    if (
      entry &&
      typeof entry === 'object' &&
      (entry as Record<string, unknown>).type === 'blob' &&
      typeof (entry as Record<string, unknown>).path === 'string'
    ) {
      paths.push((entry as Record<string, unknown>).path as string);
    }
  }
  // GitHub itself sets `truncated: true` when the tree exceeds its own limits
  // (100k entries / 7MB); combine with our own cap.
  const githubTruncated = rec.truncated === true;
  const truncated = githubTruncated || paths.length > MAX_TREE_PATHS;
  return {
    paths: truncated ? paths.slice(0, MAX_TREE_PATHS) : paths,
    truncated,
  };
}

/**
 * Fetch review context (changed-file contents + repo file listing) for a case
 * via the GitHub REST API. Returns `null` when no context can be resolved at
 * all (e.g. no PR/branch reference, or the PR head ref can't be determined).
 * Never throws — any error degrades to `null` or partial data.
 */
export async function fetchReviewContext(
  case_: Case,
  token?: string,
  repositoryUrl?: string,
): Promise<ReviewContext | null> {
  try {
    const target = resolveContextTarget(case_, repositoryUrl);
    if (!target) return null;

    const resolvedToken = token ?? process.env.GITHUB_TOKEN;

    let ref: string;
    let changedEntries: ChangedFileEntry[] = [];

    if (target.mode === 'pr') {
      const prJson = await githubFetchJson(
        `https://api.github.com/repos/${target.owner}/${target.repo}/pulls/${target.number}`,
        resolvedToken,
      );
      const headSha =
        prJson && typeof prJson === 'object'
          ? ((prJson as Record<string, unknown>).head as Record<string, unknown> | undefined)?.sha
          : undefined;
      if (typeof headSha !== 'string' || !headSha) {
        // Can't resolve a ref for the PR — no meaningful context possible.
        return null;
      }
      ref = headSha;

      const filesJson = await githubFetchJson(
        `https://api.github.com/repos/${target.owner}/${target.repo}/pulls/${target.number}/files?per_page=100`,
        resolvedToken,
      );
      changedEntries = extractChangedEntries(filesJson);
    } else {
      ref = target.branch;

      const compareJson = await githubFetchJson(
        `https://api.github.com/repos/${target.owner}/${target.repo}/compare/main...${encodeURIComponent(target.branch)}`,
        resolvedToken,
      );
      const files =
        compareJson && typeof compareJson === 'object'
          ? (compareJson as Record<string, unknown>).files
          : undefined;
      changedEntries = extractChangedEntries(files);
    }

    const [changedFiles, repoTree] = await Promise.all([
      fetchChangedFileContents(target.owner, target.repo, ref, changedEntries, resolvedToken),
      fetchRepoTree(target.owner, target.repo, ref, resolvedToken),
    ]);

    return { head_ref: ref, changed_files: changedFiles, repo_tree: repoTree };
  } catch (err) {
    console.warn(
      `[fetchReviewContext] Unexpected error for case ${case_.case_id}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
