/**
 * Detect git submodule roots that a unified diff *introduces*.
 *
 * Why: the LLM reviewer treats every line of the PR diff as authored. When a
 * case runs `git submodule add <repo> <path>`, GitHub's diff includes the
 * submodule's pre-existing contents (or at least its gitlink), and the
 * reviewer raises real-but-not-the-author's findings (hardcoded creds, fixed
 * paths, …) against that code. Those high/critical findings then escalate the
 * case even though the author only pulled the code in. See issue #633.
 *
 * Scope (deliberate): we detect SUBMODULES only, because a submodule addition
 * is *deterministically* visible in the diff via two signals:
 *   1. A new/modified `.gitmodules` entry mapping `path = <dir>`.
 *   2. A gitlink hunk — `diff --git a/<path> b/<path>` followed by
 *      `+Subproject commit <sha>` (a 160000-mode gitlink, GitHub renders the
 *      change to a submodule pointer as a `Subproject commit` line).
 * Generic *vendored* directories (e.g. `vendor/`, `third_party/`, copied
 * source trees) are handled separately in `vendored-detection.ts` (issue #645):
 * a file is tagged `vendored` only when it is NEWLY ADDED in the diff under a
 * conventional vendored root, so editing pre-existing authored code under such
 * a dir is never auto-vendored. This module remains submodule-only.
 */

/**
 * Parse a unified diff and return the set of repository-root-relative paths
 * that are git submodule roots introduced (added or pointed) by the diff.
 *
 * Paths are normalized: no leading `./`, no trailing slash, forward slashes.
 * An empty set means the diff introduced no submodules.
 */
export function detectSubmodulePaths(diff: string): Set<string> {
  const paths = new Set<string>();
  if (!diff) return paths;

  const lines = diff.split('\n');

  // Signal 1: `.gitmodules` `path = <dir>` entries.
  // A submodule add writes/extends `.gitmodules`; the diff for that file shows
  // added (`+`) lines like `\tpath = libs/foo`. We only trust ADDED path lines
  // (a leading `+`), so an unchanged context line from a pre-existing submodule
  // does not get re-tagged on an unrelated PR.
  let inGitmodulesFile = false;
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      inGitmodulesFile = /\bb\/\.gitmodules$/.test(raw) || /\ba\/\.gitmodules\b/.test(raw);
      continue;
    }
    if (!inGitmodulesFile) continue;
    // Within the .gitmodules file diff, match added `path = …` lines.
    const m = raw.match(/^\+\s*path\s*=\s*(.+?)\s*$/);
    if (m && m[1]) {
      const p = normalizePath(m[1]);
      if (p) paths.add(p);
    }
  }

  // Signal 2: gitlink hunks — `+Subproject commit <sha>` inside a file diff.
  // GitHub renders an added/changed submodule pointer as a `Subproject commit`
  // line; the owning path is the `b/<path>` from the preceding `diff --git`.
  let currentPath: string | null = null;
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      currentPath = parseDiffGitPath(raw);
      continue;
    }
    // `+Subproject commit <40-hex-or-shorter-sha>` marks the file as a gitlink.
    if (/^\+Subproject commit [0-9a-f]+/.test(raw) && currentPath) {
      paths.add(currentPath);
    }
    // A `new file mode 160000` line also unambiguously marks a new gitlink.
    if (/^new file mode 160000\b/.test(raw) && currentPath) {
      paths.add(currentPath);
    }
  }

  return paths;
}

/**
 * Returns `true` if `filePath` lies inside any of the detected submodule
 * roots (or *is* a submodule root). Matching is segment-aware so that a
 * submodule at `libs/foo` matches `libs/foo` and `libs/foo/bar.ts` but NOT
 * `libs/foobar.ts`.
 *
 * `filePath` may carry a trailing location suffix from a finding location
 * (e.g. `libs/foo/bar.ts:12-18`); the suffix is stripped before comparison.
 */
export function isPathInSubmodule(
  filePath: string | null | undefined,
  submodulePaths: ReadonlySet<string>,
): boolean {
  if (!filePath || submodulePaths.size === 0) return false;
  const candidate = normalizeFindingPath(filePath);
  if (!candidate) return false;
  for (const root of submodulePaths) {
    if (candidate === root || candidate.startsWith(`${root}/`)) {
      return true;
    }
  }
  return false;
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
  // Split on the LAST colon only if what follows looks like a line locator,
  // so Windows-style `C:` drive prefixes (not expected here, but safe) and
  // colons inside the path are not mangled.
  const withoutSuffix = p.replace(/:(?:L?\d+(?:-\d+)?|\d+:\d+)\s*$/i, '');
  return normalizePath(withoutSuffix);
}
