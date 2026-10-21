import { describe, it, expect } from 'vitest';
import { detectCaseFields } from './case-detection-service.js';

describe('detectCaseFields — suggested_branch', () => {
  it('suggests fix/<slug> when detected type is bugfix and branch is main', () => {
    const result = detectCaseFields({
      git_context: {
        branch: 'main',
        remote_url: 'https://github.com/org/repo.git',
        commit_sha: 'abc',
      },
      pr_labels: ['bug'],
      pr_title: 'Null pointer on login',
    });
    expect(result.case_type).toBe('bugfix');
    expect(result.suggested_branch).toBe('fix/null-pointer-on-login');
  });

  it('suggests feat/<slug> when pr_labels indicate feature and branch is master', () => {
    const result = detectCaseFields({
      git_context: {
        branch: 'master',
        remote_url: 'https://github.com/org/repo.git',
        commit_sha: 'abc',
      },
      pr_labels: ['feature'],
      pr_title: 'Introduce evidence detail panel',
    });
    expect(result.case_type).toBe('ticket_implementation');
    expect(result.suggested_branch).toBe('feat/introduce-evidence-detail-panel');
  });

  it('omits suggested_branch on an already-valid feature branch', () => {
    const result = detectCaseFields({
      git_context: {
        branch: 'fix/race-condition',
        remote_url: 'https://github.com/org/repo.git',
        commit_sha: 'abc',
      },
      pr_title: 'Fix race condition in state machine',
    });
    expect(result.case_type).toBe('bugfix');
    expect(result.suggested_branch).toBeUndefined();
  });

  it('omits suggested_branch when detected case type is not code-producing', () => {
    const result = detectCaseFields({
      git_context: {
        branch: 'main',
        remote_url: 'https://github.com/org/repo.git',
        commit_sha: 'abc',
      },
    });
    expect(result.case_type).toBe('other');
    expect(result.suggested_branch).toBeUndefined();
  });

  it('detects security_review from security/ branch prefix', () => {
    const result = detectCaseFields({
      git_context: {
        branch: 'security/fix-xss',
        remote_url: 'https://github.com/org/repo.git',
        commit_sha: 'abc',
      },
    });
    expect(result.case_type).toBe('security_review');
    expect(result.suggested_branch).toBeUndefined();
  });
});

describe('detectCaseFields — risk_level from changed files', () => {
  const detect = (changed_files: string[]) =>
    detectCaseFields({
      git_context: {
        branch: 'docs/dev-schedulers-paused',
        remote_url: 'https://github.com/org/repo.git',
        commit_sha: 'abc',
      },
      changed_files,
    });

  // Regression for PR #1076: a docs-only PR touching
  // docs/deployment.md was rated `critical` ("deployment config") because the
  // path pattern was a bare /deploy/i. Fails when the bare pattern is
  // reinstated or `isDocumentationPath` is removed from `detectRiskLevel`.
  it('rates a docs-only change touching docs/deployment.md as low', () => {
    const result = detect(['docs/deployment.md', 'docs/overview.md']);
    expect(result.risk_level).toBe('low');
    expect(result.risk_level_reason).toBe('documentation/test-only changes');
  });

  // Fails when `isDocumentationPath` no longer short-circuits the high/medium
  // patterns (`/auth/i`, `/\/services\//`) for Markdown under docs/.
  it('never raises risk above low for Markdown or docs/ paths, whatever they are named', () => {
    expect(detect(['docs/auth-guide.md']).risk_level).toBe('low');
    expect(detect(['docs/migration/2026-notes.md']).risk_level).toBe('low');
    expect(detect(['packages/backend/src/services/README.md']).risk_level).toBe('low');
    expect(detect(['scripts/deploy/README.md']).risk_level).toBe('low');
  });

  // Fails when the bare /deploy/i pattern is reinstated: a service module
  // that merely has "deploy" in its name is service-layer code, not config.
  it('does not treat a source file with "deploy" in its name as deployment config', () => {
    const result = detect(['packages/backend/src/services/deploy-notifier.ts']);
    expect(result.risk_level).toBe('medium');
    expect(result.risk_level_reason).toContain('service layer');
  });

  it('still rates real deployment config as critical', () => {
    expect(detect(['scripts/deploy.sh']).risk_level).toBe('critical');
    expect(detect(['scripts/deploy.sh']).risk_level_reason).toContain('deploy script');
    expect(detect(['.github/workflows/deploy.yml']).risk_level).toBe('critical');
    expect(detect(['deploy/cloudrun-service.yaml']).risk_level).toBe('critical');
    expect(detect(['deploy/rollout.py']).risk_level).toBe('critical');
    expect(detect(['cloudbuild.yaml']).risk_level).toBe('critical');
    expect(detect(['Dockerfile']).risk_level).toBe('critical');
    expect(detect(['firebase.prod.json']).risk_level).toBe('critical');
  });

  it('keeps a mixed docs + deploy-config change at critical', () => {
    const result = detect(['docs/deployment.md', 'scripts/deploy.sh']);
    expect(result.risk_level).toBe('critical');
    expect(result.risk_level_reason).toContain('scripts/deploy.sh');
  });

  it('leaves the non-docs high patterns untouched', () => {
    expect(detect(['packages/backend/src/lib/auth/session.ts']).risk_level).toBe('high');
    expect(detect(['package-lock.json']).risk_level).toBe('high');
  });

  // Fails when `isDocumentationPath` treats every `docs/` segment as
  // documentation: code that renders the docs page is still an API route.
  it('does not mistake code under an app docs/ directory for documentation', () => {
    expect(detect(['packages/frontend/src/app/api/docs/route.ts']).risk_level).toBe('high');
  });
});
