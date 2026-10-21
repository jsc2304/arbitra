/**
 * @file approval-rate-colors — color-ramp tests.
 *
 * Locks two behaviors:
 *  - A 0% approval rate for a workspace that HAS
 *    decided cases is alarm-red (a stalled pipeline must not read as "good").
 *  - #664: a 0% rate for a brand-new / empty workspace (no cases decided yet)
 *    is "no data", not a stall, so it reads neutral gray — never red.
 *
 * The empty-workspace signal is the optional `decidedCount` denominator
 * (approved + rejected + done). `undefined` preserves legacy behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  approvalRatePillColors,
  approvalRateStatAccent,
} from '../approval-rate-colors';

const RED_FG = '#dc2626';
const GREEN_PILL_FG = '#16a34a';
const AMBER_PILL_FG = '#ca8a04';
const NEUTRAL_FG = '#6b7280';

describe('approvalRatePillColors', () => {
  describe('legacy behavior (no decidedCount)', () => {
    it('renders 0% as red (stalled pipeline)', () => {
      expect(approvalRatePillColors(0).fg).toBe(RED_FG);
    });

    it('treats negative rate as red (defensive)', () => {
      expect(approvalRatePillColors(-5).fg).toBe(RED_FG);
    });

    it('renders <50% as neutral gray', () => {
      expect(approvalRatePillColors(25).fg).toBe(NEUTRAL_FG);
      expect(approvalRatePillColors(49).fg).toBe(NEUTRAL_FG);
    });

    it('renders 50–79% as amber', () => {
      expect(approvalRatePillColors(50).fg).toBe(AMBER_PILL_FG);
      expect(approvalRatePillColors(79).fg).toBe(AMBER_PILL_FG);
    });

    it('renders >=80% as green', () => {
      expect(approvalRatePillColors(80).fg).toBe(GREEN_PILL_FG);
      expect(approvalRatePillColors(100).fg).toBe(GREEN_PILL_FG);
    });
  });

  describe('empty-workspace carve-out (#664)', () => {
    it('renders 0% as neutral gray when nothing has been decided yet', () => {
      expect(approvalRatePillColors(0, 0).fg).toBe(NEUTRAL_FG);
    });

    it('keeps 0% red once at least one case has been decided', () => {
      expect(approvalRatePillColors(0, 1).fg).toBe(RED_FG);
      expect(approvalRatePillColors(0, 133).fg).toBe(RED_FG);
    });

    it('does not change non-zero ramps when decidedCount > 0', () => {
      expect(approvalRatePillColors(60, 10).fg).toBe(AMBER_PILL_FG);
      expect(approvalRatePillColors(90, 10).fg).toBe(GREEN_PILL_FG);
      expect(approvalRatePillColors(30, 10).fg).toBe(NEUTRAL_FG);
    });

    it('treats a negative decidedCount as no data (defensive)', () => {
      expect(approvalRatePillColors(0, -1).fg).toBe(NEUTRAL_FG);
    });
  });
});

describe('approvalRateStatAccent', () => {
  describe('legacy behavior (no decidedCount)', () => {
    it('returns red for 0%', () => {
      expect(approvalRateStatAccent(0)).toBe(RED_FG);
      expect(approvalRateStatAccent(-3)).toBe(RED_FG);
    });

    it('returns neutral gray for <50%', () => {
      expect(approvalRateStatAccent(10)).toBe(NEUTRAL_FG);
      expect(approvalRateStatAccent(49)).toBe(NEUTRAL_FG);
    });

    it('returns green for >=50%', () => {
      expect(approvalRateStatAccent(50)).toBe('#22c55e');
      expect(approvalRateStatAccent(100)).toBe('#22c55e');
    });
  });

  describe('empty-workspace carve-out (#664)', () => {
    it('returns neutral gray for 0% when nothing has been decided yet', () => {
      expect(approvalRateStatAccent(0, 0)).toBe(NEUTRAL_FG);
    });

    it('keeps 0% red once at least one case has been decided', () => {
      expect(approvalRateStatAccent(0, 1)).toBe(RED_FG);
      expect(approvalRateStatAccent(0, 50)).toBe(RED_FG);
    });

    it('does not change non-zero ramps when decidedCount > 0', () => {
      expect(approvalRateStatAccent(75, 4)).toBe('#22c55e');
      expect(approvalRateStatAccent(20, 4)).toBe(NEUTRAL_FG);
    });
  });
});
