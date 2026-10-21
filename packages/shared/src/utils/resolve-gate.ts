import type { GateId, LifecycleProfile, GateBehavior } from '../types/lifecycle-profile.js';
import { LIFECYCLE_PRESETS } from '../constants/lifecycle-presets.js';

export function resolveGateBehavior(
  gateId: GateId,
  profile?: LifecycleProfile,
): GateBehavior {
  // 1. Per-gate override on the project
  if (profile?.overrides?.[gateId]) {
    return profile.overrides[gateId]!;
  }
  // 2. Preset default
  if (profile?.preset) {
    return LIFECYCLE_PRESETS[profile.preset][gateId] ?? 'auto';
  }
  // 3. System default (Standard)
  return LIFECYCLE_PRESETS['standard'][gateId] ?? 'auto';
}
