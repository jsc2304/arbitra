import { describe, it, expect } from 'vitest';
import { ValidationError, type CreateCaseInput } from '@arbitra/shared';
import { assertBranchAllowsCaseType } from './case-service.js';

function baseInput(overrides: Partial<CreateCaseInput> = {}): CreateCaseInput {
  return {
    title: 'Guarded case',
    description: '',
    source_type: 'manual',
    project_id: 'proj_demo',
    repository_id: 'repo_demo',
    risk_level: 'medium',
    priority: 'normal',
    ...overrides,
  };
}

describe('assertBranchAllowsCaseType', () => {
  it.each([
    ['main', 'ticket_implementation'],
    ['master', 'bugfix'],
    ['MAIN', 'refactoring'],
    ['Master', 'security_review'],
  ] as const)(
    'rejects code-producing case "%s" on branch "%s"',
    (branch, caseType) => {
      expect(() =>
        assertBranchAllowsCaseType(
          baseInput({ case_type: caseType, current_branch: branch }),
        ),
      ).toThrowError(ValidationError);
    },
  );

  it('includes an actionable hint in the error message', () => {
    try {
      assertBranchAllowsCaseType(
        baseInput({ case_type: 'bugfix', current_branch: 'main' }),
      );
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const msg = (err as Error).message;
      expect(msg).toContain("'bugfix'");
      expect(msg).toContain("'main'");
      expect(msg).toMatch(/feat\/<slug>.*fix\/<slug>.*refactor\/<slug>.*security\/<slug>/);
    }
  });

  it('also inspects git_context.branch when current_branch is absent', () => {
    expect(() =>
      assertBranchAllowsCaseType(
        baseInput({
          case_type: 'ticket_implementation',
          git_context: {
            branch: 'master',
            remote_url: 'https://github.com/org/repo.git',
            commit_sha: 'abc',
          },
        }),
      ),
    ).toThrowError(ValidationError);
  });

  it.each(['pr_review', 'manual_verification', 'other'] as const)(
    'allows non-code-producing case type "%s" on main',
    (caseType) => {
      expect(() =>
        assertBranchAllowsCaseType(
          baseInput({ case_type: caseType, current_branch: 'main' }),
        ),
      ).not.toThrow();
    },
  );

  it('allows code-producing cases on a feature branch', () => {
    expect(() =>
      assertBranchAllowsCaseType(
        baseInput({ case_type: 'bugfix', current_branch: 'fix/race-cond' }),
      ),
    ).not.toThrow();
  });

  it('allows when no branch info is present (best-effort guard)', () => {
    expect(() =>
      assertBranchAllowsCaseType(baseInput({ case_type: 'bugfix' })),
    ).not.toThrow();
  });
});
