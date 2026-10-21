import type { CaseStatus, CaseType } from '@arbitra/shared';
import { caseStatusLabelShort } from '../../lib/case-status-labels';
import {
  STAGE_BADGE_COLORS,
  isTerminalCaseStatus,
} from '../../lib/lifecycle-stages';
import { Badge } from './badge';

/* ── Fallbacks for unknown/off-list status strings ──────────────────────────
   StatusBadge historically accepts `status: string` (some callers pass
   audit/event statuses that aren't in CaseStatus), so we keep the neutral
   defaults here and short-circuit to the shared stage-colour map when the
   status is a known CaseStatus. */

// Fallback (unknown/off-list status) intentionally lighter than Done's gray
// pill (see STAGE_BADGE_COLORS.done). Both are gray but the fallback is the
// "ghost / unknown" tier (lighter bg, dashed-feel ring, italic-weight text)
// while Done is a deliberate terminal token (bg-gray-200, ring-gray-400).
// Follow-up #103: previously identical, which made any unknown status look
// like Done at a glance.
const FALLBACK_PILL =
  'bg-gray-50 text-gray-500 italic ring-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:ring-gray-700';
const FALLBACK_DOT = 'bg-gray-300 dark:bg-gray-600';

interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
  /**
   * Case type the status belongs to. When `'observed'`, the label honors
   * the Observed Case overrides (e.g. `in_build` → "Observing") instead of
   * the default engineering label — issue #1018. Optional and backward
   * compatible: every other case type (and every non-case caller of this
   * badge, e.g. assistant-thread turns) renders exactly as before.
   */
  caseType?: CaseType;
}

export function StatusBadge({ status, size = 'sm', caseType }: StatusBadgeProps) {
  const stageColors = (STAGE_BADGE_COLORS as Record<string, typeof STAGE_BADGE_COLORS[CaseStatus] | undefined>)[status];
  const pill = stageColors?.pill ?? FALLBACK_PILL;
  const dot = stageColors?.dot ?? FALLBACK_DOT;
  const label = stageColors ? caseStatusLabelShort(status as CaseStatus, caseType) : status;

  // Non-terminal cases share the tracker's heartbeat rhythm on the dot so the
  // pill visually links to the active lifecycle station. Terminal / unknown
  // statuses stay static (no pulse) and use the muted colour straight from
  // the shared stage map.
  const isKnownStage = stageColors !== undefined;
  const shouldPulse = isKnownStage && !isTerminalCaseStatus(status as CaseStatus);

  // The dot carries a per-status pulse animation (matched to the lifecycle
  // tracker's current station), so it's rendered via Badge's `icon` slot
  // rather than the plain `dot` boolean — same structural dot, but with the
  // pulse class attached. The animation lives in the `.status-dot-pulse` CSS
  // class (globals.css) so it can be gated behind `prefers-reduced-motion:
  // reduce` — reduced-motion users keep the dot visible but get no motion.
  const dotNode = (
    <span
      className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${dot}${shouldPulse ? ' status-dot-pulse' : ''}`}
      aria-hidden="true"
    />
  );

  return (
    <Badge size={size} tone="soft" colorClassName={pill} icon={dotNode}>
      {label}
    </Badge>
  );
}
