import { describe, it, expect } from 'vitest';
import { buildDiffCoverageFinding, LARGE_DIFF_LINE_THRESHOLD } from './diff-coverage.js';

describe('buildDiffCoverageFinding (#877)', () => {
  it('raises a high diff_exceeds_limit finding for a truncated diff', () => {
    const f = buildDiffCoverageFinding('case_1', true, 12_500);

    expect(f).not.toBeNull();
    expect(f!.category).toBe('diff_exceeds_limit');
    // `high` is the load-bearing part: it blocks `auto_approve_criteria_met`
    // and satisfies `has_high_critical_findings`, so `in_review` still has an
    // edge out into `needs_human_decision`.
    expect(f!.severity).toBe('high');
    expect(f!.description).toContain('12500');
  });

  it('raises an info large_diff_warning for a complete diff over the threshold', () => {
    const f = buildDiffCoverageFinding('case_1', false, 600);

    expect(f).not.toBeNull();
    expect(f!.category).toBe('large_diff_warning');
    expect(f!.severity).toBe('info');
  });

  it('raises nothing for a complete diff at or below the threshold', () => {
    expect(buildDiffCoverageFinding('case_1', false, LARGE_DIFF_LINE_THRESHOLD)).toBeNull();
    expect(buildDiffCoverageFinding('case_1', false, 12)).toBeNull();
  });

  it('keeps the truncation signature stable as the diff grows', () => {
    // Every push changes the line count. If the count fed the signature, a
    // re-review would stack a second copy of the same finding on the case
    // instead of deduplicating against the one already open.
    const first = buildDiffCoverageFinding('case_1', true, 10_001)!;
    const later = buildDiffCoverageFinding('case_1', true, 40_000)!;

    expect(first.signature).toBe(later.signature);
    expect(first.description).not.toBe(later.description);
  });

  it('scopes the signature to the case', () => {
    const a = buildDiffCoverageFinding('case_1', true, 10_001)!;
    const b = buildDiffCoverageFinding('case_2', true, 10_001)!;

    expect(a.signature).not.toBe(b.signature);
  });
});
