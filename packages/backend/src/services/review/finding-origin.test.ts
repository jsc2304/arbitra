import { describe, it, expect } from 'vitest';
import { classifyFindingOrigin } from './review-service.js';

describe('classifyFindingOrigin', () => {
  const submodulePaths = new Set(['libs/vendor-lib']);

  it('tags a finding inside a submodule path as submodule', () => {
    expect(classifyFindingOrigin('libs/vendor-lib/src/auth.py:10-12', submodulePaths)).toBe(
      'submodule',
    );
  });

  it('tags a finding on the submodule root as submodule', () => {
    expect(classifyFindingOrigin('libs/vendor-lib', submodulePaths)).toBe('submodule');
  });

  it('tags a finding in an authored path as authored', () => {
    expect(classifyFindingOrigin('packages/backend/src/index.ts:5', submodulePaths)).toBe(
      'authored',
    );
  });

  it('tags a finding as authored when no submodules were detected', () => {
    expect(classifyFindingOrigin('libs/vendor-lib/src/auth.py', new Set())).toBe('authored');
  });

  it('tags a finding with no location as authored', () => {
    expect(classifyFindingOrigin(undefined, submodulePaths)).toBe('authored');
  });

  it('does not tag a prefix-sharing sibling path as submodule', () => {
    expect(classifyFindingOrigin('libs/vendor-library/x.ts', submodulePaths)).toBe('authored');
  });

  // --- vendored classification (#645) ---
  const vendoredPaths = new Set(['vendor/leftpad/index.js', 'third_party/lib']);

  it('tags a finding inside a detected vendored path as vendored', () => {
    expect(
      classifyFindingOrigin('vendor/leftpad/index.js:10-12', new Set(), vendoredPaths),
    ).toBe('vendored');
  });

  it('tags a finding in a vendored dir descendant as vendored', () => {
    expect(classifyFindingOrigin('third_party/lib/sub/x.js', new Set(), vendoredPaths)).toBe(
      'vendored',
    );
  });

  it('tags a finding as authored when vendored set is empty (back-compat default arg)', () => {
    expect(classifyFindingOrigin('vendor/leftpad/index.js', submodulePaths)).toBe('authored');
  });

  it('does not tag a prefix-sharing sibling vendored path as vendored', () => {
    expect(classifyFindingOrigin('third_party/library/x.js', new Set(), vendoredPaths)).toBe(
      'authored',
    );
  });

  it('prefers submodule over vendored when a path is in both sets', () => {
    const both = new Set(['vendor/sdk']);
    expect(classifyFindingOrigin('vendor/sdk/main.py:5', both, both)).toBe('submodule');
  });

  it('tags an authored path as authored even with both sets populated', () => {
    expect(
      classifyFindingOrigin('packages/backend/src/index.ts:5', submodulePaths, vendoredPaths),
    ).toBe('authored');
  });
});
