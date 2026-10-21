/**
 * Diff-coverage findings — how much of the change the review actually saw.
 *
 * `DiffResolver` caps a diff at `MAX_DIFF_LINES` and reports `truncated`.
 * Before issue #877 that flag was read and discarded: the review ran on the
 * prefix, the model was never told, nothing was recorded, and the resulting
 * review could satisfy `auto_approve_criteria_met` — so the unreviewed
 * remainder of a large pull request could be approved without any human ever
 * looking at it.
 *
 * The guard is a finding, not a skipped review. A truncated diff yields a
 * `high` `diff_exceeds_limit` finding, which:
 *   - blocks `auto_approve_criteria_met` (open authored high/critical), and
 *   - satisfies `has_high_critical_findings`, so `in_review` still has an
 *     edge out — into `needs_human_decision`.
 * The review run itself still completes, so `review_run_completed` is
 * satisfied by a real run and the case is never parked without an exit.
 *
 * A diff that is merely large but complete gets an `info` `large_diff_warning`
 * — visible in the timeline, gating nothing.
 */

import type { FindingCategory, FindingSeverity } from '@arbitra/shared';
import { MAX_DIFF_LINES } from '../diff/diff-resolver.js';
import { computeFindingSignature } from './finding-signature.js';

/**
 * Above this many lines a complete diff is flagged as large. Purely
 * informational: `info` severity gates nothing anywhere in `preconditions.ts`.
 */
export const LARGE_DIFF_LINE_THRESHOLD = 500;

export interface DiffCoverageFinding {
  category: Extract<FindingCategory, 'diff_exceeds_limit' | 'large_diff_warning'>;
  severity: FindingSeverity;
  title: string;
  description: string;
  /** Deterministic dedup signature — stable across re-reviews, see below. */
  signature: string;
}

/**
 * Claim text that feeds the signature. Deliberately number-free while the
 * persisted `description` carries the concrete line counts: every push
 * changes the line count, and folding it into the signature would stack a
 * fresh copy of the same finding on the case at every re-review instead of
 * deduplicating against the one already open.
 */
const SIGNATURE_CLAIMS = {
  diff_exceeds_limit: 'the diff exceeded the review line limit and was reviewed as a truncated prefix',
  large_diff_warning: 'the diff is large but was reviewed in full',
} as const;

function signatureFor(
  caseId: string,
  category: DiffCoverageFinding['category'],
  severity: FindingSeverity,
  title: string,
): string {
  return computeFindingSignature(caseId, {
    source: 'system:pipeline',
    category,
    severity,
    confidence: 1,
    title,
    description: SIGNATURE_CLAIMS[category],
  });
}

const EXCEEDS_TITLE = 'Diff exceeded the review limit — only part of the change was reviewed';
const LARGE_TITLE = 'Large diff';

/**
 * Decide which diff-coverage finding (if any) a review run should raise.
 *
 * @param caseId     case the finding belongs to (part of the signature)
 * @param truncated  whether `DiffResolver` cut the diff at the line cap
 * @param lineCount  line count of the ORIGINAL diff, before truncation
 */
export function buildDiffCoverageFinding(
  caseId: string,
  truncated: boolean,
  lineCount: number,
): DiffCoverageFinding | null {
  if (truncated) {
    return {
      category: 'diff_exceeds_limit',
      severity: 'high',
      title: EXCEEDS_TITLE,
      description:
        `The pull request diff is ${lineCount} lines, above the ${MAX_DIFF_LINES}-line review limit, ` +
        'so the reviewer received a truncated prefix of it. Everything past the cut was not read by the ' +
        'reviewer and is not covered by this review. A human must decide how to proceed — split the change ' +
        'into smaller pull requests, or review the remainder manually and record that here.',
      signature: signatureFor(caseId, 'diff_exceeds_limit', 'high', EXCEEDS_TITLE),
    };
  }

  if (lineCount > LARGE_DIFF_LINE_THRESHOLD) {
    return {
      category: 'large_diff_warning',
      severity: 'info',
      title: LARGE_TITLE,
      description:
        `The pull request diff is ${lineCount} lines (above ${LARGE_DIFF_LINE_THRESHOLD}). ` +
        'It was reviewed in full — this note only records the size, since large changes are harder to ' +
        'review reliably and are worth splitting where possible.',
      signature: signatureFor(caseId, 'large_diff_warning', 'info', LARGE_TITLE),
    };
  }

  return null;
}
