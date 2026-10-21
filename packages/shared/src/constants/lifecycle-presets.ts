import type { GateConfig, LifecyclePresetId } from '../types/lifecycle-profile.js';

export const LIFECYCLE_PRESETS: Record<LifecyclePresetId, Required<GateConfig>> = {
  autonomous: {
    exploration_to_ready:      'auto',
    ready_to_build:            'auto',
    build_to_validation:       'auto',
    validation_to_review:      'auto',
    review_to_approved:        'auto',
    review_to_needs_human:     'auto',
    review_to_verification:    'auto',
    approved_to_pending_merge: 'auto',
    pending_merge_to_done:     'auto',
  },
  standard: {
    exploration_to_ready:      'auto',
    ready_to_build:            'confirm',
    build_to_validation:       'auto',
    validation_to_review:      'auto',
    review_to_approved:        'auto',
    review_to_needs_human:     'auto',
    review_to_verification:    'auto',
    approved_to_pending_merge: 'auto',
    pending_merge_to_done:     'auto',
  },
  strict: {
    exploration_to_ready:      'confirm',
    ready_to_build:            'confirm',
    build_to_validation:       'confirm',
    validation_to_review:      'confirm',
    review_to_approved:        'confirm',
    review_to_needs_human:     'auto',
    review_to_verification:    'auto',
    approved_to_pending_merge: 'confirm',
    pending_merge_to_done:     'auto',
  },
};
