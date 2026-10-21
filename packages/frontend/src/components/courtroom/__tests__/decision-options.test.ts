/**
 * Pure-helper tests for the courtroom decision option list selector.
 *
 * Locks the (status × finding-presence) → option-list contract consumed by
 * the tiered DecisionCluster. No DOM, no React.
 */
import { describe, expect, it } from 'vitest';
import {
  baseCaseLevelOptions,
  baseFindingLevelOptions,
  decisionColors,
  getDecisionOptions,
  verificationPendingOptions,
} from '../decision-options';

describe('getDecisionOptions', () => {
  it('returns the 3 case-level options for needs_human_decision without a finding (waive is per-finding via the decision-panel waive list, escalate hidden)', () => {
    const opts = getDecisionOptions('needs_human_decision', false);
    expect(opts.map((o) => o.value)).toEqual([
      'approve',
      'request_changes',
      'reject',
    ]);
    expect(opts.find((o) => o.value === 'approve')!.label).toBe('Approve');
    expect(opts.find((o) => o.value === 'request_changes')!.label).toBe('Request Changes');
    // Scope captions on case-level descriptions (PR feat/courtroom-decision-form-restructure).
    expect(opts.find((o) => o.value === 'approve')!.description).toBe(
      'Closes the case as approved',
    );
    expect(opts.find((o) => o.value === 'request_changes')!.description).toBe(
      'Returns the case for rework',
    );
    expect(opts.find((o) => o.value === 'reject')!.description).toBe(
      'Closes the case as rejected',
    );
  });

  it('returns the 4 finding-level options for needs_human_decision WITH a finding (relabels, escalate hidden)', () => {
    const opts = getDecisionOptions('needs_human_decision', true);
    expect(opts.map((o) => o.value)).toEqual([
      'approve',
      'request_changes',
      'waive',
      'reject',
    ]);
    // Relabels — finding-level approve becomes "Mark as resolved";
    // request_changes becomes "Flag as blocking".
    expect(opts.find((o) => o.value === 'approve')!.label).toBe('Mark as resolved');
    expect(opts.find((o) => o.value === 'request_changes')!.label).toBe('Flag as blocking');
    // Waive copy clarifies finding-vs-case scope (waive ≠ approve).
    const waive = opts.find((o) => o.value === 'waive')!;
    expect(waive.label).toBe('Waive finding');
    expect(waive.description).toBe('Accept the risk of this one finding');
    expect(waive.tooltip).toContain('separate Approve decision');
  });

  it('returns the 3-option carve-out for verification_pending (no waive, no escalate)', () => {
    const opts = getDecisionOptions('verification_pending', false);
    expect(opts.map((o) => o.value)).toEqual(['approve', 'request_changes', 'reject']);
    // verification_pending always shows case-level labels — even if a
    // finding is selected, the carve-out wins.
    const withFinding = getDecisionOptions('verification_pending', true);
    expect(withFinding).toBe(opts);
  });

  it('falls back to case-level options when caseStatus is undefined and no finding', () => {
    expect(getDecisionOptions(undefined, false)).toBe(baseCaseLevelOptions);
  });

  it('falls back to finding-level options when caseStatus is undefined but a finding is selected', () => {
    expect(getDecisionOptions(undefined, true)).toBe(baseFindingLevelOptions);
  });

  it('uses the same array references for the canonical lists (referential stability for memoization)', () => {
    expect(getDecisionOptions('needs_human_decision', false)).toBe(baseCaseLevelOptions);
    expect(getDecisionOptions('needs_human_decision', true)).toBe(baseFindingLevelOptions);
    expect(getDecisionOptions('verification_pending', false)).toBe(verificationPendingOptions);
  });
});

describe('decisionColors', () => {
  it('has a class string for every decision value used by the option lists', () => {
    const allValues = new Set([
      ...baseCaseLevelOptions.map((o) => o.value),
      ...baseFindingLevelOptions.map((o) => o.value),
      ...verificationPendingOptions.map((o) => o.value),
    ]);
    for (const v of allValues) {
      expect(typeof decisionColors[v]).toBe('string');
      expect(decisionColors[v]!.length).toBeGreaterThan(0);
    }
  });

  it('approve and manual_validation_confirmed share the green token', () => {
    expect(decisionColors.approve).toBe(decisionColors.manual_validation_confirmed);
  });
});
