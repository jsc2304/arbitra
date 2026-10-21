import type { CaseStatus } from '../types/case.js';
import type { GateId } from '../types/lifecycle-profile.js';

export const GATE_TRANSITION_MAP: Record<GateId, { from: CaseStatus; to: CaseStatus }> = {
  exploration_to_ready:       { from: 'exploration',       to: 'ready_for_build' },
  ready_to_build:             { from: 'ready_for_build',   to: 'in_build' },
  build_to_validation:        { from: 'in_build',          to: 'in_validation' },
  validation_to_review:       { from: 'in_validation',     to: 'in_review' },
  review_to_approved:         { from: 'in_review',         to: 'approved' },
  review_to_needs_human:      { from: 'in_review',         to: 'needs_human_decision' },
  review_to_verification:     { from: 'in_review',         to: 'verification_pending' },
  approved_to_pending_merge:  { from: 'approved',          to: 'pending_merge' },
  pending_merge_to_done:      { from: 'pending_merge',     to: 'done' },
};

export function findGateId(from: CaseStatus, to: CaseStatus): GateId | null {
  for (const [gateId, mapping] of Object.entries(GATE_TRANSITION_MAP)) {
    if (mapping.from === from && mapping.to === to) {
      return gateId as GateId;
    }
  }
  return null;
}
