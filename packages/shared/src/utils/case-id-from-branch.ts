/**
 * Extracts an Arbitra `case_id` from a branch name.
 *
 * Case ids are produced by the backend's `generateCaseId()` helper as
 * `case-<adjective>-<noun>-<nanoid(4)>` where the nanoid segment can contain
 * letters, digits, `_`, and `-` (the default nanoid alphabet is URL-safe).
 *
 * Agents and humans typically embed the case id somewhere in the branch name,
 * often behind a Conventional-Commit-style prefix:
 *   - `refactor/case-short-rim-x76o-wave4` -> `case-short-rim-x76o`
 *   - `feat/case-smart-ford-QW2U`          -> `case-smart-ford-QW2U`
 *   - `case-bright-pine-_TOD`              -> `case-bright-pine-_TOD`
 *
 * The matcher is intentionally greedy on adjective/noun segments (each is one
 * or more lowercase letters, hyphen-separated) and stops at the first 4-char
 * nanoid-looking tail. The FIRST match wins so downstream prefixes/suffixes
 * on the branch don't pollute the id.
 *
 * Returns `null` when nothing in the branch name looks like a case id. The
 * caller is expected to treat a returned id as a candidate only — the case
 * may not exist in Firestore, or may belong to a different repo / be in a
 * terminal state. Those checks live with the caller.
 */

// Adjective and noun segments are lowercase letters only (see `words.ts`).
// Nanoid(4) uses the default URL-safe alphabet: [A-Za-z0-9_-]. The `-` in the
// character class is placed last so it's treated as a literal.
const CASE_ID_IN_BRANCH = /case-[a-z]+(?:-[a-z]+)+-[A-Za-z0-9_-]{4,}/;

// Matches the *label* of a dedicated `Arbitra-Case: <case-id>` line — commit-
// trailer style, as used in PR bodies and commit messages. Tolerates leading
// whitespace, common markdown list/quote/bold decoration (`- `, `> `, `**`,
// `#`, `1. `) before the label, and backtick and/or asterisk (bold) wrapping around the label
// and/or the whole line (e.g. `` `Arbitra-Case: case-xyz` `` or
// `` `Arbitra-Case:` case-xyz ``), and is case-insensitive on the label text
// only. The case id itself is extracted separately with `CASE_ID_IN_BRANCH`
// so the strict lowercase-adjective/noun + fingerprinted-tail shape is not
// loosened by this regex's `i` flag — a trailing backtick right after the id
// already falls outside that char class and is excluded without any extra
// handling.
const LABELLED_CASE_ID_LABEL = /^[ \t]*(?:[-*+>#]+|\d+[.)])?[ \t]*[`*]*arbitra-case:/i;

/**
 * `generateCaseId()` emits exactly a 4-char nanoid tail. Branches (and PR
 * text) often append extra segments (`-wave4`, `-foo`) after the case id —
 * this trims those back to the 4-char tail. Strategy: split the match on
 * `-`, walk from the left past the `case-<adj>(-<adj>)*-<noun>(-<noun>)*-`
 * body to the tail. Simplest correct form: the tail is the 4-char segment
 * that contains at least one non-[a-z] character (digit/uppercase/
 * underscore) OR is exactly the last segment if the whole id is
 * all-lowercase.
 *
 * In practice the tail is fingerprinted by being 4 chars AND (having a
 * digit/upper/underscore). If no such segment exists, the raw regex match is
 * returned as-is — the Firestore lookup will still fail gracefully and the
 * webhook flow continues to auto-create.
 */
function trimToFingerprintedTail(raw: string): string {
  const parts = raw.split('-');
  // parts[0] === 'case', parts[1..] are body segments then the tail.
  for (let i = 2; i < parts.length; i++) {
    const seg = parts[i]!;
    if (seg.length === 4 && /[A-Z0-9_]/.test(seg)) {
      return parts.slice(0, i + 1).join('-');
    }
  }
  return raw;
}

/**
 * Scans `text` line by line for a dedicated `Arbitra-Case: <case-id>` line
 * and returns the case id from the first such line found, or `null` if no
 * labelled line exists. Unlike the free-text scan in `extractCaseIdFromText`,
 * this only ever looks at lines that carry the explicit label — a foreign
 * case id mentioned in prose elsewhere in the text never matches here.
 */
function extractLabelledCaseId(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (!LABELLED_CASE_ID_LABEL.test(line)) continue;
    const match = CASE_ID_IN_BRANCH.exec(line);
    if (match) return trimToFingerprintedTail(match[0]);
  }
  return null;
}

export interface ExtractCaseIdOptions {
  /**
   * When true, a dedicated `Arbitra-Case: <case-id>` line wins over any
   * earlier free-text case-id mention in the same text, falling back to the
   * normal first-match scan only when no labelled line is present.
   *
   * Intended for PR-body/title extraction: a problem description can
   * legitimately reference a *different* case in prose before the PR's own
   * `Arbitra-Case:` line, and first-match-wins there mis-links the PR (see
   * issue #813). Branch-name extraction (`extractCaseIdFromBranch`) does not
   * set this — first-match-wins for branch names is intentional (see the
   * file-level doc comment above) and is left unchanged.
   */
  preferLabelledLine?: boolean;
}

/**
 * Runs the same case-id regex over arbitrary text (PR title, PR body, branch
 * name, etc.) and trims any trailing branch-style segments off the nanoid
 * tail. Returns `null` when nothing in the text matches.
 *
 * Used by webhook dedup to recover a referenced case_id from PR titles and
 * descriptions ("Arbitra: case-pure-dawn-mQj7") in addition to the branch
 * name. `extractCaseIdFromBranch` is a thin wrapper preserved for the
 * existing branch-name call sites.
 *
 * By default this is first-match-wins, same as branch extraction. Pass
 * `{ preferLabelledLine: true }` (PR-body call sites only) to prefer an
 * explicit `Arbitra-Case:` line over an earlier free-text mention.
 */
export function extractCaseIdFromText(
  text: string,
  options: ExtractCaseIdOptions = {},
): string | null {
  if (!text) return null;

  if (options.preferLabelledLine) {
    const labelled = extractLabelledCaseId(text);
    if (labelled) return labelled;
  }

  const match = CASE_ID_IN_BRANCH.exec(text);
  if (!match) return null;
  return trimToFingerprintedTail(match[0]);
}

export function extractCaseIdFromBranch(branch: string): string | null {
  return extractCaseIdFromText(branch);
}
