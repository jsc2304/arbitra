import crypto from 'node:crypto';
import type { Rule } from '@arbitra/shared';

export interface RuleConflict {
  globalRule: Rule;
  projectRule: Rule;
  severity: 'medium' | 'high';
}

/**
 * Deterministic identity for a detected conflict, scoped to the case it was
 * found in. Used by `RuleService` to dedupe `rule_override_conflict` Finding
 * creation across recomputes (every rule evaluation run recomputes conflicts
 * from scratch) — the same rule pair on the same case always hashes to the
 * same signature regardless of which rule is passed first, so recomputation
 * check-before-creates instead of spamming duplicate findings. Mirrors the
 * `computeFindingSignature` pattern in `review/finding-signature.ts`.
 */
export function computeRuleConflictSignature(caseId: string, conflict: RuleConflict): string {
  const ruleIds = [conflict.globalRule.rule_id, conflict.projectRule.rule_id].sort();
  const input = ['rule_override_conflict', caseId, ...ruleIds].join('|');
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Detects cross-layer contradictions between project and global rules.
 * Returns conflicts that should generate rule_override_conflict findings.
 */
export function detectConflicts(rules: Rule[]): RuleConflict[] {
  const globalRules = rules.filter((r) => r.scope.layer === 'global');
  const projectRules = rules.filter((r) => r.scope.layer === 'project');

  const conflicts: RuleConflict[] = [];

  for (const projectRule of projectRules) {
    const matchingGlobal = globalRules.find(
      (g) => g.category === projectRule.category && g.name === projectRule.name,
    );

    if (matchingGlobal) {
      // Determine severity: security/architecture rules get high, others medium
      const isHighSeverity =
        matchingGlobal.category === 'security_rule' ||
        matchingGlobal.category === 'architecture_rule';

      conflicts.push({
        globalRule: matchingGlobal,
        projectRule,
        severity: isHighSeverity ? 'high' : 'medium',
      });
    }
  }

  return conflicts;
}
