import type {
  Case,
  DecisionSnapshot,
  Evidence,
  EvidencePolicy,
  EvidencePolicyRule,
  EvidenceType,
  RiskLevel,
} from '@arbitra/shared';
import { getDefaultPolicyRule, isPolicyCellAuthored, resolveEscalationThreshold } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';
import { RuleRepository } from '../rule/rule-repository.js';
import { resolveRuleLayers } from '../rule/layering.js';

export interface CompletenessResult {
  satisfied: boolean;
  required: EvidenceType[];
  present: EvidenceType[];
  missing: EvidenceType[];
  optional_present: EvidenceType[];
  four_eyes_required: boolean;
  allow_self_approval: boolean;
}

export interface EffectivePolicyResolution {
  rule: EvidencePolicyRule;
  policy_id: string;
  version: number;
}

const BUILT_IN_POLICY_ID = 'built-in-default';
const BUILT_IN_POLICY_VERSION = 1;

export class CompletenessEvaluator {
  async evaluate(case_: Case, evidence: Evidence[]): Promise<CompletenessResult> {
    const policyRule = await this.getEffectivePolicyRule(case_);

    const presentTypes = new Set(evidence.map((e) => e.type));
    const required = policyRule.required_evidence_types;
    const present = required.filter((t) => presentTypes.has(t));
    const missing = required.filter((t) => !presentTypes.has(t));
    const optionalPresent = policyRule.optional_evidence_types.filter((t) =>
      presentTypes.has(t),
    );

    return {
      satisfied: missing.length === 0,
      required,
      present,
      missing,
      optional_present: optionalPresent,
      four_eyes_required: policyRule.four_eyes_required,
      allow_self_approval: policyRule.allow_self_approval,
    };
  }

  /**
   * Resolve the effective evidence-policy rule for a case (project-level policy
   * preferred, default-track fallback). Exposed so other services (e.g. the
   * Decision Service) can reuse the same resolution path when they need to
   * read a flag like `allow_self_approval` without re-evaluating completeness.
   */
  async getEffectivePolicyRule(case_: Case): Promise<EvidencePolicyRule> {
    return (await this.getEffectivePolicy(case_)).rule;
  }

  /**
   * Resolve the effective policy cell while retaining the parent policy's
   * identity and version for immutable decision snapshots.
   */
  async getEffectivePolicy(case_: Case): Promise<EffectivePolicyResolution> {
    const policy = await this.getCanonicalPolicyDocument(case_.project_id);

    if (policy) {
      // Stored shape is risk-first, track-second (see EvidencePolicyRulesMap
      // and edit-policy-modal.tsx). Indexing track-first silently misses every
      // cell → all customizations fall through to defaults. Do NOT swap.
      const riskRules = policy.rules[case_.risk_level];
      if (riskRules) {
        const trackRule = riskRules[case_.validation_track];
        // A cell only counts as an authored decision when `isPolicyCellAuthored`
        // says so — a non-empty required list, or an explicit
        // `requires_no_evidence: true`. A cell with an empty required list and
        // no flag (either a legacy document predating that field, or data
        // corruption) is NOT trusted verbatim: it is treated exactly like an
        // absent cell and falls through to the built-in defaults below. See
        // `classifyPolicyCell`'s doc-comment (packages/shared) for the full
        // reasoning — this is what stops an empty cell from silently
        // satisfying the evidence gate.
        if (trackRule && isPolicyCellAuthored(trackRule)) {
          return {
            rule: trackRule,
            policy_id: policy.policy_id,
            version: policy.version,
          };
        }
      }
    }

    // Built-in defaults are themselves a resolved, versioned policy source.
    // Keeping a stable id/version makes a fallback snapshot explicit instead
    // of conflating it with an arbitrary stored policy at version 1.
    return {
      rule: getDefaultPolicyRule(case_.validation_track, case_.risk_level),
      policy_id: BUILT_IN_POLICY_ID,
      version: BUILT_IN_POLICY_VERSION,
    };
  }

  /**
   * Resolve the effective Observed Case escalation threshold for a case's
   * project (issue #987 / ADR-0001): the project's `escalation.risk_threshold`
   * evidence-policy field when authored, else the built-in default. Reuses
   * the exact same canonical-policy resolution as `getEffectivePolicy` so an
   * escalation decision and an evidence-completeness decision never resolve
   * against two different policy documents for the same project.
   */
  async getEscalationThreshold(case_: Case): Promise<RiskLevel> {
    const policy = await this.getCanonicalPolicyDocument(case_.project_id);
    return resolveEscalationThreshold(policy ?? undefined);
  }

  /**
   * Fetch the canonical `EvidencePolicy` document for a project, or `null`
   * if the project has none. Shared read path for `getEffectivePolicy` and
   * `getEscalationThreshold` — see the doc-comment on the original inline
   * query (now here) for why this is a single unordered equality query
   * resolved deterministically in code rather than a server-side `orderBy`.
   */
  private async getCanonicalPolicyDocument(projectId: string): Promise<EvidencePolicy | null> {
    // Fetch ALL project-scoped policies in one equality query (no `orderBy`, so
    // no field-presence exclusion and no composite index needed), then pick the
    // canonical one deterministically in code. The per-project policy count is
    // tiny — ideally exactly one once #626 uniqueness enforcement lands — so
    // client-side selection is cheap.
    //
    // Determinism for ALL docs, including legacy ones missing `updated_at`:
    // a server-side `orderBy('updated_at')` silently drops docs lacking the
    // field, which is exactly the non-determinism #627 sets out to remove. We
    // instead sort on a coalesced recency key (`updated_at ?? created_at ?? ''`)
    // descending, with `policy_id` descending as a total-order tiebreaker so two
    // docs never resolve ambiguously. This makes the old unordered fallback
    // unnecessary — legacy docs resolve deterministically here.
    const policiesSnap = await collections.evidencePolicies()
      .where('project_id', '==', projectId)
      .get();

    if (policiesSnap.empty) return null;
    return pickCanonicalPolicy(policiesSnap.docs.map((d) => d.data()));
  }
}

/** Resolve the versions of the rule sets that contain the rules actually evaluated. */
export async function buildActiveRuleSetVersions(
  case_: Case,
  ruleRepository = new RuleRepository(),
): Promise<Record<string, number>> {
  const [allRules, ruleSetsSnap] = await Promise.all([
    // Keep this selection in lockstep with RuleService.evaluateRulesForCase:
    // the same repository query followed by the same layer resolver.
    ruleRepository.getActiveRulesForProject(case_.project_id),
    collections.ruleSets().get(),
  ]);
  const effectiveRuleIds = new Set(
    resolveRuleLayers(allRules).map((rule) => rule.rule_id),
  );

  const entries = ruleSetsSnap.docs
    .map((doc) => doc.data())
    .filter((ruleSet) =>
      ruleSet.status === 'active' &&
      (!ruleSet.project_id || ruleSet.project_id === case_.project_id) &&
      ruleSet.rule_refs.some((ruleId) => effectiveRuleIds.has(ruleId)),
    )
    .map((ruleSet) => [ruleSet.rule_set_id, ruleSet.version] as const);

  // Known limitation: PATCH edits to rule-set membership/status
  // and member-rule config do not yet bump RuleSet.version, so an exact
  // snapshot cannot distinguish those mid-governance edits until the tracked
  // governance-version bumping work lands.
  return Object.fromEntries(entries);
}

/** Build a governance snapshot whose values all come from resolved sources. */
export async function buildDecisionSnapshot(
  case_: Case,
  completenessEvaluator = new CompletenessEvaluator(),
  ruleRepository = new RuleRepository(),
  resolvedPolicy?: EffectivePolicyResolution,
): Promise<DecisionSnapshot> {
  const [effectivePolicy, activeRuleSetVersions] = await Promise.all([
    resolvedPolicy ?? completenessEvaluator.getEffectivePolicy(case_),
    buildActiveRuleSetVersions(case_, ruleRepository),
  ]);

  return {
    active_rule_set_versions: activeRuleSetVersions,
    evidence_policy_id: effectivePolicy.policy_id,
    evidence_policy_version: effectivePolicy.version,
    knowledge_asset_refs: case_.knowledge_context_refs,
    snapshot_fidelity: 'exact',
  };
}

/**
 * Deterministically select the canonical policy from a project's policy set.
 * Order: most-recent coalesced recency key first (`updated_at ?? created_at`),
 * then `policy_id` descending as a total-order tiebreaker so the result never
 * depends on Firestore's return order. Legacy docs missing `updated_at` (and
 * even `created_at`) collapse to an empty recency key but are still ordered
 * deterministically by `policy_id`. Callers must guard against an empty array.
 */
function pickCanonicalPolicy(policies: EvidencePolicy[]): EvidencePolicy {
  const recencyKey = (p: EvidencePolicy): string => p.updated_at || p.created_at || '';
  return [...policies].sort((a, b) => {
    const byRecency = recencyKey(b).localeCompare(recencyKey(a));
    if (byRecency !== 0) return byRecency;
    return (b.policy_id || '').localeCompare(a.policy_id || '');
  })[0]!;
}
