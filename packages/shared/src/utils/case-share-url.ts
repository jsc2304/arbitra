import type { CaseStatus } from '../types/case.js';

/**
 * Build a status-aware deep link for a case, suitable for surfacing back to a
 * human user from an IDE agent (Claude Code, Cursor, Codex via MCP).
 *
 * The URL is chosen so the human lands on the most useful screen given the
 * case's current state:
 *
 *   - `needs_human_decision` → `/cases/<id>/courtroom`
 *     A reviewer needs to approve / request changes / reject. The courtroom
 *     view is where decisions are made, so jump straight there.
 *   - `done` / `rejected` → `/cases/<id>`
 *     Terminal states. There is no `/decision` route today (verified against
 *     `packages/frontend/src/app/cases/[caseId]/`); the case detail page is
 *     the canonical fallback.
 *   - everything else → `/cases/<id>`
 *     Active / in-progress states route to the case detail page.
 *
 * The function is intentionally pure — `baseUrl` is provided by the caller so
 * each route can derive it from its own request context (env var or
 * forwarded-host headers, see existing pattern in
 * `packages/frontend/src/app/api/init/[...path]/route.ts`). A trailing slash
 * on `baseUrl` is stripped so the result never contains `//cases/...`.
 */
export function caseShareUrl({
  baseUrl,
  caseId,
  status,
}: {
  baseUrl: string;
  caseId: string;
  status: CaseStatus;
}): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const casePath = `${trimmedBase}/cases/${caseId}`;
  switch (status) {
    case 'needs_human_decision':
      return `${casePath}/courtroom`;
    case 'done':
    case 'rejected':
      // No dedicated `/decision` route exists; fall back to the case detail page.
      return casePath;
    default:
      return casePath;
  }
}
