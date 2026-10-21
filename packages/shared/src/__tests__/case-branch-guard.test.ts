import { describe, it, expect } from 'vitest';
import {
  isCodeProducingCaseType,
  isProtectedBranch,
  slugifyForBranch,
  suggestBranchForCaseType,
  CODE_PRODUCING_CASE_TYPES,
} from '../types/case.js';

describe('isProtectedBranch', () => {
  it.each(['main', 'master', 'MAIN', 'Master', '  main  '])(
    'flags "%s" as protected',
    (branch) => {
      expect(isProtectedBranch(branch)).toBe(true);
    },
  );

  it.each(['feat/foo', 'fix/bar', 'develop', 'main-ish', '', undefined])(
    'does not flag "%s"',
    (branch) => {
      expect(isProtectedBranch(branch)).toBe(false);
    },
  );
});

describe('isCodeProducingCaseType', () => {
  it.each(CODE_PRODUCING_CASE_TYPES)('flags "%s"', (type) => {
    expect(isCodeProducingCaseType(type)).toBe(true);
  });

  it.each(['pr_review', 'manual_verification', 'other', undefined] as const)(
    'does not flag "%s"',
    (type) => {
      expect(isCodeProducingCaseType(type)).toBe(false);
    },
  );
});

describe('slugifyForBranch', () => {
  it('produces lowercase kebab-case', () => {
    expect(slugifyForBranch('Fix Race Condition In State Machine'))
      .toBe('fix-race-condition-in-state-machine');
  });

  it('strips non-alphanumerics', () => {
    expect(slugifyForBranch('auth: OAuth2 / login flow!')).toBe('auth-oauth2-login-flow');
  });

  it('collapses runs of separators', () => {
    expect(slugifyForBranch('a   --   b___c')).toBe('a-b-c');
  });

  it('caps length at ~40 chars on a word boundary when possible', () => {
    const slug = slugifyForBranch(
      'this is a very long title that should definitely be truncated somewhere',
    );
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.startsWith('this-is-a-very-long-title')).toBe(true);
  });

  it('returns empty string for empty / symbol-only input', () => {
    expect(slugifyForBranch('')).toBe('');
    expect(slugifyForBranch('!!!---')).toBe('');
  });
});

describe('suggestBranchForCaseType', () => {
  it('maps case types to prefixes', () => {
    expect(suggestBranchForCaseType('ticket_implementation', 'Add dark mode'))
      .toBe('feat/add-dark-mode');
    expect(suggestBranchForCaseType('bugfix', 'Null pointer on login'))
      .toBe('fix/null-pointer-on-login');
    expect(suggestBranchForCaseType('refactoring', 'Extract case service'))
      .toBe('refactor/extract-case-service');
    expect(suggestBranchForCaseType('security_review', 'Harden cookie flags'))
      .toBe('security/harden-cookie-flags');
  });

  it('falls back to "change" when the title yields no slug', () => {
    expect(suggestBranchForCaseType('bugfix', '!!!')).toBe('fix/change');
  });
});
