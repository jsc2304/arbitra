import type { RuleOverride, CreateRuleOverrideInput, Finding } from '@arbitra/shared';
import { ValidationError } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';
import { generateId } from '../../lib/ids.js';
import { RuleRepository } from './rule-repository.js';
import { EventService } from '../event/event-service.js';

/**
 * Creates and reads `RuleOverride` records — the human-confirmed resolution
 * path for a `RuleConflict` detected by `conflict-detector.ts`. A
 * conflict is surfaced as an `open` `rule_override_conflict` Finding by
 * `RuleService.evaluateRulesForCase`; creating an override here resolves the
 * matching finding(s) and records the decision permanently (future rule
 * evaluations skip already-overridden pairs — see `RuleService`'s
 * `overriddenPairs` filter).
 *
 * Resolution lives HERE rather than in `DecisionService` on purpose: a rule
 * override is not a case decision (it has no `case_id` of its own — the same
 * override can settle the same rule pair across many cases), so it does not
 * fit the `Decision` model. Keeping the resolution logic co-located with
 * override creation also means `DecisionService` does not need touching.
 */
export class RuleOverrideService {
  constructor(
    private readonly ruleRepo = new RuleRepository(),
    private readonly eventService = new EventService(),
  ) {}

  async createOverride(
    input: CreateRuleOverrideInput,
    actorId: string,
  ): Promise<RuleOverride> {
    // Defense in depth: the route's Zod schema already enforces this, but the
    // service is also callable directly (tests, future MCP tooling) so the
    // "mandatory rationale" rule must hold at this layer too.
    if (!input.rationale || !input.rationale.trim()) {
      throw new ValidationError('rationale is required to create a rule override');
    }
    if (input.rule_id === input.overriding_rule_id) {
      throw new ValidationError('rule_id and overriding_rule_id must reference different rules');
    }

    // Snapshot both rules' current versions onto the override for audit —
    // mirrors the decision-snapshot governance fix: if either rule is
    // edited later, the override record still shows exactly which version
    // pair the human confirmed.
    const [rule, overridingRule] = await Promise.all([
      this.ruleRepo.getRuleById(input.rule_id),
      this.ruleRepo.getRuleById(input.overriding_rule_id),
    ]);

    const now = new Date().toISOString();
    const override: RuleOverride = {
      override_id: generateId('ruleOverride'),
      rule_id: input.rule_id,
      overriding_rule_id: input.overriding_rule_id,
      scope: input.scope,
      rationale: input.rationale,
      version: 1,
      rule_version: rule.version,
      overriding_rule_version: overridingRule.version,
      created_by: actorId,
      created_at: now,
    };

    await collections.ruleOverrides().doc(override.override_id).set(override);

    await this.resolveMatchingFindings(override, input.finding_id, actorId);

    return override;
  }

  async listOverrides(filter?: {
    rule_id?: string;
    overriding_rule_id?: string;
  }): Promise<RuleOverride[]> {
    const snapshot = await collections.ruleOverrides().get();
    let overrides = snapshot.docs.map((doc) => doc.data());
    if (filter?.rule_id) {
      overrides = overrides.filter(
        (o) => o.rule_id === filter.rule_id || o.overriding_rule_id === filter.rule_id,
      );
    }
    if (filter?.overriding_rule_id) {
      overrides = overrides.filter((o) => o.overriding_rule_id === filter.overriding_rule_id);
    }
    return overrides;
  }

  /**
   * Resolves every still-open `rule_override_conflict` Finding whose
   * `rule_refs` cover exactly this rule pair. An explicit `finding_id` (the
   * courtroom button already knows which finding it's confirming) is
   * resolved too, but ONLY if its `rule_refs` actually match this override's
   * pair — otherwise a caller could resolve an arbitrary open conflict
   * finding (a different rule pair, a different project's finding) just by
   * supplying its id. The rule-pair scan additionally catches the same
   * conflict re-detected on other cases, so one override settles it
   * everywhere, not just where the button happened to be clicked.
   */
  private async resolveMatchingFindings(
    override: RuleOverride,
    explicitFindingId: string | undefined,
    actorId: string,
  ): Promise<void> {
    const matches = new Map<string, Finding>();

    if (explicitFindingId) {
      const doc = await collections.findings().doc(explicitFindingId).get();
      if (doc.exists) {
        const finding = doc.data()!;
        // Same containment check as the rule-pair scan below: an explicit
        // finding_id must not let a caller resolve an arbitrary open
        // rule_override_conflict finding (e.g. from a different rule pair,
        // or a different tenant/project) just by knowing its id. A finding
        // whose rule_refs don't cover this exact pair is left untouched —
        // silent no-op, matching the other no-op branches here (missing
        // doc, wrong category, already-non-open status).
        if (
          finding.category === 'rule_override_conflict' &&
          finding.status === 'open' &&
          finding.rule_refs.includes(override.rule_id) &&
          finding.rule_refs.includes(override.overriding_rule_id)
        ) {
          matches.set(finding.finding_id, finding);
        }
      }
    }

    const openConflictsSnap = await collections.findings()
      .where('category', '==', 'rule_override_conflict')
      .where('status', '==', 'open')
      .get();
    for (const doc of openConflictsSnap.docs) {
      const finding = doc.data();
      if (
        finding.rule_refs.includes(override.rule_id) &&
        finding.rule_refs.includes(override.overriding_rule_id)
      ) {
        matches.set(finding.finding_id, finding);
      }
    }

    const now = new Date().toISOString();
    for (const finding of matches.values()) {
      await collections.findings().doc(finding.finding_id).update({
        status: 'resolved',
        resolution: `Resolved by rule override ${override.override_id}: ${override.rationale}`,
        updated_at: now,
      });
      await this.eventService.emit(
        finding.case_id,
        'rule_override_created',
        {
          override_id: override.override_id,
          rule_id: override.rule_id,
          overriding_rule_id: override.overriding_rule_id,
          finding_id: finding.finding_id,
        },
        actorId,
      );
    }
  }
}
