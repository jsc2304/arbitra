/**
 * @file ReviewNotApplicableAction — eligibility + rationale-gate tests.
 *
 * Follows the `case-delete-dialog.test.tsx` convention: pure helpers are
 * unit-tested directly (no DOM needed), covering exactly what the spec's
 * eligibility rule requires (in_review + not already flagged + latest
 * review_run failed, or no runs at all).
 */
import { describe, expect, it } from 'vitest';
import {
  isReviewNotApplicableEligible,
  isReviewNotApplicableRationaleValid,
} from '../review-not-applicable-action';

describe('isReviewNotApplicableEligible', () => {
  it('is eligible when in_review with no runs at all', () => {
    expect(isReviewNotApplicableEligible('in_review', undefined, [])).toBe(true);
  });

  it('is eligible when in_review and the latest review_run failed', () => {
    expect(
      isReviewNotApplicableEligible('in_review', undefined, [
        { run_type: 'review_run', status: 'failed', created_at: '2026-01-01T00:00:00Z' },
      ]),
    ).toBe(true);
  });

  it('picks the LATEST review_run by created_at, not array order', () => {
    expect(
      isReviewNotApplicableEligible('in_review', undefined, [
        { run_type: 'review_run', status: 'failed', created_at: '2026-01-01T00:00:00Z' },
        { run_type: 'review_run', status: 'completed', created_at: '2026-01-02T00:00:00Z' },
      ]),
    ).toBe(false);
  });

  it('is not eligible when the case is not in_review', () => {
    expect(isReviewNotApplicableEligible('in_build', undefined, [])).toBe(false);
  });

  it('is not eligible when already marked review_not_applicable', () => {
    expect(isReviewNotApplicableEligible('in_review', true, [])).toBe(false);
  });

  it('is not eligible when a non-review run exists but no review_run has run yet', () => {
    expect(
      isReviewNotApplicableEligible('in_review', undefined, [
        { run_type: 'rule_run', status: 'completed', created_at: '2026-01-01T00:00:00Z' },
      ]),
    ).toBe(false);
  });

  it('is not eligible when the latest review_run is still running', () => {
    expect(
      isReviewNotApplicableEligible('in_review', undefined, [
        { run_type: 'review_run', status: 'running', created_at: '2026-01-01T00:00:00Z' },
      ]),
    ).toBe(false);
  });
});

describe('isReviewNotApplicableRationaleValid', () => {
  it('rejects rationale under 10 trimmed characters', () => {
    expect(isReviewNotApplicableRationaleValid('short')).toBe(false);
    expect(isReviewNotApplicableRationaleValid('   short   ')).toBe(false);
  });

  it('accepts rationale at exactly 10 trimmed characters', () => {
    expect(isReviewNotApplicableRationaleValid('1234567890')).toBe(true);
  });

  it('accepts a longer rationale', () => {
    expect(
      isReviewNotApplicableRationaleValid('Provider billing error — no retry can succeed.'),
    ).toBe(true);
  });
});
