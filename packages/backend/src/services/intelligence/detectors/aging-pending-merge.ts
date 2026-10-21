import type { Case } from '@arbitra/shared';
import { THRESHOLDS } from '../config.js';
import { buildSignature } from '../detector-types.js';
import type { Detector, DetectionResult, DetectorContext } from '../detector-types.js';

const ID = 'aging-pending-merge';

/**
 * Detector 1 — cases stuck in `pending_merge` beyond the threshold.
 *
 * "Stuck" is measured from the latest event whose payload carries
 * `status === 'pending_merge'` (status transition into that state). Falls back
 * to `case.updated_at` when no transition event is found — which matches the
 * case-service's behavior of bumping `updated_at` on every status change.
 */
export const agingPendingMergeDetector: Detector = {
  id: ID,
  name: 'Aging pending merge',
  description: 'Flags cases parked in pending_merge beyond the configured threshold.',
  async run(ctx: DetectorContext): Promise<DetectionResult[]> {
    const results: DetectionResult[] = [];
    const cutoffMs = ctx.now.getTime() - THRESHOLDS.aging_pending_merge_days * 86_400_000;

    for await (const c of ctx.listNonTerminalCases()) {
      if (c.status !== 'pending_merge') continue;

      const transitionAt =
        (await ctx.getLatestStatusTransitionAt(c.case_id, 'pending_merge')) ?? c.updated_at;
      const transitionMs = Date.parse(transitionAt);
      if (!Number.isFinite(transitionMs)) continue;
      if (transitionMs > cutoffMs) continue;

      const sig = buildSignature(ID, 'case', c.case_id);
      // Defense-in-depth: skip cases already flagged by this detector. Service-layer
      // dedup also catches this via existingSignatures; the explicit check keeps intent local.
      if ((c.intelligence_flags ?? []).some((f) => f.signature === sig)) continue;

      const days = Math.floor((ctx.now.getTime() - transitionMs) / 86_400_000);
      results.push({
        detector_id: ID,
        signature: sig,
        target_kind: 'case',
        target_id: c.case_id,
        title: `PR still open after ${days}d: ${truncate(c.title)}`,
        summary:
          `Case has been in \`pending_merge\` for ${days}d (threshold: ${THRESHOLDS.aging_pending_merge_days}d). ` +
          `Please merge or send back to build.`,
        evidence: {
          case_id: c.case_id,
          status: c.status,
          pending_merge_since: transitionAt,
          days_in_status: days,
          threshold_days: THRESHOLDS.aging_pending_merge_days,
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

export function _testTruncate(s: string, n?: number): string {
  return truncate(s, n);
}

/** Exported case-type for unit tests that want to mock selectors inline. */
export type _CaseForTest = Case;
