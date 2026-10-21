/**
 * Extract a Firebase console "create composite index" URL from an arbitrary
 * error string.
 *
 * Firestore raises `FAILED_PRECONDITION` when a query needs a composite
 * index that doesn't exist yet, and the SDK error message embeds a direct
 * console link an operator can click to create it, e.g.:
 *
 *   "9 FAILED_PRECONDITION: The query requires an index. You can create it
 *    here: https://console.firebase.google.com/project/<id>/firestore/
 *    indexes?create_composite=<token>"
 *
 * This helper is intentionally conservative: it only matches
 * `https://console.firebase.google.com/` URLs that contain
 * `create_composite=`, and it stops at the first whitespace, single quote,
 * double quote, backtick, or closing-parenthesis boundary — so a URL
 * embedded in prose, wrapped in backticks/parens, or followed by trailing
 * punctuation is captured cleanly without swallowing unrelated text.
 *
 * Used by both the intelligence backend (which persists the raw error
 * message) and the observatory frontend (which renders a "Create index"
 * link when this returns non-null) — kept in `shared` so neither side needs
 * to duplicate the pattern.
 */

const FIRESTORE_CONSOLE_URL_PATTERN =
  /https:\/\/console\.firebase\.google\.com\/[^\s'"`)]+/g;

/**
 * Returns the first `console.firebase.google.com` URL in `text` that
 * contains `create_composite=`, or `null` when no such URL is present.
 *
 * When multiple Firebase console URLs are present, the first one that
 * carries `create_composite=` wins (scanning left to right) — a plain
 * console link without that param is not a create-index link and is
 * skipped.
 */
export function extractFirestoreCreateIndexUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const matches = text.match(FIRESTORE_CONSOLE_URL_PATTERN);
  if (!matches) return null;
  const match = matches.find((url) => url.includes('create_composite='));
  return match ?? null;
}
