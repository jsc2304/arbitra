import { THRESHOLDS } from '../config.js';
import { buildSignature } from '../detector-types.js';
import type { Detector, DetectionResult, DetectorContext } from '../detector-types.js';

const ID = 'high-risk-without-four-eyes';
const APPROVE_DECISION_TYPES = new Set(['approve', 'auto_approve']);

/**
 * Detector 5 — backward scan across `done` cases with risk ∈ {high, critical}.
 * Flags any such case where fewer than N distinct human approvers signed off.
 *
 * This is an audit detector, not a workflow nudge. It exists to catch policy
 * drift — e.g. a project that accidentally has `allow_self_approval = true`
 * on a high-risk cell, or a missed four-eyes check that slipped past the
 * gate. The nudge directs the reviewer to either post-hoc verify or
 * adjust policy.
 *
 * Approver counting:
 *   - Only `approve` and `auto_approve` decisions count.
 *   - Actor IDs starting with `system:` are excluded (they are not independent
 *     human approvers — `auto_approve` by the system isn't four-eyes).
 *   - Distinctness is computed on `actor_user_id`.
 */
export const highRiskWithoutFourEyesDetector: Detector = {
  id: ID,
  name: 'High-risk without four-eyes',
  description: 'Flags done high-risk cases that lack the required number of distinct human approvers.',
  async run(ctx: DetectorContext): Promise<DetectionResult[]> {
    const results: DetectionResult[] = [];
    const minApprovers = THRESHOLDS.high_risk_min_approvers;

    for await (const c of ctx.listAllCases()) {
      if (c.status !== 'done') continue;
      if (c.risk_level !== 'high' && c.risk_level !== 'critical') continue;

      const decisions = await ctx.getDecisionsForCase(c.case_id);
      const approverIds = new Set<string>();
      for (const d of decisions) {
        if (!APPROVE_DECISION_TYPES.has(d.type)) continue;
        if (!d.actor_id || d.actor_id.startsWith('system:')) continue;
        approverIds.add(d.actor_id);
      }
      if (approverIds.size >= minApprovers) continue;

      const sig = buildSignature(ID, 'case', c.case_id);
      // Defense-in-depth: skip cases already flagged by this detector.
      if ((c.intelligence_flags ?? []).some((f) => f.signature === sig)) continue;

      results.push({
        detector_id: ID,
        signature: sig,
        target_kind: 'case',
        target_id: c.case_id,
        title: `Missing four-eyes on: ${truncate(c.title)}`,
        summary:
          `Risk is \`${c.risk_level}\` on a done case with ${approverIds.size} independent approver(s) ` +
          `(minimum: ${minApprovers}). Post-hoc verify the decision or adjust the evidence policy to ` +
          `require four-eyes for this risk level.`,
        evidence: {
          case_id: c.case_id,
          status: c.status,
          risk_level: c.risk_level,
          approver_count: approverIds.size,
          approver_ids: [...approverIds],
          min_approvers: minApprovers,
        },
        severity: 'medium',
        project_id: c.project_id,
        repository_id: c.repository_id,
      });
    }

    return results;
  },
};

function truncate(s: string, n = 60): string {
  if (!s) return '(untitled)';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
