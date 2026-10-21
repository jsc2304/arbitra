/**
 * Detect generic *vendored* third-party trees that a unified diff *introduces*.
 *
 * Why: like the submodule case (see `submodule-detection.ts`), the LLM reviewer
 * treats every line of the PR diff as authored. When a case vendors a
 * third-party library into the repo — copying a `vendor/`, `third_party/`,
 * `external/`, or `vendored/` tree wholesale — the reviewer raises
 * real-but-not-the-author's findings (hardcoded creds, fixed paths, …) against
 * that copied code. Those high/critical findings then escalate the case even
 * though the author only pulled the code in. See issue #645 (follow-up to #633
 * / PR #643, which handled submodules only).
 *
 * GOVERNANCE SAFETY (this is the whole point of the conservative design):
 * A false `vendored` tag on AUTHORED code is a security hole — an authored
 * high/critical vulnerability would silently stop blocking the gate. So we do
 * NOT tag "any path under vendor/" as vendored: a project may legitimately
 * author code in a `vendor/` directory, and editing such pre-existing files
 * must keep gating exactly as before.
 *
 * The deterministic signal we trust (mirroring #643's "newly added in the
 * diff" determinism):
 *   - The file lives under a conventional vendored ROOT
 *     (`vendor/`, `third_party/`, `external/`, `vendored/`), AND
 *   - The file is NEWLY ADDED in *this* diff — the file diff carries a
 *     `new file mode <regular-mode>` header (a wholesale addition), not an edit
 *     to a pre-existing file.
 *
 * Consequences of that conjunction:
 *   - Vendoring a new `vendor/foo/…` tree (all new files) → detected.
 *   - Editing a pre-existing `vendor/foo/bar.ts` (no `new file mode`) → NOT
 *     detected → stays `authored` → keeps blocking. This is the safe default:
 *     touching old code under a vendor dir is treated as authorship.
 *   - A `new file mode 160000` gitlink is excluded here — that is a submodule
 *     and is handled by `submodule-detection.ts`, which tags `submodule`.
 *
 * Project-configurability is intentionally deferred (issue #645 lists it as a
 * possible direction). The conventional-root list is a single exported constant
 * (`CONVENTIONAL_VENDORED_ROOTS`) so a follow-up can thread a project-config
 * override (a `.arbitra` field or marker file) with minimal surface. Until then
 * the constant is the single source of truth.
 */

/**
 * Conventional top-level directory segments that, by widespread community
 * convention, hold copied third-party source. Matched as a leading path
 * SEGMENT only (so `vendor/foo` matches but `vendorfoo` does not).
 *
 * Single source of truth — a project-config override should extend/replace this
 * list rather than introduce a parallel one.
 */
export const CONVENTIONAL_VENDORED_ROOTS: readonly string[] = [
  'vendor',
  'third_party',
  'external',
  'vendored',
] as const;

/**
 * Parse a unified diff and return the set of repository-root-relative file
 * paths that are NEWLY-ADDED files sitting under a conventional vendored root.
 *
 * Determinism: a path is included only when its file diff has BOTH
 *   1. a `diff --git` header whose path's first segment is a conventional
 *      vendored root, and
 *   2. a `new file mode <mode>` line with a regular (non-gitlink) file mode,
 *      proving the file is added wholesale in this diff (not edited).
 *
 * Paths are normalized: no leading `./`, no trailing slash, forward slashes.
 * An empty set means the diff introduced no detectable vendored files.
 *
 * NOTE: this returns the set of newly-added vendored FILE paths, not directory
 * roots. `isPathInVendored` matches a finding location against this set
 * segment-aware, exact-or-descendant. (A vendored tree shows up as many
 * `new file` entries, so the set already enumerates the added files.)
 */
export function detectVendoredPaths(diff: string): Set<string> {
  const paths = new Set<string>();
  if (!diff) return paths;

  const lines = diff.split('\n');

  let currentPath: string | null = null;
  let currentUnderVendoredRoot = false;

  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      currentPath = parseDiffGitPath(raw);
      currentUnderVendoredRoot = currentPath !== null && isUnderVendoredRoot(currentPath);
      continue;
    }
    if (!currentUnderVendoredRoot || !currentPath) continue;

    // `new file mode <octal>` marks a wholesale addition. We require a REGULAR
    // file mode (100644/100755/120000 symlink), explicitly EXCLUDING the
    // 160000 gitlink mode — that is a submodule, owned by submodule-detection.
    const m = raw.match(/^new file mode (\d{6})\b/);
    if (m && m[1] && m[1] !== '160000') {
      paths.add(currentPath);
    }
  }

  return paths;
}

/**
 * Returns `true` if `filePath` is (or lies inside) any of the detected vendored
 * paths. Matching is segment-aware so that a vendored file at `vendor/foo.ts`
 * matches `vendor/foo.ts` but NOT `vendor/foo.ts.bak`, and a vendored dir entry
 * `vendor/foo` matches `vendor/foo/bar.ts` but NOT `vendor/foobar.ts`.
 *
 * `filePath` may carry a trailing location suffix from a finding location
 * (e.g. `vendor/foo/bar.ts:12-18`); the suffix is stripped before comparison.
 */
export function isPathInVendored(
  filePath: string | null | undefined,
  vendoredPaths: ReadonlySet<string>,
): boolean {
  if (!filePath || vendoredPaths.size === 0) return false;
  const candidate = normalizeFindingPath(filePath);
  if (!candidate) return false;
  for (const root of vendoredPaths) {
    if (candidate === root || candidate.startsWith(`${root}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns `true` if the path's FIRST segment is a conventional vendored root.
 * Segment-aware: `vendor/foo` qualifies, `vendorfoo/x` does not, and a bare
 * `vendor` (the root dir itself, no descendant) does not — a vendored file
 * always has at least one segment under the root.
 */
function isUnderVendoredRoot(path: string): boolean {
  const slash = path.indexOf('/');
  if (slash <= 0) return false; // no descendant segment, or leading slash
  const firstSegment = path.slice(0, slash);
  return (CONVENTIONAL_VENDORED_ROOTS as readonly string[]).includes(firstSegment);
}

/** Extract the repo-relative path from a `diff --git a/<x> b/<y>` header. */
function parseDiffGitPath(diffGitLine: string): string | null {
  // Prefer the `b/` (new) side; fall back to `a/` for deletions.
  const bMatch = diffGitLine.match(/ b\/(.+)$/);
  if (bMatch && bMatch[1]) return normalizePath(bMatch[1]);
  const aMatch = diffGitLine.match(/ a\/(\S+)/);
  if (aMatch && aMatch[1]) return normalizePath(aMatch[1]);
  return null;
}

/** Normalize a repo-relative path: drop `./`, trailing slash, collapse `\`. */
function normalizePath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/** Strip a `:lineRange` / `:line` location suffix off a finding file path. */
function normalizeFindingPath(p: string): string {
  // Location format is `path/to/file.ts:12-18` (see llm-adapter schema).
  const withoutSuffix = p.replace(/:(?:L?\d+(?:-\d+)?|\d+:\d+)\s*$/i, '');
  return normalizePath(withoutSuffix);
}
