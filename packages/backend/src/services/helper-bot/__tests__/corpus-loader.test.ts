import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsState = {
  files: new Map<string, string>(),
};

vi.mock('node:fs/promises', () => {
  function listDir(dir: string) {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const direct = new Map<string, { isDir: boolean }>();
    for (const path of fsState.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        direct.set(rest, { isDir: false });
      } else {
        const name = rest.slice(0, slash);
        if (!direct.has(name)) direct.set(name, { isDir: true });
      }
    }
    return Array.from(direct.entries()).map(([name, meta]) => ({
      name,
      isDirectory: () => meta.isDir,
      isFile: () => !meta.isDir,
    }));
  }
  return {
    readdir: vi.fn(async (dir: string) => {
      const entries = listDir(dir);
      // The corpus-loader walks up looking for a `docs/` dir; emulate that by
      // surfacing a synthetic `docs` entry at the cwd-rooted path.
      if (dir === '/repo' && entries.length === 0) {
        return [{ name: 'docs', isDirectory: () => true, isFile: () => false }];
      }
      return entries;
    }),
    readFile: vi.fn(async (path: string) => {
      const content = fsState.files.get(path);
      if (content === undefined) {
        // Match real Node.js fs: a missing file rejects with `.code ===
        // 'ENOENT'`, which is exactly what the loader's per-file catch
        // branches on.
        const err = new Error(`ENOENT: no such file, open '${path}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    }),
  };
});

const cwdSpy = vi.spyOn(process, 'cwd');

import { loadDocsCorpus, __resetCorpusCache, DOCS_ALLOWLIST } from '../corpus-loader.js';

beforeEach(() => {
  fsState.files.clear();
  __resetCorpusCache();
  cwdSpy.mockReturnValue('/repo');
  delete process.env.ARBITRA_DOCS_ROOT;
});

describe('loadDocsCorpus', () => {
  it('includes an allowlisted file and labels it with its docs/ path', async () => {
    // Fails if the loader stops reading from `DOCS_ALLOWLIST` (e.g. reverts
    // to the old whole-tree walk) — see #823.
    process.env.ARBITRA_DOCS_ROOT = '/repo/docs';
    const [rel] = DOCS_ALLOWLIST;
    fsState.files.set(`/repo/docs/${rel}`, 'ALLOWLISTED_MARKER_BODY');

    const corpus = await loadDocsCorpus();

    expect(corpus).toContain(`## File: docs/${rel}`);
    expect(corpus).toContain('ALLOWLISTED_MARKER_BODY');
  });

  it('does not include a file that exists on disk but is not on the allowlist', async () => {
    // Fails if the loader reverts to walking `docs/**/*.md` wholesale
    // instead of reading only `DOCS_ALLOWLIST` entries — this is the exact
    // internal-doc-exposure regression from #823 (an internal doc leaking
    // into every Helper answer).
    process.env.ARBITRA_DOCS_ROOT = '/repo/docs';
    fsState.files.set('/repo/docs/notes.md', 'NOTES_SHOULD_NOT_LEAK');
    const [rel] = DOCS_ALLOWLIST;
    fsState.files.set(`/repo/docs/${rel}`, 'allowlisted body');

    const corpus = await loadDocsCorpus();

    expect(corpus).not.toContain('NOTES_SHOULD_NOT_LEAK');
    expect(corpus).not.toContain('## File: docs/notes.md');
  });

  it('skips a missing (ENOENT) allowlisted file without throwing', async () => {
    // Fails if the ENOENT check in the per-file catch is removed/widened
    // (e.g. back to catching every error) so a genuinely missing
    // allowlisted doc rejects the whole corpus load instead of being
    // logged and skipped.
    process.env.ARBITRA_DOCS_ROOT = '/repo/docs';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [present, ...rest] = DOCS_ALLOWLIST;
    fsState.files.set(`/repo/docs/${present}`, 'present body');
    // Every other allowlisted file is intentionally left out of fsState,
    // i.e. missing (ENOENT) on disk.

    const corpus = await loadDocsCorpus();

    expect(corpus).toContain('present body');
    for (const rel of rest) {
      expect(corpus).not.toContain(`## File: docs/${rel}`);
    }
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('rejects on a non-ENOENT read failure and does not cache a partial corpus, so the next call retries', async () => {
    // Fails if the per-file catch stops distinguishing ENOENT from other
    // errors (e.g. reverts to catching-and-skipping everything) — a
    // transient failure (EIO, EACCES, ...) would then be logged away and
    // silently baked into the process-lifetime cache as a partial corpus,
    // with no retry and only a console.warn to show for it.
    process.env.ARBITRA_DOCS_ROOT = '/repo/docs';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [rel] = DOCS_ALLOWLIST;
    fsState.files.set(`/repo/docs/${rel}`, 'stable body');

    const fs = await import('node:fs/promises');
    const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFileMock.mockImplementationOnce(async () => {
      const err = new Error('transient EIO') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    });

    await expect(loadDocsCorpus()).rejects.toThrow('transient EIO');

    // Not cached: the retry actually re-reads (and succeeds) rather than
    // replaying a memoized rejection or a partial corpus.
    const corpus = await loadDocsCorpus();
    expect(corpus).toContain('stable body');
    warnSpy.mockRestore();
  });

  it('concatenates allowlisted files in sorted path order', async () => {
    // Fails if the loader stops sorting `DOCS_ALLOWLIST` before reading,
    // making corpus order depend on the constant's declaration order.
    process.env.ARBITRA_DOCS_ROOT = '/repo/docs';
    fsState.files.set('/repo/docs/onboarding-guide.md', 'onboarding body');
    fsState.files.set('/repo/docs/mcp.md', 'mcp body');

    const corpus = await loadDocsCorpus();

    expect(corpus.indexOf('## File: docs/mcp.md')).toBeLessThan(
      corpus.indexOf('## File: docs/onboarding-guide.md'),
    );
  });

  it('caches the result for the lifetime of the process', async () => {
    process.env.ARBITRA_DOCS_ROOT = '/repo/docs';
    const [rel] = DOCS_ALLOWLIST;
    fsState.files.set(`/repo/docs/${rel}`, 'first');
    const first = await loadDocsCorpus();

    // Mutate the underlying fs — second call should still return the cached
    // contents, proving the cache is in effect.
    fsState.files.set(`/repo/docs/${rel}`, 'second');
    const second = await loadDocsCorpus();
    expect(second).toBe(first);
    expect(second).toContain('first');
    expect(second).not.toContain('second');
  });
});
