import { describe, it, expect } from 'vitest';
import { shouldBlockAutoCaseCreation, shouldBlockZeroChangedFiles } from './webhook-service.js';

describe('shouldBlockAutoCaseCreation', () => {
  // Allowed branches — should return null (no block)
  it.each([
    'feat/add-login',
    'feature/user-dashboard',
    'fix/null-pointer',
    'bugfix/race-condition',
    'hotfix/prod-crash',
    'refactor/extract-service',
    'chore/update-deps',
    'claude/implement-feature-xK2nQ',
    'cursor/add-tests',
    'security/fix-xss',
    'docs/update-readme',
    'test/add-unit-tests',
    'perf/optimize-query',
    'ci/fix-pipeline',
    'build/update-webpack',
    'style/fix-formatting',
    'revert/undo-migration',
    'wip/draft-feature',
  ])('allows branch "%s"', (branch) => {
    expect(shouldBlockAutoCaseCreation(branch)).toBeNull();
  });

  // Blocked branches — should return a reason string
  it.each([
    'main',
    'master',
    'production',
    'develop',
    'staging',
    'local/feature-name',
    'local/my-test',
    'dependabot/npm_and_yarn/lodash-4.17.21',
    'renovate/typescript-5.x',
    'release/v1.2.0',
    'gh-pages',
  ])('blocks branch "%s"', (branch) => {
    expect(shouldBlockAutoCaseCreation(branch)).toBeTruthy();
  });

  // Branches without known prefix — blocked
  it.each([
    'my-random-branch',
    'testing-something',
    'experiment/new-idea',
  ])('blocks unrecognized branch prefix "%s"', (branch) => {
    expect(shouldBlockAutoCaseCreation(branch)).toBeTruthy();
  });

  it('blocks when no branch is provided', () => {
    expect(shouldBlockAutoCaseCreation(undefined)).toBeTruthy();
    expect(shouldBlockAutoCaseCreation('')).toBeTruthy();
  });

  it('returns descriptive reason for blocked branches', () => {
    const reason = shouldBlockAutoCaseCreation('local/feature-name');
    expect(reason).toContain('local/feature-name');
    expect(reason).toContain('blocked pattern');
  });
});

describe('shouldBlockZeroChangedFiles', () => {
  it('blocks when changed_file_count is explicitly 0', () => {
    const reason = shouldBlockZeroChangedFiles(0);
    expect(reason).toBeTruthy();
    expect(reason).toContain('zero changed files');
  });

  it('allows when changed_file_count is undefined (not yet computed by GitHub)', () => {
    expect(shouldBlockZeroChangedFiles(undefined)).toBeNull();
  });

  it('allows when changed_file_count is greater than 0', () => {
    expect(shouldBlockZeroChangedFiles(1)).toBeNull();
    expect(shouldBlockZeroChangedFiles(42)).toBeNull();
  });
});
