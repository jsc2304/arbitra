import type { Rule, RuleSet, RuleResult } from '@arbitra/shared';
import { NotFoundError } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';

export class RuleRepository {
  async getRuleById(ruleId: string): Promise<Rule> {
    const doc = await collections.rules().doc(ruleId).get();
    if (!doc.exists) throw new NotFoundError('Rule', ruleId);
    return doc.data()!;
  }

  async getRuleSetById(ruleSetId: string): Promise<RuleSet> {
    const doc = await collections.ruleSets().doc(ruleSetId).get();
    if (!doc.exists) throw new NotFoundError('RuleSet', ruleSetId);
    return doc.data()!;
  }

  async getRulesByIds(ruleIds: string[]): Promise<Rule[]> {
    if (ruleIds.length === 0) return [];
    const rules: Rule[] = [];
    for (const id of ruleIds) {
      try {
        rules.push(await this.getRuleById(id));
      } catch {
        // Skip missing rules
      }
    }
    return rules;
  }

  async getActiveRulesForProject(projectId: string): Promise<Rule[]> {
    const snapshot = await collections.rules()
      .where('status', '==', 'active')
      .get();

    return snapshot.docs
      .map((doc) => doc.data())
      .filter(
        (rule) =>
          rule.scope.layer === 'global' ||
          (rule.scope.layer === 'project' && rule.scope.ref === projectId),
      );
  }

  async saveRuleResult(result: RuleResult): Promise<RuleResult> {
    await collections.ruleResults().doc(result.rule_result_id).set(result);
    return result;
  }

  /**
   * Apply a partial update to an existing RuleResult (e.g. flipping a
   * `blocked` `human_confirmation` result to `pass` when a `gate_confirmed`
   * decision resolves it — see `DecisionService`). Unlike `saveRuleResult`,
   * which always writes a full record, this only patches the given fields.
   */
  async updateRuleResult(
    resultId: string,
    patch: Partial<Omit<RuleResult, 'rule_result_id'>>,
  ): Promise<RuleResult> {
    const ref = collections.ruleResults().doc(resultId);
    const doc = await ref.get();
    if (!doc.exists) throw new NotFoundError('RuleResult', resultId);
    await ref.update(patch);
    return { ...doc.data()!, ...patch };
  }

  async getRuleResultsByCaseId(caseId: string): Promise<RuleResult[]> {
    const snapshot = await collections.ruleResults()
      .where('case_id', '==', caseId)
      .get();
    return snapshot.docs.map((doc) => doc.data());
  }

  /**
   * RuleResults for a specific case+rule pair, across all runs/iterations.
   * Used to resolve a blocked `human_confirmation` RuleResult when a
   * `gate_confirmed`/`gate_rejected` decision references the rule.
   */
  async getRuleResultsByCaseAndRule(caseId: string, ruleId: string): Promise<RuleResult[]> {
    const snapshot = await collections.ruleResults()
      .where('case_id', '==', caseId)
      .where('rule_id', '==', ruleId)
      .get();
    return snapshot.docs.map((doc) => doc.data());
  }

  async createRule(rule: Rule): Promise<Rule> {
    await collections.rules().doc(rule.rule_id).set(rule);
    return rule;
  }
}
