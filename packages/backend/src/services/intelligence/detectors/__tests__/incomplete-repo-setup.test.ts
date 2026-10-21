import { describe, it, expect, beforeAll } from 'vitest';
import { sealSecret } from '../../../../lib/secret-box.js';
import { incompleteRepoSetupDetector } from '../incomplete-repo-setup.js';
import { makeRepository, makeProject, makeStubContext } from '../../__tests__/test-helpers.js';

describe('incompleteRepoSetupDetector', () => {
  beforeAll(() => {
    process.env['ARBITRA_ENCRYPTION_KEY'] = Buffer.alloc(32, 3).toString('base64');
  });

  it('flags a repo with no github_repository_id (webhook never signed)', async () => {
    const repo = makeRepository({ github_repository_id: undefined });
    const project = makeProject();
    const ctx = makeStubContext({ repositories: [repo], projects: [project] });

    const results = await incompleteRepoSetupDetector.run(ctx);

    const hit = results.find((r) => r.evidence['issue'] === 'no_signed_webhook_event');
    expect(hit).toBeDefined();
    expect(hit!.title).toContain('Webhook not receiving signed events');
    expect(hit!.title).toContain('Example'); // project name
    expect(hit!.severity).toBe('medium');
    expect(hit!.signature).toContain('repo_1:no-webhook');
  });

  it('flags a repo with webhook_misconfig_warned_at but no pull_request_event_seen_at', async () => {
    const repo = makeRepository({
      github_repository_id: 123456,
      github_token: sealSecret('ghp_test'),
      webhook_misconfig_warned_at: '2026-04-01T00:00:00.000Z',
      pull_request_event_seen_at: undefined,
    });
    const project = makeProject();
    const ctx = makeStubContext({ repositories: [repo], projects: [project] });

    const results = await incompleteRepoSetupDetector.run(ctx);

    const hit = results.find((r) => r.evidence['issue'] === 'missing_pull_request_event');
    expect(hit).toBeDefined();
    expect(hit!.title).toContain('Webhook missing pull_request event');
    expect(hit!.evidence['webhook_misconfig_warned_at']).toBe('2026-04-01T00:00:00.000Z');
    expect(hit!.severity).toBe('medium');
    expect(hit!.signature).toContain('repo_1:no-pr-event');
  });

  it('flags a repo with no github_token', async () => {
    const repo = makeRepository({
      github_repository_id: 123456,
      github_token: undefined,
    });
    const project = makeProject();
    const ctx = makeStubContext({ repositories: [repo], projects: [project] });

    const results = await incompleteRepoSetupDetector.run(ctx);

    const hit = results.find((r) => r.evidence['issue'] === 'missing_github_token');
    expect(hit).toBeDefined();
    expect(hit!.title).toContain('GitHub token not configured');
    expect(hit!.severity).toBe('medium');
    expect(hit!.signature).toContain('repo_1:no-token');
  });

  /** Reverts: checking the decrypted token instead of the stored field. */
  it('flags a repo whose stored token cannot be decrypted', async () => {
    const repo = makeRepository({ github_repository_id: 123456, github_token: 'ghp_plaintext_legacy' });
    const ctx = makeStubContext({ repositories: [repo], projects: [makeProject()] });

    const results = await incompleteRepoSetupDetector.run(ctx);

    expect(results.find((r) => r.evidence['issue'] === 'missing_github_token')).toBeDefined();
  });

  it('produces no nudges for a fully configured repo', async () => {
    const repo = makeRepository({
      github_repository_id: 123456,
      github_token: sealSecret('ghp_test'),
      pull_request_event_seen_at: '2026-04-15T00:00:00.000Z',
      webhook_misconfig_warned_at: undefined,
    });
    const project = makeProject();
    const ctx = makeStubContext({ repositories: [repo], projects: [project] });

    const results = await incompleteRepoSetupDetector.run(ctx);

    expect(results).toHaveLength(0);
  });

  it('deduplicates: same issue on second run is skipped via existing signature', async () => {
    const repo = makeRepository({ github_repository_id: undefined });
    const project = makeProject();

    // First run: no existing signatures → produces a nudge
    const ctx1 = makeStubContext({
      repositories: [repo],
      projects: [project],
      existingSignatures: [],
    });
    const first = await incompleteRepoSetupDetector.run(ctx1);
    const sig = first.find((r) => r.evidence['issue'] === 'no_signed_webhook_event')!.signature;
    expect(sig).toBeDefined();

    // Second run: the signature is already live → intelligence-service skips it
    // We simulate this by verifying that the signature the detector returns on a
    // second run matches what was produced on the first run (so the service can
    // deduplicate it using getExistingSignatures).
    const ctx2 = makeStubContext({
      repositories: [repo],
      projects: [project],
      existingSignatures: [sig],
    });
    const second = await incompleteRepoSetupDetector.run(ctx2);
    // The detector itself still returns the result; dedup is the service's job.
    // Verify the signature is stable (same value) so the service CAN dedup it.
    const sig2 = second.find((r) => r.evidence['issue'] === 'no_signed_webhook_event')!.signature;
    expect(sig2).toBe(sig);
  });

  it('returns all three nudges for a repo that has all three issues', async () => {
    const repo = makeRepository({
      github_repository_id: undefined,
      github_token: undefined,
      webhook_misconfig_warned_at: '2026-04-01T00:00:00.000Z',
      pull_request_event_seen_at: undefined,
    });
    const project = makeProject();
    const ctx = makeStubContext({ repositories: [repo], projects: [project] });

    const results = await incompleteRepoSetupDetector.run(ctx);

    expect(results).toHaveLength(3);
    const issues = results.map((r) => r.evidence['issue']);
    expect(issues).toContain('no_signed_webhook_event');
    expect(issues).toContain('missing_pull_request_event');
    expect(issues).toContain('missing_github_token');
  });

  it('uses project_id as fallback in title when project is not found', async () => {
    const repo = makeRepository({
      project_id: 'proj_unknown',
      github_repository_id: undefined,
    });
    const ctx = makeStubContext({ repositories: [repo], projects: [] });

    const results = await incompleteRepoSetupDetector.run(ctx);

    const hit = results.find((r) => r.evidence['issue'] === 'no_signed_webhook_event');
    expect(hit!.title).toContain('proj_unknown');
  });
});
