import { describe, it, expect } from 'vitest';
import { resolveGateBehavior } from '../utils/resolve-gate.js';
import { LIFECYCLE_PRESETS } from '../constants/lifecycle-presets.js';
import { findGateId, GATE_TRANSITION_MAP } from '../constants/lifecycle-gates.js';
import { lifecycleProfileSchema, gateConfigSchema } from '../validation/lifecycle-profile-validators.js';
import type { LifecycleProfile, GateId } from '../types/lifecycle-profile.js';

// ── resolveGateBehavior ─────────────────────────────────────────────

describe('resolveGateBehavior', () => {
  it('should fall back to Standard preset when no profile is provided', () => {
    expect(resolveGateBehavior('ready_to_build')).toBe('confirm');
    expect(resolveGateBehavior('exploration_to_ready')).toBe('auto');
  });

  it('should fall back to Standard preset when profile is undefined', () => {
    expect(resolveGateBehavior('ready_to_build', undefined)).toBe('confirm');
  });

  it('should use the preset defaults when no overrides are set', () => {
    const profile: LifecycleProfile = { preset: 'autonomous' };
    expect(resolveGateBehavior('ready_to_build', profile)).toBe('auto');
    expect(resolveGateBehavior('exploration_to_ready', profile)).toBe('auto');
  });

  it('should use strict preset defaults', () => {
    const profile: LifecycleProfile = { preset: 'strict' };
    expect(resolveGateBehavior('exploration_to_ready', profile)).toBe('confirm');
    expect(resolveGateBehavior('ready_to_build', profile)).toBe('confirm');
    expect(resolveGateBehavior('build_to_validation', profile)).toBe('confirm');
    expect(resolveGateBehavior('review_to_needs_human', profile)).toBe('auto');
    expect(resolveGateBehavior('pending_merge_to_done', profile)).toBe('auto');
  });

  it('should let overrides take precedence over preset', () => {
    const profile: LifecycleProfile = {
      preset: 'standard',
      overrides: { ready_to_build: 'auto' },
    };
    // Override changes confirm -> auto
    expect(resolveGateBehavior('ready_to_build', profile)).toBe('auto');
    // Non-overridden gate still uses preset
    expect(resolveGateBehavior('exploration_to_ready', profile)).toBe('auto');
  });

  it('should let overrides add confirmation to autonomous preset', () => {
    const profile: LifecycleProfile = {
      preset: 'autonomous',
      overrides: { review_to_approved: 'confirm' },
    };
    expect(resolveGateBehavior('review_to_approved', profile)).toBe('confirm');
    expect(resolveGateBehavior('ready_to_build', profile)).toBe('auto');
  });

  it('should return correct behavior for all gates with standard preset', () => {
    const profile: LifecycleProfile = { preset: 'standard' };
    const gates = Object.keys(LIFECYCLE_PRESETS.standard) as GateId[];
    for (const gate of gates) {
      expect(resolveGateBehavior(gate, profile)).toBe(LIFECYCLE_PRESETS.standard[gate]);
    }
  });
});

// ── findGateId ──────────────────────────────────────────────────────

describe('findGateId', () => {
  it('should find the correct gate ID for a known transition', () => {
    expect(findGateId('exploration', 'ready_for_build')).toBe('exploration_to_ready');
    expect(findGateId('ready_for_build', 'in_build')).toBe('ready_to_build');
    expect(findGateId('in_review', 'approved')).toBe('review_to_approved');
  });

  it('should return null for non-gate transitions', () => {
    expect(findGateId('open', 'exploration')).toBeNull();
    expect(findGateId('in_review', 'in_build')).toBeNull();
  });

  it('should map every entry in GATE_TRANSITION_MAP correctly', () => {
    for (const [gateId, { from, to }] of Object.entries(GATE_TRANSITION_MAP)) {
      expect(findGateId(from, to)).toBe(gateId);
    }
  });
});

// ── LIFECYCLE_PRESETS ───────────────────────────────────────────────

describe('LIFECYCLE_PRESETS', () => {
  it('should define all three presets', () => {
    expect(Object.keys(LIFECYCLE_PRESETS)).toEqual(['autonomous', 'standard', 'strict']);
  });

  it('should have all 9 gates defined in every preset', () => {
    const expectedGates: GateId[] = [
      'exploration_to_ready', 'ready_to_build', 'build_to_validation',
      'validation_to_review', 'review_to_approved', 'review_to_needs_human',
      'review_to_verification', 'approved_to_pending_merge', 'pending_merge_to_done',
    ];
    for (const preset of Object.values(LIFECYCLE_PRESETS)) {
      expect(Object.keys(preset).sort()).toEqual([...expectedGates].sort());
    }
  });

  it('autonomous should have all gates as auto', () => {
    for (const behavior of Object.values(LIFECYCLE_PRESETS.autonomous)) {
      expect(behavior).toBe('auto');
    }
  });

  it('standard should only have ready_to_build as confirm', () => {
    const confirmGates = Object.entries(LIFECYCLE_PRESETS.standard)
      .filter(([, v]) => v === 'confirm')
      .map(([k]) => k);
    expect(confirmGates).toEqual(['ready_to_build']);
  });

  it('strict should keep review_to_needs_human, review_to_verification, and pending_merge_to_done as auto', () => {
    expect(LIFECYCLE_PRESETS.strict.review_to_needs_human).toBe('auto');
    expect(LIFECYCLE_PRESETS.strict.review_to_verification).toBe('auto');
    expect(LIFECYCLE_PRESETS.strict.pending_merge_to_done).toBe('auto');
  });
});

// ── Zod validators ──────────────────────────────────────────────────

describe('lifecycleProfileSchema', () => {
  it('should accept a valid profile with preset only', () => {
    const result = lifecycleProfileSchema.safeParse({ preset: 'standard' });
    expect(result.success).toBe(true);
  });

  it('should accept a profile with overrides', () => {
    const result = lifecycleProfileSchema.safeParse({
      preset: 'autonomous',
      overrides: { ready_to_build: 'confirm' },
    });
    expect(result.success).toBe(true);
  });

  it('should accept a profile with gate_confirmer_roles', () => {
    const result = lifecycleProfileSchema.safeParse({
      preset: 'strict',
      gate_confirmer_roles: ['tech_lead'],
    });
    expect(result.success).toBe(true);
  });

  it('should reject an invalid preset', () => {
    const result = lifecycleProfileSchema.safeParse({ preset: 'turbo' });
    expect(result.success).toBe(false);
  });

  it('should reject invalid gate behavior in overrides', () => {
    const result = lifecycleProfileSchema.safeParse({
      preset: 'standard',
      overrides: { ready_to_build: 'skip' },
    });
    expect(result.success).toBe(false);
  });

  it('should reject unknown gate IDs in overrides (strict mode)', () => {
    const result = gateConfigSchema.safeParse({ unknown_gate: 'auto' });
    expect(result.success).toBe(false);
  });

  it('should reject missing preset', () => {
    const result = lifecycleProfileSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
