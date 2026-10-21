import { ValidationError, SCOPED_CASE_TYPES } from '@arbitra/shared';
import type { CaseType } from '@arbitra/shared';

// `observed` and `assistant_task` are documented as system-created only:
// `observed` cases come from the git-signal sweep's atomic claim/dedup
// (packages/backend/src/services/case/observed-case-service.ts) and
// `assistant_task` cases come from the assistant intake transaction
// (packages/backend/src/services/assistant/assistant-intake-service.ts).
// Neither path calls `CaseService.createCase` — it writes the case document
// directly — so this guard only ever blocks the public boundary (this route,
// and MCP `create_case`, a thin client of it) and never the internal writers.
//
// `SCOPED_CASE_TYPES` (packages/shared/src/constants/status-transitions.ts)
// is the single source of truth for which case types are internal-only —
// `commit-status-service.ts`'s Enforced-Case guard already imports it for
// the same reason (issue #988: "so the two can never drift apart"). Reuse it
// here instead of re-deriving the set, so a future internal-only case type
// can't silently escape this guard.
//
// `case_type` itself stays mutable through the public surface for the
// non-internal values — the case-detail edit modal
// (packages/frontend/src/components/case/case-header-edit-modal.tsx) lets a
// user reclassify e.g. `bugfix` -> `refactoring` via PATCH. Only the two
// internal values are blocked here, on create. The equivalent guard on
// *update* lives in `CaseService.updateCase`
// (packages/backend/src/services/case/case-service.ts): it must be a
// transition guard, not a value guard, because a PATCH that merely
// resubmits an already-`observed`/`assistant_task` case's unchanged
// case_type (e.g. editing just the title of an Observed Case) has to keep
// working — see #1040 review follow-up.

/**
 * Throws `ValidationError` if `caseType` is one of the internal-only case
 * types. Used by the public create path (`POST /api/cases`) — there is no
 * "existing" case to diff against on create, so any internal-only value is
 * rejected outright.
 */
export function assertPubliclyCreatableCaseType(caseType: CaseType | undefined): void {
  if (caseType && SCOPED_CASE_TYPES.has(caseType)) {
    throw new ValidationError(
      `case_type '${caseType}' is system-created only and cannot be set via this endpoint`,
      { case_type: caseType },
    );
  }
}
