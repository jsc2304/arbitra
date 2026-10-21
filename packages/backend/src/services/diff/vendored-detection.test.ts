import { describe, it, expect } from 'vitest';
import {
  detectVendoredPaths,
  isPathInVendored,
  CONVENTIONAL_VENDORED_ROOTS,
} from './vendored-detection.js';

describe('detectVendoredPaths', () => {
  it('detects a newly-added file under a conventional vendored root', () => {
    const diff = [
      'diff --git a/vendor/leftpad/index.js b/vendor/leftpad/index.js',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/vendor/leftpad/index.js',
      '@@ -0,0 +1,3 @@',
      '+module.exports = function leftpad(s) {',
      '+  return s;',
      '+};',
    ].join('\n');

    const paths = detectVendoredPaths(diff);
    expect(paths.has('vendor/leftpad/index.js')).toBe(true);
    expect(paths.size).toBe(1);
  });

  it('detects newly-added files under each conventional root', () => {
    const diff = [
      'diff --git a/vendor/a.js b/vendor/a.js',
      'new file mode 100644',
      'diff --git a/third_party/b.js b/third_party/b.js',
      'new file mode 100644',
      'diff --git a/external/c.js b/external/c.js',
      'new file mode 100755',
      'diff --git a/vendored/d.js b/vendored/d.js',
      'new file mode 100644',
    ].join('\n');

    const paths = detectVendoredPaths(diff);
    expect(paths.has('vendor/a.js')).toBe(true);
    expect(paths.has('third_party/b.js')).toBe(true);
    expect(paths.has('external/c.js')).toBe(true);
    expect(paths.has('vendored/d.js')).toBe(true);
    expect(paths.size).toBe(4);
  });

  it('does NOT detect an EDIT to a pre-existing file under a vendored root (no new file mode)', () => {
    // Governance-critical: editing old code under vendor/ stays authored so it
    // keeps blocking. Only wholesale additions are treated as vendored.
    const diff = [
      'diff --git a/vendor/leftpad/index.js b/vendor/leftpad/index.js',
      'index aaaaaaa..bbbbbbb 100644',
      '--- a/vendor/leftpad/index.js',
      '+++ b/vendor/leftpad/index.js',
      '@@ -1,3 +1,4 @@',
      ' module.exports = function leftpad(s) {',
      '+  const SECRET = "hardcoded-key";',
      '   return s;',
      ' };',
    ].join('\n');

    const paths = detectVendoredPaths(diff);
    expect(paths.size).toBe(0);
  });

  it('does NOT detect a newly-added file OUTSIDE any vendored root', () => {
    const diff = [
      'diff --git a/src/app/index.ts b/src/app/index.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/app/index.ts',
      '@@ -0,0 +1 @@',
      '+export const x = 1;',
    ].join('\n');

    const paths = detectVendoredPaths(diff);
    expect(paths.size).toBe(0);
  });

  it('is segment-aware: does NOT treat a prefix-sharing dir (vendorfoo/) as vendored', () => {
    const diff = [
      'diff --git a/vendorfoo/bar.js b/vendorfoo/bar.js',
      'new file mode 100644',
      'diff --git a/my-vendor/baz.js b/my-vendor/baz.js',
      'new file mode 100644',
    ].join('\n');

    const paths = detectVendoredPaths(diff);
    expect(paths.size).toBe(0);
  });

  it('does NOT treat a bare top-level file (no descendant segment) as vendored', () => {
    // `vendor` as a file name, or a file directly named like the root, must not
    // qualify — a vendored file always lives UNDER the root dir.
    const diff = [
      'diff --git a/vendor b/vendor',
      'new file mode 100644',
    ].join('\n');

    const paths = detectVendoredPaths(diff);
    expect(paths.size).toBe(0);
  });

  it('EXCLUDES a 160000 gitlink under a vendored root (that is a submodule, not vendored)', () => {
    const diff = [
      'diff --git a/vendor/sdk b/vendor/sdk',
      'new file mode 160000',
      'index 0000000..abcdef0',
      '--- /dev/null',
      '+++ b/vendor/sdk',
      '@@ -0,0 +1 @@',
      '+Subproject commit abcdef0123456789abcdef0123456789abcdef01',
    ].join('\n');

    const paths = detectVendoredPaths(diff);
    expect(paths.size).toBe(0);
  });

  it('detects added files but ignores edited ones in a mixed vendored diff', () => {
    const diff = [
      'diff --git a/vendor/new.js b/vendor/new.js',
      'new file mode 100644',
      '+++ b/vendor/new.js',
      '@@ -0,0 +1 @@',
      '+export const a = 1;',
      'diff --git a/vendor/old.js b/vendor/old.js',
      'index aaa..bbb 100644',
      '--- a/vendor/old.js',
      '+++ b/vendor/old.js',
      '@@ -1 +1 @@',
      '-export const b = 1;',
      '+export const b = 2;',
    ].join('\n');

    const paths = detectVendoredPaths(diff);
    expect(paths.has('vendor/new.js')).toBe(true);
    expect(paths.has('vendor/old.js')).toBe(false);
    expect(paths.size).toBe(1);
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

    expect(detectVendoredPaths(diff).size).toBe(0);
  });

  it('returns an empty set for empty input', () => {
    expect(detectVendoredPaths('').size).toBe(0);
  });

  it('exposes the conventional roots as a single source of truth', () => {
    expect(CONVENTIONAL_VENDORED_ROOTS).toContain('vendor');
    expect(CONVENTIONAL_VENDORED_ROOTS).toContain('third_party');
    expect(CONVENTIONAL_VENDORED_ROOTS).toContain('external');
    expect(CONVENTIONAL_VENDORED_ROOTS).toContain('vendored');
  });
});

describe('isPathInVendored', () => {
  const vendored = new Set(['vendor/leftpad/index.js', 'third_party/lib']);

  it('matches the exact vendored file path', () => {
    expect(isPathInVendored('vendor/leftpad/index.js', vendored)).toBe(true);
  });

  it('matches a descendant of a vendored dir entry', () => {
    expect(isPathInVendored('third_party/lib/sub/x.js', vendored)).toBe(true);
  });

  it('strips a line-range location suffix before matching', () => {
    expect(isPathInVendored('vendor/leftpad/index.js:12-18', vendored)).toBe(true);
    expect(isPathInVendored('vendor/leftpad/index.js:42', vendored)).toBe(true);
  });

  it('does NOT match a sibling path that merely shares a prefix', () => {
    expect(isPathInVendored('third_party/library/x.js', vendored)).toBe(false);
    expect(isPathInVendored('vendor/leftpad/index.js.bak', vendored)).toBe(false);
  });

  it('does NOT match an authored path outside any vendored entry', () => {
    expect(isPathInVendored('src/app/index.ts', vendored)).toBe(false);
  });

  it('returns false for an empty vendored set', () => {
    expect(isPathInVendored('vendor/leftpad/index.js', new Set())).toBe(false);
  });

  it('returns false for a nullish path', () => {
    expect(isPathInVendored(undefined, vendored)).toBe(false);
    expect(isPathInVendored(null, vendored)).toBe(false);
  });
});
