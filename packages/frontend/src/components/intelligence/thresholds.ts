/**
 * Per-detector display labels for the thresholds that gate each V1 detector.
 *
 * Thresholds live as constants in `packages/backend/src/services/intelligence/
 * config.ts` (`THRESHOLDS`) — there is no runtime UI to change them, so the
 * drill-down reads them straight from there without a round-trip.
 *
 * We duplicate the numeric values here instead of importing the backend
 * module so the frontend bundle stays free of backend code. Any detector
 * threshold change is a deliberate coordinated edit across both files — the
 * backend remains the source of truth at runtime; this table only drives
 * display. A stale value here would misinform an admin but would NOT affect
 * detection behavior.
 */

/**
 * Mirror of `THRESHOLDS` in
 * `packages/backend/src/services/intelligence/config.ts`. Keep in sync when
 * editing the backend constant.
 */
const DISPLAY_THRESHOLDS = {
  aging_pending_merge_days: 7,
  stale_open_days: 7,
  orphan_branch_days: 30,
  repeated_rework_count: 3,
  high_risk_min_approvers: 2,
} as const;

export interface ThresholdRow {
  label: string;
  value: string;
}

export function detectorThresholds(detectorId: string): ThresholdRow[] {
  switch (detectorId) {
    case 'aging-pending-merge':
      return [
        {
          label: 'Max days in pending_merge',
          value: `${DISPLAY_THRESHOLDS.aging_pending_merge_days} days`,
        },
      ];
    case 'stale-open':
      return [
        {
          label: 'Max days without activity',
          value: `${DISPLAY_THRESHOLDS.stale_open_days} days`,
        },
      ];
    case 'orphan-branch':
      return [
        {
          label: 'Branch inactivity threshold',
          value: `${DISPLAY_THRESHOLDS.orphan_branch_days} days`,
        },
      ];
    case 'repeated-rework':
      return [
        {
          label: 'Min request_changes events',
          value: `${DISPLAY_THRESHOLDS.repeated_rework_count}`,
        },
      ];
    case 'high-risk-without-four-eyes':
      return [
        {
          label: 'Min distinct approvers on done high-risk cases',
          value: `${DISPLAY_THRESHOLDS.high_risk_min_approvers}`,
        },
      ];
    default:
      return [];
  }
}
