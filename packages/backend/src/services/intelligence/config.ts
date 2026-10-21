/**
 * Thresholds for the Arbitra Code Intelligence V1 detectors.
 *
 * V1 ships these as constants (no runtime UI to tune them). Change the value,
 * restart the scheduler.
 */
export const THRESHOLDS = {
  /** Cases parked in `pending_merge` longer than this fire detector 1. */
  aging_pending_merge_days: 7,
  /** Non-terminal cases with no activity for this long fire detector 2. */
  stale_open_days: 7,
  /** Remote branches untouched for this long and not linked to any case fire detector 3. */
  orphan_branch_days: 30,
  /** Minimum `request_changes` count (inclusive) that fires detector 4. */
  repeated_rework_count: 3,
  /** Minimum distinct approvers required on `done` high-risk cases. */
  high_risk_min_approvers: 2,
} as const;

/** System actor identity attached to every case/event/evidence written by the intelligence scheduler. */
export const INTELLIGENCE_ACTOR_ID = 'system:arbitra-intelligence';

/** `client_name` on ActorMetadata for intelligence-authored records. */
export const INTELLIGENCE_CLIENT_NAME = 'arbitra-intelligence';
