export type GateBehavior = 'auto' | 'confirm';

export type GateId =
  | 'exploration_to_ready'
  | 'ready_to_build'
  | 'build_to_validation'
  | 'validation_to_review'
  | 'review_to_approved'
  | 'review_to_needs_human'
  | 'review_to_verification'
  | 'approved_to_pending_merge'
  | 'pending_merge_to_done';

export type GateConfig = Partial<Record<GateId, GateBehavior>>;

export type LifecyclePresetId = 'autonomous' | 'standard' | 'strict';

export type GateConfirmerRole = 'reviewer' | 'tech_lead';

export interface LifecycleProfile {
  /** Selected preset. Provides defaults for all gates. */
  preset: LifecyclePresetId;
  /** Per-gate overrides. Takes precedence over the preset defaults. */
  overrides?: GateConfig;
  /** Roles allowed to confirm gates. Default: ['reviewer', 'tech_lead']. */
  gate_confirmer_roles?: GateConfirmerRole[];
}
