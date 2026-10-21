import type { Rule, RuleResult, Case, Evidence, EvaluationMode, Finding } from '@arbitra/shared';
import { RuleRepository } from './rule-repository.js';
import { resolveRuleLayers } from './layering.js';
import { detectConflicts, computeRuleConflictSignature, type RuleConflict } from './conflict-detector.js';
import { EventService } from '../event/event-service.js';
import { generateId, deriveFindingId } from '../../lib/ids.js';
import { collections } from '../../lib/firestore.js';
import { persistFinding } from '../../lib/finding-idempotency.js';
import type { RuleRunner, RunnerContext } from './runners/runner-interface.js';
import { MetadataCheckRunner } from './runners/metadata-check-runner.js';
import { DiffPatternRunner } from './runners/diff-pattern-runner.js';
import { EvidenceCheckRunner } from './runners/evidence-check-runner.js';
import { LlmEvaluationRunner } from './runners/llm-evaluation-runner.js';
import { HumanConfirmationRunner } from './runners/human-confirmation-runner.js';

const runners: Record<EvaluationMode, RuleRunner> = {
  metadata_check: new MetadataCheckRunner(),
  diff_pattern: new DiffPatternRunner(),
  evidence_check: new EvidenceCheckRunner(),
  llm_evaluation: new LlmEvaluationRunner(),
  human_confirmation: new HumanConfirmationRunner(),
};

export class RuleService {
  constructor(
    private readonly ruleRepo = new RuleRepository(),
    private readonly eventService = new EventService(),
  ) {}

  async evaluateRulesForCase(
    case_: Case,
    evidence: Evidence[],
    runId: string,
    actorId: string,
    diff?: string,
  ): Promise<RuleResult[]> {
    // Get all active rules for this project
    const allRules = await this.ruleRepo.getActiveRulesForProject(case_.project_id);

    // Resolve layering (project > global)
    const effectiveRules = resolveRuleLayers(allRules);

    // Detect conflicts for findings
    const conflicts = detectConflicts(allRules);

    // Persist conflicts as `rule_override_conflict` Findings — previously
    // these were computed then discarded (only `conflicts.length` was ever
    // surfaced), leaving the "no unconfirmed rule_override_conflict findings"
    // precondition permanently vacuous. Idempotent across recomputes: see
    // `persistConflictFindings`.
    const conflictStats = await this.persistConflictFindings(case_.case_id, conflicts);

    const ctx: RunnerContext = { case_, evidence, diff };
    const results: RuleResult[] = [];

    for (const rule of effectiveRules) {
      const runner = runners[rule.evaluation_mode];
      if (!runner) {
        // Unknown evaluation mode — not_applicable per spec
        results.push(this.createResult(rule, case_.case_id, runId, {
          result_status: 'not_applicable',
          message: `Unknown evaluation mode: ${rule.evaluation_mode}`,
          evidence_refs: [],
        }));
        continue;
      }

      const runnerResult = await runner.evaluate(rule, ctx);
      const ruleResult = this.createResult(rule, case_.case_id, runId, runnerResult);
      await this.ruleRepo.saveRuleResult(ruleResult);
      results.push(ruleResult);
    }

    await this.eventService.emit(
      case_.case_id,
      'rule_results_attached',
      {
        run_id: runId,
        rule_count: results.length,
        conflicts: conflicts.length,
        conflict_findings_created: conflictStats.created,
        conflict_findings_resolved: conflictStats.resolved,
      },
      actorId,
    );

    return results;
  }

  async getRuleResultsForCase(caseId: string): Promise<RuleResult[]> {
    return this.ruleRepo.getRuleResultsByCaseId(caseId);
  }

  /**
   * Reconciles detected `RuleConflict`s against persisted `rule_override_conflict`
   * Findings for this case:
   *   - a conflict with no existing non-terminal finding gets a new one created
   *     (status `open`, both rule ids in `rule_refs`, deterministic `signature`);
   *   - an existing `open` conflict finding whose signature no longer appears in
   *     the current conflict set (the rule was edited/deactivated so the clash
   *     no longer exists) is auto-resolved.
   *
   * Idempotent: every rule evaluation run recomputes `allRules` and re-derives
   * conflicts from scratch, so this runs on every run. The signature-based
   * check-before-create (mirroring `review-service.ts`'s dedup against
   * `Finding.signature`) means re-running never spams duplicate findings for
   * a conflict that's still active.
   *
   * Concurrency (issue #739): the check-before-create above is not itself
   * atomic — two `evaluateRulesForCase` runs racing on the same case can both
   * read `existingFindings` before either has written and both conclude "no
   * finding for this signature yet". Uniqueness is therefore enforced at the
   * storage layer, not just in this read-then-write check: each finding's id
   * is `deriveFindingId(signature)` (deterministic), and it is written via
   * `persistFinding`, a create-only transactional write — the losing run's
   * `tx.get` observes the doc the winner already committed and no-ops
   * instead of duplicating. See `lib/finding-idempotency.ts`.
   *
   * `rule_refs` ordering is a deliberate convention consumed by
   * `rule-override-service.ts` / the courtroom "Confirm Override" flow:
   * index 0 is the shadowed global rule, index 1 is the shadowing project rule.
   */
  private async persistConflictFindings(
    caseId: string,
    conflicts: RuleConflict[],
  ): Promise<{ created: number; resolved: number }> {
    const [existingSnap, overridesSnap] = await Promise.all([
      collections.findings()
        .where('case_id', '==', caseId)
        .where('category', '==', 'rule_override_conflict')
        .get(),
      collections.ruleOverrides().get(),
    ]);
    const existingFindings = existingSnap.docs.map((doc) => doc.data());

    // A confirmed RuleOverride permanently settles a rule pair (until the
    // override is superseded — out of scope, see roadmap #18): drop those
    // conflicts from consideration entirely so a re-run neither re-creates
    // the finding nor leaves it stuck `open`. Any stray `open` finding for an
    // already-overridden pair falls through to the auto-resolve loop below
    // exactly like a conflict that stopped existing.
    const overriddenPairs = new Set(
      overridesSnap.docs.map((doc) => {
        const o = doc.data();
        return [o.rule_id, o.overriding_rule_id].sort().join('|');
      }),
    );
    const activeConflicts = conflicts.filter(
      (c) => !overriddenPairs.has([c.globalRule.rule_id, c.projectRule.rule_id].sort().join('|')),
    );

    const activeSignatures = new Set(
      existingFindings
        .filter((f) => f.signature && f.status !== 'resolved' && f.status !== 'fixed')
        .map((f) => f.signature!),
    );

    const now = new Date().toISOString();
    let created = 0;
    const currentSignatures = new Set<string>();

    for (const conflict of activeConflicts) {
      const signature = computeRuleConflictSignature(caseId, conflict);
      currentSignatures.add(signature);
      if (activeSignatures.has(signature)) continue; // already an open finding for this pair

      // rule_override_conflict gates via its own dedicated precondition (see
      // preconditions.ts), not the high/critical severity gate — keep the
      // finding at low/medium so it doesn't ALSO trip the author-blocking
      // high/critical check (that would double-gate the same fact).
      const severity = conflict.severity === 'high' ? 'medium' : 'low';

      const finding: Finding = {
        finding_id: deriveFindingId(signature),
        case_id: caseId,
        category: 'rule_override_conflict',
        severity,
        confidence: 1,
        status: 'open',
        title: `Rule override conflict: ${conflict.projectRule.name}`,
        description: `Project rule "${conflict.projectRule.name}" (${conflict.projectRule.rule_id}) shadows global rule "${conflict.globalRule.name}" (${conflict.globalRule.rule_id}) in category "${conflict.projectRule.category}". Confirm an override with a rationale to resolve.`,
        origin_type: 'rule_engine',
        source_refs: [],
        evidence_refs: [],
        rule_refs: [conflict.globalRule.rule_id, conflict.projectRule.rule_id],
        signature,
        created_at: now,
        updated_at: now,
      };
      // Create-only transactional write keyed by the deterministic id above —
      // a racing concurrent run computing the same signature no-ops here
      // instead of inserting a second doc (issue #739). `reactivated` counts
      // as `created` for this run's stats: either way a conflict finding that
      // wasn't open a moment ago is open now.
      const outcome = await persistFinding(finding);
      if (outcome === 'created' || outcome === 'reactivated') created++;
    }

    let resolved = 0;
    for (const f of existingFindings) {
      if (f.status !== 'open') continue;
      if (f.signature && currentSignatures.has(f.signature)) continue; // conflict still active
      await collections.findings().doc(f.finding_id).update({
        status: 'resolved',
        resolution: 'Rule conflict no longer detected (a rule was edited, deactivated, or removed).',
        updated_at: now,
      });
      resolved++;
    }

    return { created, resolved };
  }

  private createResult(
    rule: Rule,
    caseId: string,
    runId: string,
    result: { result_status: RuleResult['result_status']; message: string; evidence_refs: string[] },
  ): RuleResult {
    return {
      rule_result_id: generateId('ruleResult'),
      rule_id: rule.rule_id,
      case_id: caseId,
      run_id: runId,
      result_status: result.result_status,
      message: result.message,
      evidence_refs: result.evidence_refs,
      evaluated_at: new Date().toISOString(),
    };
  }
}
