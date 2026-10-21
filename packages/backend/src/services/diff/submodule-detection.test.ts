import { describe, it, expect } from 'vitest';
import { detectSubmodulePaths, isPathInSubmodule } from './submodule-detection.js';

describe('detectSubmodulePaths', () => {
  it('detects a submodule added via .gitmodules + Subproject commit gitlink', () => {
    const diff = [
      'diff --git a/.gitmodules b/.gitmodules',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ b/.gitmodules',
      '@@ -0,0 +1,3 @@',
      '+[submodule "libs/vendor-lib"]',
      '+\tpath = libs/vendor-lib',
      '+\turl = https://github.com/example/vendor-lib.git',
      'diff --git a/libs/vendor-lib b/libs/vendor-lib',
      'new file mode 160000',
      'index 0000000..abcdef0',
      '--- /dev/null',
      '+++ b/libs/vendor-lib',
      '@@ -0,0 +1 @@',
      '+Subproject commit abcdef0123456789abcdef0123456789abcdef01',
    ].join('\n');

    const paths = detectSubmodulePaths(diff);
    expect(paths.has('libs/vendor-lib')).toBe(true);
    expect(paths.size).toBe(1);
  });

  it('detects a submodule from a gitlink hunk even without a .gitmodules change', () => {
    // e.g. a submodule pointer bump where .gitmodules already existed
    const diff = [
      'diff --git a/vendor/sdk b/vendor/sdk',
      'index 1111111..2222222 160000',
      '--- a/vendor/sdk',
      '+++ b/vendor/sdk',
      '@@ -1 +1 @@',
      '-Subproject commit 1111111111111111111111111111111111111111',
      '+Subproject commit 2222222222222222222222222222222222222222',
    ].join('\n');

    const paths = detectSubmodulePaths(diff);
    expect(paths.has('vendor/sdk')).toBe(true);
  });

  it('detects multiple submodules added in one diff', () => {
    const diff = [
      'diff --git a/.gitmodules b/.gitmodules',
      '+++ b/.gitmodules',
      '+\tpath = a/one',
      '+\tpath = b/two',
    ].join('\n');

    const paths = detectSubmodulePaths(diff);
    expect(paths.has('a/one')).toBe(true);
    expect(paths.has('b/two')).toBe(true);
    expect(paths.size).toBe(2);
  });

  it('returns an empty set for a normal authored diff', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index aaa..bbb 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' export function foo() {',
      '+  console.log("hello");',
      '   return 1;',
      ' }',
    ].join('\n');

    const paths = detectSubmodulePaths(diff);
    expect(paths.size).toBe(0);
  });

  it('does not treat a literal "Subproject commit" string in a context line as a gitlink', () => {
    // A doc/code line that merely mentions the words, not a `+Subproject commit` add.
    const diff = [
      'diff --git a/README.md b/README.md',
      '+++ b/README.md',
      '@@ -1 +1,2 @@',
      ' # Readme',
      '+The diff shows a Subproject commit line for submodules.',
    ].join('\n');

    const paths = detectSubmodulePaths(diff);
    expect(paths.size).toBe(0);
  });

  it('returns an empty set for empty input', () => {
    expect(detectSubmodulePaths('').size).toBe(0);
  });
});

describe('isPathInSubmodule', () => {
  const submodules = new Set(['libs/vendor-lib', 'vendor/sdk']);

  it('matches a file inside a submodule root', () => {
    expect(isPathInSubmodule('libs/vendor-lib/src/main.py', submodules)).toBe(true);
  });

  it('matches the submodule root itself', () => {
    expect(isPathInSubmodule('vendor/sdk', submodules)).toBe(true);
  });

  it('strips a line-range location suffix before matching', () => {
    expect(isPathInSubmodule('libs/vendor-lib/src/main.py:12-18', submodules)).toBe(true);
    expect(isPathInSubmodule('libs/vendor-lib/src/main.py:42', submodules)).toBe(true);
  });

  it('does NOT match a sibling path that merely shares a prefix', () => {
    // `libs/vendor-library` must not match submodule `libs/vendor-lib`.
    expect(isPathInSubmodule('libs/vendor-library/x.ts', submodules)).toBe(false);
  });

  it('does NOT match an authored path outside any submodule', () => {
    expect(isPathInSubmodule('src/app/index.ts', submodules)).toBe(false);
  });

  it('returns false for empty submodule set', () => {
    expect(isPathInSubmodule('libs/vendor-lib/x.ts', new Set())).toBe(false);
  });

  it('returns false for nullish path', () => {
    expect(isPathInSubmodule(undefined, submodules)).toBe(false);
    expect(isPathInSubmodule(null, submodules)).toBe(false);
  });
});
