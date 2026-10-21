import { describe, it, expect } from 'vitest';
import {
  applyCapabilityFlagsToRule,
  buildPolicyRulesFromPreset,
  resolveCapabilityFlags,
  getDefaultPolicyRule,
} from '../index.js';
import type { EvidencePolicyRule } from '../index.js';

describe('resolveCapabilityFlags', () => {
  it('defaults both flags to true', () => {
    expect(resolveCapabilityFlags({})).toEqual({
      ci_available: true,
      unit_tests_available: true,
    });
  });

  it('expands the no_ci_no_unit preset', () => {
    expect(resolveCapabilityFlags('no_ci_no_unit')).toEqual({
      ci_available: false,
      unit_tests_available: false,
    });
  });

  it('expands the no_ci preset (unit tests still available)', () => {
    expect(resolveCapabilityFlags('no_ci')).toEqual({
      ci_available: false,
      unit_tests_available: true,
    });
  });
});

describe('applyCapabilityFlagsToRule', () => {
  it('returns the rule unchanged when CI and unit tests are available', () => {
    const rule = getDefaultPolicyRule('direct', 'medium');
    expect(applyCapabilityFlagsToRule(rule, {})).toBe(rule);
    expect(applyCapabilityFlagsToRule(rule, { ci_available: true, unit_tests_available: true })).toBe(rule);
  });

  it('drops ci_result + unit_test_result and substitutes a required manual_confirmation', () => {
    // direct/medium default requires [ci_result, unit_test_result]
    const rule = getDefaultPolicyRule('direct', 'medium');
    const result = applyCapabilityFlagsToRule(rule, 'no_ci_no_unit');

    expect(result.required_evidence_types).not.toContain('ci_result');
    expect(result.required_evidence_types).not.toContain('unit_test_result');
    // Governance: a manual attestation is now required so the gate is not weakened.
    expect(result.required_evidence_types).toContain('manual_confirmation');
    // lint_result offered as an acceptable repo-available alternative.
    expect(result.optional_evidence_types).toContain('lint_result');
  });

  it('only drops ci_result for the no_ci preset, keeps unit_test_result', () => {
    const rule = getDefaultPolicyRule('direct', 'medium');
    const result = applyCapabilityFlagsToRule(rule, 'no_ci');
    expect(result.required_evidence_types).not.toContain('ci_result');
    expect(result.required_evidence_types).toContain('unit_test_result');
    expect(result.required_evidence_types).toContain('manual_confirmation');
  });

  it('does not double-add manual_confirmation when the rule already requires it', () => {
    // manual/medium default already requires manual_confirmation
    const rule = getDefaultPolicyRule('manual', 'medium');
    const result = applyCapabilityFlagsToRule(rule, 'no_ci_no_unit');
    const count = result.required_evidence_types.filter((t) => t === 'manual_confirmation').length;
    expect(count).toBe(1);
  });

  it('preserves non-dropped required types (e.g. runtime_log on direct/high)', () => {
    const rule = getDefaultPolicyRule('direct', 'high');
    const result = applyCapabilityFlagsToRule(rule, 'no_ci_no_unit');
    expect(result.required_evidence_types).toContain('runtime_log');
  });

  it('does not add manual gate when dropped type was only optional', () => {
    // Custom rule: ci_result is optional, not required → no substitution.
    const rule: EvidencePolicyRule = {
      required_evidence_types: ['lint_result'],
      optional_evidence_types: ['ci_result'],
      four_eyes_required: false,
      allow_self_approval: false,
    };
    const result = applyCapabilityFlagsToRule(rule, 'no_ci');
    expect(result.required_evidence_types).toEqual(['lint_result']);
    expect(result.required_evidence_types).not.toContain('manual_confirmation');
    expect(result.optional_evidence_types).not.toContain('ci_result');
  });

  it('preserves four_eyes_required / allow_self_approval flags', () => {
    const rule = getDefaultPolicyRule('direct', 'high'); // four_eyes true
    const result = applyCapabilityFlagsToRule(rule, 'no_ci_no_unit');
    expect(result.four_eyes_required).toBe(true);
    expect(result.allow_self_approval).toBe(false);
  });
});

describe('buildPolicyRulesFromPreset', () => {
  it('produces a full risk-first / track-second map for every cell', () => {
    const rules = buildPolicyRulesFromPreset('no_ci_no_unit');
    for (const risk of ['low', 'medium', 'high', 'critical'] as const) {
      for (const track of ['direct', 'manual'] as const) {
        const cell = rules[risk]?.[track];
        expect(cell, `${risk}/${track}`).toBeDefined();
        expect(cell!.required_evidence_types).not.toContain('ci_result');
        expect(cell!.required_evidence_types).not.toContain('unit_test_result');
        expect(cell!.required_evidence_types).toContain('manual_confirmation');
      }
    }
  });

  it('a no_ci_no_unit direct/low cell is satisfiable by {manual_confirmation}', () => {
    const rules = buildPolicyRulesFromPreset('no_ci_no_unit');
    const cell = rules.low!.direct!;
    // direct/low default required only ci_result → now just manual_confirmation
    expect(cell.required_evidence_types).toEqual(['manual_confirmation']);
  });

  it('no_ci drops ci_result everywhere, keeps unit_test_result, never empties required', () => {
    const rules = buildPolicyRulesFromPreset('no_ci');
    for (const risk of ['low', 'medium', 'high', 'critical'] as const) {
      for (const track of ['direct', 'manual'] as const) {
        const base = getDefaultPolicyRule(track, risk);
        const cell = rules[risk]?.[track];
        expect(cell, `${risk}/${track}`).toBeDefined();
        // ci_result is never required (it can never arrive); unit_test_result
        // stays whenever the default cell required it.
        expect(cell!.required_evidence_types, `${risk}/${track}`).not.toContain('ci_result');
        if (base.required_evidence_types.includes('unit_test_result')) {
          expect(cell!.required_evidence_types, `${risk}/${track}`).toContain('unit_test_result');
        }
        // Any cell that required ci_result gains a manual_confirmation gate.
        if (base.required_evidence_types.includes('ci_result')) {
          expect(cell!.required_evidence_types, `${risk}/${track}`).toContain('manual_confirmation');
        }
        // The gate is never silently removed: required set stays non-empty.
        expect(cell!.required_evidence_types.length, `${risk}/${track}`).toBeGreaterThan(0);
      }
    }
  });

  it('no_unit drops unit_test_result everywhere, keeps ci_result, never empties required', () => {
    const rules = buildPolicyRulesFromPreset('no_unit');
    for (const risk of ['low', 'medium', 'high', 'critical'] as const) {
      for (const track of ['direct', 'manual'] as const) {
        const base = getDefaultPolicyRule(track, risk);
        const cell = rules[risk]?.[track];
        expect(cell, `${risk}/${track}`).toBeDefined();
        expect(cell!.required_evidence_types, `${risk}/${track}`).not.toContain('unit_test_result');
        if (base.required_evidence_types.includes('ci_result')) {
          expect(cell!.required_evidence_types, `${risk}/${track}`).toContain('ci_result');
        }
        if (base.required_evidence_types.includes('unit_test_result')) {
          expect(cell!.required_evidence_types, `${risk}/${track}`).toContain('manual_confirmation');
        }
        expect(cell!.required_evidence_types.length, `${risk}/${track}`).toBeGreaterThan(0);
      }
    }
  });
});
