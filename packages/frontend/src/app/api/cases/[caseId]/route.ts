import { NextRequest, NextResponse } from 'next/server';
import { CaseService, validateBody } from '@arbitra/backend';
import { updateCaseSchema } from '@arbitra/shared';
import type { Case, CaseStatus } from '@arbitra/shared';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';
import { resolveCaseShareUrl } from '@/lib/public-base-url';

export const dynamic = 'force-dynamic';

const caseService = new CaseService();

const TERMINAL_STATUSES: ReadonlySet<CaseStatus> = new Set(['done', 'rejected']);

/**
 * Body prefixes of the `system:pipeline` `comment_added` events emitted when
 * auto-review gives up (no diff / retries exhausted). Mirrors
 * `NO_DIFF_PIPELINE_COMMENT_PREFIXES` in
 * `packages/backend/src/services/orchestration/preconditions.ts` — the heal
 * pass below only fires when one of these is present.
 */
const NO_DIFF_PIPELINE_COMMENT_PREFIXES = [
  'Auto-review could not start after ',
  'Auto-review skipped: no PR or branch attached',
] as const;

/**
 * Cheap pre-check: returns true iff the case has at least one
 * `system:pipeline` `comment_added` event matching a no-diff failure prefix.
 * Bounds the heal-pass cost to a single Firestore query for healthy cases —
 * the full 6-query precondition fan-out only runs when this signal is
 * present.
 */
async function hasNoDiffPipelineComment(caseId: string): Promise<boolean> {
  const { collections } = await import('@arbitra/backend');
  const snap = await collections.caseEvents().where('case_id', '==', caseId).get();
  return snap.docs.some((d) => {
    const e = d.data();
    if (e.type !== 'comment_added') return false;
    if (e.actor_id !== 'system:pipeline') return false;
    const body = (e.payload as { body?: unknown } | undefined)?.body;
    if (typeof body !== 'string') return false;
    return NO_DIFF_PIPELINE_COMMENT_PREFIXES.some((p) => body.startsWith(p));
  });
}

/**
 * Fire-and-forget heal pass for the `review_not_applicable` flag.
 *
 * The MCP `get_case_context` path triggers this heal via
 * `FirestorePipelineAdapter.loadPreconditionContext` (PR #458). The web UI's
 * case-detail page polls this GET route, which previously never loaded the
 * adapter — so a stale case stuck on `review_run_completed` only unstuck when
 * the user opened it from an IDE agent. We replay the heal-bearing precondition
 * here so a page refresh is enough.
 *
 * Narrow on purpose: only `evaluate('review_run_completed')`, never a full
 * pipeline trigger — auto-transitions on every poll would be a regression.
 * Errors are swallowed (logged via console.warn) so the GET response is never
 * blocked. Skipped when the case has already healed, sits in a terminal
 * status, or lacks the no-diff bypass signature (the only signal the heal
 * cares about — a healthy long-dwell case has no such pipeline comment, so
 * the 1.5s SWR poll stops at the cheap pre-check instead of fanning out into
 * 6 Firestore queries via `loadPreconditionContext`).
 */
function scheduleReviewNotApplicableHeal(caseData: Case): void {
  if (caseData.review_not_applicable === true) return;
  if (TERMINAL_STATUSES.has(caseData.status)) return;

  void Promise.resolve().then(async () => {
    try {
      if (!(await hasNoDiffPipelineComment(caseData.case_id))) return;
      const { FirestorePipelineAdapter, createPreconditionEvaluator } = await import(
        '@arbitra/backend'
      );
      const adapter = new FirestorePipelineAdapter();
      const ctx = await adapter.loadPreconditionContext(caseData);
      const evaluator = createPreconditionEvaluator(ctx);
      await evaluator.evaluate('review_run_completed');
    } catch (err) {
      console.warn(
        `[case-detail] review_not_applicable heal pass failed for ${caseData.case_id}:`,
        err,
      );
    }
  });
}

/**
 * Augment a case-shaped response with a status-aware `share_url` so MCP
 * clients can hand a useful deep link back to the human user. Additive only —
 * never replaces existing fields. See `caseShareUrl` for routing rules.
 */
function withShareUrl<T extends { case_id: string; status: import('@arbitra/shared').CaseStatus }>(
  request: NextRequest,
  caseData: T,
): T & { share_url?: string } {
  const share_url = resolveCaseShareUrl(request, caseData.case_id, caseData.status);
  if (!share_url) return caseData;
  return { ...caseData, share_url };
}

export async function GET(_request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(_request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;
    const caseData = await caseService.getCase(params.caseId);
    scheduleReviewNotApplicableHeal(caseData);
    return NextResponse.json(withShareUrl(_request, caseData));
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;
    const body = await request.json();
    const input = validateBody(updateCaseSchema, body);
    // The internal-only-case_type guard for updates lives in
    // `CaseService.updateCase` (packages/backend/src/services/case/case-service.ts),
    // not here — it must diff against the case's existing case_type (a
    // transition guard), not just the input value, or resubmitting an
    // already-`observed`/`assistant_task` case's unchanged case_type (e.g.
    // editing just the title of an Observed Case) would 400. See #1030 / the
    // #1040 review follow-up.
    const updated = await caseService.updateCase(params.caseId, input, auth.userId);
    return NextResponse.json(withShareUrl(request, updated));
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;
    // Admin role check
    const { collections } = await import('@arbitra/backend');
    const userDoc = await collections.users().doc(auth.userId).get();
    const roles: string[] = userDoc.exists ? (userDoc.data()!.roles ?? []) : [];
    if (!roles.includes('admin')) {
      return NextResponse.json({ error: { message: 'Admin role required' } }, { status: 403 });
    }
    // Soft-delete: mark the doc as deleted but keep related collections
    // (events, findings, evidence, decisions, comments, runs, artifacts) intact
    // for audit. Subsequent getCase returns 404, listCases filters it out.
    await caseService.deleteCase(params.caseId, auth.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleError(error);
  }
}
