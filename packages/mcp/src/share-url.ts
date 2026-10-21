/**
 * Shared snippet appended to tool descriptions for endpoints whose responses
 * include the status-aware `share_url` field. The aim is to nudge IDE agents
 * (Claude Code, Cursor, Codex) into surfacing the link to the user in their
 * summary messages. The full protocol is also declared at the server-level
 * `instructions` string in src/server.ts.
 */
export const SHARE_URL_HINT =
  "Response includes a `share_url` field — surface it to the user as a markdown link (e.g. `[Open case in Arbitra](<share_url>)`) in your summary. The URL is status-aware: cases awaiting a human decision deep-link into the courtroom view; everything else lands on the case page.";
