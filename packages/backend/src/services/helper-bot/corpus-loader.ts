/**
 * Loads an explicit allowlist of user-facing `docs/*.md` files into a
 * single string for the Arbitra Helper bot system prompt.
 *
 * Historically this walked the entire `docs/**\/*.md` tree. That leaked
 * internal-only content (non-allowlisted docs, `docs/specs/**`, future
 * specs) into answers any user could query, let unshipped specs get stated
 * as product fact, and pushed prompt size to ~434k tokens per question. See
 * issue #823. `DOCS_ALLOWLIST` below is now the single source of truth for
 * what the Helper may cite.
 *
 * The result is cached in module scope for the lifetime of the process —
 * docs are part of the deployed bundle, so they don't change at runtime.
 * The corpus is sent verbatim as a constant `system` message so Gemini's
 * implicit prompt cache can amortize the cost across requests.
 *
 * Files are concatenated in deterministic (sorted) order with a header
 * preceding each file so the model can cite the path.
 */
import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, resolve } from 'node:path';

let cached: string | null = null;
let inFlight: Promise<string> | null = null;

/**
 * User-facing docs the Helper is allowed to cite, as paths relative to the
 * `docs/` root. Everything not listed here is invisible to the Helper, even
 * if it exists on disk in the deployed image.
 *
 * Deliberately excluded (see #823): `docs/specs/**`, `docs/adr/**`,
 * `docs/database-schema.md`, `docs/intelligence.md`, `docs/deployment.md`,
 * `docs/session-signal-hook.md` and any planning / roadmap / status / audit /
 * implementation-plan / internal-notes file — these are engineering-internal or
 * describe unshipped work, not end-user help.
 */
export const DOCS_ALLOWLIST: readonly string[] = [
  'onboarding-guide.md',
  'mcp.md',
  'setup-claude-code.md',
  'setup-codex.md',
  'architecture.md',
  'e2e-test-walkthrough.md',
  'helper-bot.md',
];

/**
 * Resolve the repo root by walking up from the current working directory
 * until we find a `docs/` directory. Falls back to `process.cwd()/docs`.
 *
 * In production (Cloud Run) the cwd is the workspace root of the deployed
 * Next.js app; in dev/test it is whatever launched the process.
 */
async function findDocsRoot(): Promise<string> {
  const override = process.env.ARBITRA_DOCS_ROOT;
  if (override) return resolve(override);

  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    try {
      const entries = (await readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true })) as unknown as Dirent[];
      if (entries.some((e) => e.isDirectory() && String(e.name) === 'docs')) {
        return join(dir, 'docs');
      }
    } catch {
      // ignore — keep walking up
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), 'docs');
}

/**
 * Load and concatenate every file in `DOCS_ALLOWLIST` that exists under
 * `docs/`. Cached for the lifetime of the process; concurrent calls share a
 * single in-flight load.
 *
 * Per-file `readFile` failures are handled differently by cause: ENOENT
 * (the allowlisted doc genuinely isn't there) is logged and skipped so one
 * stale allowlist entry doesn't take down the whole corpus. Any other
 * error (EIO, EACCES, a transient read failure, ...) is not a "this file
 * was intentionally removed" signal, so it is rethrown — the load rejects,
 * nothing is cached, and the next call retries instead of being served a
 * silently-partial corpus forever.
 */
export async function loadDocsCorpus(): Promise<string> {
  if (cached !== null) return cached;
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<string> => {
    try {
      const root = await findDocsRoot();
      const parts: string[] = [];
      let loaded = 0;
      for (const rel of [...DOCS_ALLOWLIST].sort()) {
        let content: string;
        try {
          content = await readFile(/*turbopackIgnore: true*/ join(root, rel), 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            // Anything other than "file genuinely doesn't exist" (EIO,
            // EACCES, a transient mount hiccup, ...) is not a signal that
            // the doc was intentionally removed — rethrow so the whole
            // load rejects, `cached` stays null, and the outer `finally`
            // clears `inFlight` so the next call retries instead of
            // permanently memoizing a partial corpus behind one warning.
            throw err;
          }
          // Genuinely missing allowlisted doc — renamed, moved, or
          // stripped by a partial checkout. Log and skip rather than fail
          // the whole corpus load over one missing file.
          console.warn(
            `[helper-bot] WARNING: allowlisted doc missing, skipping: docs/${rel} (${(err as Error).message})`,
          );
          continue;
        }
        parts.push(`\n\n## File: docs/${rel}\n\n${content}`);
        loaded++;
      }
      if (loaded === 0) {
        // Fail loud: an empty corpus would otherwise be memoized for the
        // process lifetime with no signal that the system prompt has no
        // documentation. Most likely cause: docs/ stripped from the image
        // (.dockerignore / Dockerfile regression) or DOCS_ALLOWLIST paths
        // drifted from the files on disk.
        console.warn(
          `[helper-bot] WARNING: corpus loader found 0 of ${DOCS_ALLOWLIST.length} allowlisted markdown ` +
            `files at ${root}; system prompt will lack documentation. Check DOCS_ALLOWLIST / Dockerfile / .dockerignore.`,
        );
      }
      cached = parts.join('');
      return cached;
    } finally {
      // Always clear the in-flight slot — on success the result is now
      // memoized in `cached`; on failure we want the next call to retry
      // rather than be poisoned by a rejected promise.
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Test-only: drop the cache so a fresh load can be observed. */
export function __resetCorpusCache(): void {
  cached = null;
  inFlight = null;
}
