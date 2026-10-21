import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLERK_CORE_ID_SALT,
  CLERK_CORE_ID_SUFFIX_LENGTH,
  clerkCoreIds,
} from './clerk-core.js';

/**
 * The Clerk core document ids are the seam between two halves that never talk to
 * each other: `scripts/setup-clerk-core.ts` writes the project, repository, and
 * evidence policy; `AssistantIntakeService` resolves them at intake. If the
 * derivation drifts on one side, intake starts writing cases against a project
 * that was never provisioned — and it fails at runtime, in Firestore, not at
 * compile time. So the convention is pinned twice below: once against golden
 * ids, and once against the script's own literals.
 */

const SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
  'scripts/setup-clerk-core.ts',
);

describe('clerkCoreIds', () => {
  /**
   * Golden ids produced by `clerkIds()` in `scripts/setup-clerk-core.ts`. These
   * are the script's actual output, not a re-derivation — changing the salt,
   * digest, suffix length, or a prefix on either side breaks this test.
   */
  it.each([
    ['usr_test_alpha', 'baf20527202a9f87a6aa9dab'],
    ['usr_test_beta', '8327c4039686456ebef38965'],
    ['firebase-uid-123', '705ceefce46ae23b5e33ee60'],
  ])('derives the provisioning script ids for %s', (userId, suffix) => {
    expect(clerkCoreIds(userId)).toEqual({
      projectId: `proj_clerk_${suffix}`,
      repositoryId: `repo_clerk_${suffix}`,
      policyId: `ep_clerk_${suffix}`,
    });
  });

  it('gives all three documents the same suffix, so one user has one core', () => {
    const ids = clerkCoreIds('usr_shared_suffix');
    const suffixes = [
      ids.projectId.replace('proj_clerk_', ''),
      ids.repositoryId.replace('repo_clerk_', ''),
      ids.policyId.replace('ep_clerk_', ''),
    ];
    expect(new Set(suffixes).size).toBe(1);
    expect(suffixes[0]).toHaveLength(CLERK_CORE_ID_SUFFIX_LENGTH);
  });

  it('is deterministic per user and distinct across users', () => {
    expect(clerkCoreIds('usr_a')).toEqual(clerkCoreIds('usr_a'));
    expect(clerkCoreIds('usr_a').projectId).not.toBe(clerkCoreIds('usr_b').projectId);
  });

  it('does not collide when the salt boundary is moved into the user id', () => {
    // The NUL separator exists so `<salt>\0<user>` cannot be reproduced by a
    // crafted user id. Without it, a user id starting with the salt's tail would
    // be able to resolve to another user's core.
    expect(clerkCoreIds(`${CLERK_CORE_ID_SALT}\0real-user`).projectId).not.toBe(
      clerkCoreIds('real-user').projectId,
    );
  });
});

/**
 * Skipped rather than failed when the companion script is absent, so a checkout
 * without it (the script is a sibling deliverable) does not turn red for a
 * reason unrelated to this module.
 */
describe.skipIf(!existsSync(SCRIPT_PATH))('setup-clerk-core.ts id convention', () => {
  const source = existsSync(SCRIPT_PATH) ? readFileSync(SCRIPT_PATH, 'utf8') : '';

  it('still salts with the same string', () => {
    expect(source).toContain(CLERK_CORE_ID_SALT);
  });

  it('still uses sha256, hex, and the same suffix length', () => {
    expect(source).toContain("createHash('sha256')");
    expect(source).toContain("digest('hex')");
    expect(source.replace(/\s+/g, '')).toContain(`.slice(0,${CLERK_CORE_ID_SUFFIX_LENGTH})`);
  });

  it.each(['proj_clerk_', 'repo_clerk_', 'ep_clerk_'])(
    'still uses the %s prefix',
    (prefix) => {
      expect(source).toContain(prefix);
    },
  );
});
