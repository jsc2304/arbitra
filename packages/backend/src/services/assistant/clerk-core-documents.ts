import type { EvidencePolicy, EvidencePolicyRulesMap, Project, Repository } from '@arbitra/shared';
import type { ClerkCoreIds } from './clerk-core.js';

/**
 * The three documents that make up one user's Clerk core — the `Clerk`
 * project, its no-source placeholder repository, and its evidence policy —
 * built the same way by both provisioning paths:
 * `scripts/setup-clerk-core.ts` (the administrative CLI) and
 * `ProvisionClerkCoreService` (the self-service route). Extracted here so
 * neither has to redefine the document shape; only the id derivation stays
 * duplicated on purpose (see `clerk-core.ts`'s own doc comment) — that is a
 * separate, already-pinned convention this module does not touch.
 *
 * Getting this shape wrong is the exact failure mode the demo seed script
 * and `seed-demo-data.ts` hit: they write `EvidencePolicy.rules` track-first,
 * which `CompletenessEvaluator.getEffectivePolicy` (risk-first) silently
 * misses, falling back to defaults that demand evidence a Clerk task never
 * produces. `CLERK_POLICY_RULES` below is risk-first and is the only place
 * that shape is defined.
 */

export const CLERK_PROJECT_NAME = 'Clerk';
export const CLERK_PROJECT_DESCRIPTION = 'Private project for Clerk assistant tasks.';
export const CLERK_REPOSITORY_NAME = 'clerk-no-source-repository-placeholder';
export const CLERK_REPOSITORY_URL = 'https://clerk-placeholder.invalid/no-source-repository';

/**
 * Risk-first, track-second: `rules[risk_level][validation_track]`, the shape
 * `CompletenessEvaluator.getEffectivePolicy` indexes. Populates `direct` at
 * both `low` (the risk level `AssistantIntakeService` sets today) and
 * `medium` (so a future reclassification of Clerk tasks does not silently
 * fall through to the built-in defaults, which require `ci_result` /
 * `unit_test_result` evidence a Clerk task never produces). Four-eyes is off
 * and self-approval is on: a Clerk project's membership is the requesting
 * user alone, so nobody else could ever act as the second pair of eyes.
 */
export const CLERK_POLICY_RULES = {
  low: {
    direct: {
      required_evidence_types: ['task_result'],
      optional_evidence_types: [],
      four_eyes_required: false,
      allow_self_approval: true,
    },
  },
  medium: {
    direct: {
      required_evidence_types: ['task_result'],
      optional_evidence_types: [],
      four_eyes_required: false,
      allow_self_approval: true,
    },
  },
} satisfies EvidencePolicyRulesMap;

/**
 * The `Project` document for one user's Clerk core, as it should look the
 * moment it is first created.
 *
 * Membership is the caller alone — no reviewer pool, no tech leads. Case
 * visibility in Arbitra IS project membership, and there is nothing
 * narrower; a shared assistant project would expose one user's task content
 * to every other member.
 */
export function buildClerkProject(ids: ClerkCoreIds, userId: string, now: string): Project {
  return {
    project_id: ids.projectId,
    name: CLERK_PROJECT_NAME,
    description: CLERK_PROJECT_DESCRIPTION,
    owner_user_id: userId,
    members: [userId],
    reviewer_pool: [],
    tech_leads: [],
    default_evidence_policy_id: ids.policyId,
    default_rule_set_refs: [],
    default_validation_track: 'direct',
    created_at: now,
    updated_at: now,
  };
}

/** The placeholder `Repository` document for one user's Clerk core. */
export function buildClerkRepository(ids: ClerkCoreIds, now: string): Repository {
  return {
    repository_id: ids.repositoryId,
    project_id: ids.projectId,
    name: CLERK_REPOSITORY_NAME,
    url: CLERK_REPOSITORY_URL,
    provider: 'other',
    created_at: now,
    updated_at: now,
  };
}

/** The `EvidencePolicy` document for one user's Clerk core, at version 1. */
export function buildClerkEvidencePolicy(ids: ClerkCoreIds, now: string): EvidencePolicy {
  return {
    policy_id: ids.policyId,
    project_id: ids.projectId,
    rules: CLERK_POLICY_RULES,
    version: 1,
    created_at: now,
    updated_at: now,
  };
}
