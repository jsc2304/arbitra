/**
 * One parser and one comparison for GitHub pull-request references, shared
 * by every caller that needs to answer "do these two refs name the same PR?"
 *
 * ## Why this is centralized
 *
 * Two helpers for this existed in `webhook-service.ts` at once, and they
 * failed in OPPOSITE directions on an unparseable ref (issue #1046):
 * the re-link guard fell back to string equality, while the terminal-case
 * exit returned "different PR" — which routed a rejected case's own PR to
 * the case-less `success` and made the critical bug reproducible through any
 * non-canonical stored ref. The parse rules and the comparison now live in
 * exactly one place; what a caller does with an INCONCLUSIVE answer is an
 * explicit decision at the call site (see `PrRefComparison`), not an
 * accident of which helper it happened to call.
 */

/** Parsed identity of a pull request: the tuple that makes two refs equal. */
export interface ParsedPrRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Parses a GitHub PR reference into `owner/repo#number`.
 *
 * Deliberately tolerant, because `Case.current_pr_ref` is not always written
 * by the webhook — it can also be typed by a human or an agent through
 * `create_case` / `update_case`. Every shape below was observed to defeat
 * the previous strict `^https://github\.com/o/r/pull/N` matcher and, through
 * it, the #1046 terminal-case check:
 *
 *   - no scheme (`github.com/o/r/pull/1`), or `http://`
 *   - `www.` host prefix
 *   - any host/scheme casing (`HTTPS://GitHub.com/...`)
 *   - the REST API form (`api.github.com/repos/o/r/pulls/1`)
 *   - trailing slash, query string, fragment, or a `/files`-style suffix
 *
 * Owner and repo are returned lowercased: GitHub treats them
 * case-insensitively, so `acme/Demo` and `acme/demo` are one repository and
 * must compare equal. Returns `null` for anything that does not resolve to a
 * PR identity — callers must decide what an unparseable ref means for them.
 */
export function parsePrRef(ref: string | undefined | null): ParsedPrRef | null {
  if (!ref) return null;

  const trimmed = ref.trim();
  if (!trimmed) return null;

  // Strip an optional scheme, then an optional `www.` prefix, so host
  // matching below can be a single case-insensitive alternation.
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const withoutWww = withoutScheme.replace(/^www\./i, '');

  const webMatch = withoutWww.match(
    /^github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]|$)/i,
  );
  const apiMatch = withoutWww.match(
    /^api\.github\.com\/repos\/([^/\s]+)\/([^/\s]+)\/pulls\/(\d+)(?:[/?#]|$)/i,
  );
  const match = webMatch ?? apiMatch;
  if (!match) return null;

  const number = Number.parseInt(match[3]!, 10);
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  return {
    owner: match[1]!.toLowerCase(),
    repo: match[2]!.toLowerCase(),
    number,
  };
}

/**
 * Result of comparing two PR refs.
 *
 * `'unknown'` is the load-bearing member: it means at least one ref could
 * not be resolved to a PR identity, so the comparison PROVED nothing. It is
 * a distinct value — rather than being folded into `'different'` — precisely
 * because the safe interpretation depends on what the caller does next:
 *
 *   - Deciding whether to publish a terminal case's verdict onto a PR
 *     (#1046) must treat `'unknown'` as `'same'`. Guessing "different"
 *     there publishes the case-less `success` and unblocks a merge the
 *     rejection was holding — the exploit itself.
 *   - Deciding whether to RE-LINK a case to a new PR (#813) must not treat
 *     `'unknown'` as `'same'`, since that would let two genuinely different
 *     unparseable refs clobber each other's link.
 *
 * Both callers are correct and they disagree; the type makes them say so.
 */
export type PrRefComparison = 'same' | 'different' | 'unknown';

/** Compares two PR refs by parsed identity. See `PrRefComparison`. */
export function comparePrRefs(
  a: string | undefined | null,
  b: string | undefined | null,
): PrRefComparison {
  const left = parsePrRef(a);
  const right = parsePrRef(b);
  if (!left || !right) return 'unknown';
  return left.owner === right.owner
    && left.repo === right.repo
    && left.number === right.number
    ? 'same'
    : 'different';
}

/** True when `ref` resolves to a PR identity — the boundary validator's predicate. */
export function isValidPrRef(ref: string): boolean {
  return parsePrRef(ref) !== null;
}
