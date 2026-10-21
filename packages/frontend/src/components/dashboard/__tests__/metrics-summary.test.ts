/**
 * @file metrics-summary — approvalRateAccent tests.
 *
 * "Approval Rate 0%" was rendered
 * in green on the dashboard, falsely signalling success when the pipeline is
 * stalled. Lock the accent ramp: 0% → red, <50% → neutral, ≥50% → green.
 */
import { describe, expect, it } from 'vitest';
import { approvalRateAccent } from '../metrics-summary';

describe('approvalRateAccent', () => {
  it('returns red for 0% (zero approvals = pipeline stalled, not "good")', () => {
    expect(approvalRateAccent(0)).toContain('text-red-600');
  });

  it('returns neutral gray for low non-zero rates (<50%)', () => {
    expect(approvalRateAccent(10)).toContain('text-gray-700');
    expect(approvalRateAccent(49)).toContain('text-gray-700');
  });

  it('returns green for healthy rates (>=50%)', () => {
    expect(approvalRateAccent(50)).toContain('text-green-600');
    expect(approvalRateAccent(80)).toContain('text-green-600');
    expect(approvalRateAccent(100)).toContain('text-green-600');
  });

  it('treats negative rates as zero (defensive)', () => {
    expect(approvalRateAccent(-5)).toContain('text-red-600');
  });

  // #664: a 0% rate is only alarming once at least one case has been decided.
  describe('empty-workspace carve-out (#664)', () => {
    it('returns neutral gray for 0% when nothing has been decided yet', () => {
      expect(approvalRateAccent(0, 0)).toContain('text-gray-700');
    });

    it('keeps 0% red once at least one case has been decided', () => {
      expect(approvalRateAccent(0, 1)).toContain('text-red-600');
      expect(approvalRateAccent(0, 133)).toContain('text-red-600');
    });

    it('does not change non-zero ramps when decidedCount > 0', () => {
      expect(approvalRateAccent(75, 4)).toContain('text-green-600');
      expect(approvalRateAccent(20, 4)).toContain('text-gray-700');
    });

    it('treats a negative decidedCount as no data (defensive)', () => {
      expect(approvalRateAccent(0, -1)).toContain('text-gray-700');
    });
  });
});
