import { z } from 'zod';
import { isValidPrRef } from '../utils/pr-ref.js';

/**
 * A GitHub pull-request reference, at every boundary that can reach
 * `Case.current_pr_ref` (issue #1046).
 *
 * That field was `z.string()` while security decisions are made by comparing
 * it to an incoming PR: whether a terminal case owns this PR (so a rejection
 * keeps blocking), and whether a re-link would steal a case. A ref that
 * cannot be parsed makes both comparisons inconclusive, and the value is
 * settable by agents — so an unvalidated one was a way to reach the
 * inconclusive branch deliberately.
 *
 * Lives in its own module because more than one validator file needs it
 * (`case-validators.ts` for create/update, `artifact-validators.ts` for
 * `git_context.pr_ref`) and importing one from the other would be a cycle.
 *
 * `parsePrRef` behind it is deliberately tolerant — scheme-less, `www.`, any
 * casing, the `api.github.com` form — so this rejects garbage without
 * rejecting the shapes people and tools actually produce. It is the same
 * parser the publish path uses, so a ref accepted here is always publishable.
 */
export const prRefSchema = z
  .string()
  // Cap before the refine so a pathological input is rejected on length
  // rather than run through the parser. Real PR URLs are far under this.
  .max(500)
  .refine(isValidPrRef, {
    message: 'must be a GitHub pull request URL (e.g. https://github.com/owner/repo/pull/123)',
  });
