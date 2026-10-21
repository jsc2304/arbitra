import { THRESHOLDS } from '../config.js';
import { buildSignature } from '../detector-types.js';
import type { Detector, DetectionResult, DetectorContext } from '../detector-types.js';

const ID = 'stale-open';

/**
 * Detector 2 — non-terminal cases with no activity in the window.
 *
 * "Activity" = any case_event. The activity feed already treats the events
 * collection as the master timeline (it's what populates `/activity`), so
 * reusing the same source keeps "silent case" semantics consistent across the
 * product.
 *
 * Skips `pending_merge` because Detector 1 owns that state — we don't want two
 * nudges on the same case.
 */
export const staleOpenDetector: Detector = {
  id: ID,
  name: 'Stale open case',
  description: 'Flags non-terminal cases with no activity past the stale-open threshold.',
  async run(ctx: DetectorContext): Promise<DetectionResult[]> {
    const results: DetectionResult[] = [];
    const cutoffMs = ctx.now.getTime() - THRESHOLDS.stale_open_days * 86_400_000;

    for await (const c of ctx.listNonTerminalCases()) {
      if (c.status === 'pending_merge') continue;

      const lastActivity = (await ctx.getLatestActivityAt(c.case_id)) ?? c.updated_at;
      const lastMs = Date.parse(lastActivity);
      if (!Number.isFinite(lastMs)) continue;
      if (lastMs > cutoffMs) continue;

      const sig = buildSignature(ID, 'case', c.case_id);
      // Defense-in-depth: skip cases already flagged by this detector. Stops the
      // pre-Phase-1 recursion ("Idle for 7d: Idle for 7d: ...") at the source.
      if ((c.intelligence_flags ?? []).some((f) => f.signature === sig)) continue;

      const days = Math.floor((ctx.now.getTime() - lastMs) / 86_400_000);
      results.push({
        detector_id: ID,
        signature: sig,
        target_kind: 'case',
        target_id: c.case_id,
        title: `Idle for ${days}d: ${truncate(c.title)}`,
        summary:
          `No activity for ${days}d (threshold: ${THRESHOLDS.stale_open_days}d). ` +
          `Clarify status, continue the work, or close.`,
        evidence: {
          case_id: c.case_id,
          status: c.status,
          last_activity_at: lastActivity,
          days_idle: days,
          threshold_days: THRESHOLDS.stale_open_days,
        },
        severity: 'low',
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
