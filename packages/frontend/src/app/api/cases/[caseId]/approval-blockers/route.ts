import { NextRequest, NextResponse } from 'next/server';
import {
  CaseService,
  FirestorePipelineAdapter,
  createPreconditionEvaluator,
} from '@arbitra/backend';
import { findTransitions } from '@arbitra/shared';
import type { CaseStatus } from '@arbitra/shared';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';
import { selectApprovalBlockers, type ApprovalBlocker } from '@/lib/approval-blockers';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, props: { params: Promise<{ caseId: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;

    const caseService = new CaseService();
    const caseData = await caseService.getCase(params.caseId);
    const status: CaseStatus = caseData.status;

    // Find the approve-target transition from the current status. Multiple
    // variants may exist; union their preconditions so the panel reflects
    // whatever could block any path to `approved`.
    const approveTransitions = findTransitions(status, 'approved', caseData.case_type);
    if (approveTransitions.length === 0) {
      return NextResponse.json({ status, target: null, blockers: [] });
    }

    const preconditionIds = Array.from(
      new Set(approveTransitions.flatMap((t) => t.preconditions)),
    );

    let blockers: ApprovalBlocker[] = [];
    try {
      const adapter = new FirestorePipelineAdapter();
      const ctx = await adapter.loadPreconditionContext(caseData);
      const evaluator = createPreconditionEvaluator(ctx);
      const evaluated = await Promise.all(
        preconditionIds.map(
          async (id) => [id, await evaluator.evaluate(id)] as const,
        ),
      );
      const results = new Map(evaluated);
      blockers = selectApprovalBlockers(preconditionIds, results);
    } catch (evalError) {
      // Fail open: never hard-error the courtroom. An empty blocker list
      // degrades gracefully to "no known blockers" rather than a broken panel.
      // Log it though — a persistent evaluator outage would otherwise silently
      // render "no blockers" and mask a real problem.
      console.error(
        `[approval-blockers] precondition evaluation failed for case ${params.caseId}:`,
        evalError,
      );
      blockers = [];
    }

    return NextResponse.json({ status, target: 'approved', blockers });
  } catch (error) {
    return handleError(error);
  }
}
