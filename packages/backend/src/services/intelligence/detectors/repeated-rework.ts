import { THRESHOLDS } from '../config.js';
import { buildSignature } from '../detector-types.js';
import type { Detector, DetectionResult, DetectorContext } from '../detector-types.js';

const ID = 'repeated-rework';

/**
 * Detector 4 — cases where `request_changes` fired ≥ N times. Strong signal
 * the brief is unclear or a rule isn't tight enough; the nudge suggests
 * creating a knowledge asset for the recurring pattern.
 *
 * Scope: we look at non-terminal cases only. A case that churned 5 times then
 * reached `done` doesn't benefit from a reopen-the-wound nudge — the insight
 * lives in the audit trail already.
 */
export const repeatedReworkDetector: Detector = {
  id: ID,
  name: 'Repeated rework',
  description: 'Flags non-terminal cases that have accumulated excessive request_changes events.',
  async run(ctx: DetectorContext): Promise<DetectionResult[]> {
    const results: DetectionResult[] = [];
    const threshold = THRESHOLDS.repeated_rework_count;

    for await (const c of ctx.listNonTerminalCases()) {
      const count = await ctx.countRequestChanges(c.case_id);
      if (count < threshold) continue;

      const sig = buildSignature(ID, 'case', c.case_id);
      // Defense-in-depth: skip cases already flagged by this detector.
      if ((c.intelligence_flags ?? []).some((f) => f.signature === sig)) continue;

      results.push({
        detector_id: ID,
        signature: sig,
        target_kind: 'case',
        target_id: c.case_id,
        title: `Bounced back ${count}× — brief may be unclear: ${truncate(c.title)}`,
        summary:
          `Case was sent back ${count}× (threshold: ${threshold}×). ` +
          `The brief may be unclear or a rule needs tightening. ` +
          `Consider creating a knowledge asset to capture the recurring pattern.`,
        evidence: {
          case_id: c.case_id,
          status: c.status,
          request_changes_count: count,
          threshold_count: threshold,
        },
        severity: 'medium',
        project_id: c.project_id,
        repository_id: c.repository_id,
        suggested_owner: c.owner_user_id || undefined,
      });
    }

    return results;
  },
};

function truncate(s: string, n = 60): string {
  if (!s) return '(untitled)';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
