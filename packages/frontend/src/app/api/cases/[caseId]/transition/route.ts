import { NextRequest, NextResponse } from 'next/server';
import {
  OrchestrationService,
  validateBody,
  assertBranchUniqueForCase,
} from '@arbitra/backend';
import type { BranchConflictError } from '@arbitra/backend';
import {
  transitionRequestSchema,
  TransitionError,
  getTransitionsFrom,
} from '@arbitra/shared';
import type { CaseStatus, CaseType } from '@arbitra/shared';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';
import { resolveCaseShareUrl } from '@/lib/public-base-url';

const orchestrationService = new OrchestrationService();

/**
 * Build an agent-friendly error response for a failed transition.
 */
function buildTransitionErrorResponse(
  currentStatus: CaseStatus,
  targetStatus: CaseStatus,
  failedPreconditions: { id: string; reason: string }[],
  caseType?: CaseType,
) {
  // Dedupe: some (from, to) pairs have multiple precondition variants
  // (e.g. pending_merge → done via pr_merged OR merge_not_applicable).
  const validTargets = [...new Set(getTransitionsFrom(currentStatus, caseType).map((t) => t.to))];
  const hint = failedPreconditions.some((p) => p.id === 'no_transition_defined')
    ? `No direct transition from '${currentStatus}' to '${targetStatus}'. Valid targets from '${currentStatus}': ${validTargets.join(', ') || 'none'}.`
    : `Transition from '${currentStatus}' to '${targetStatus}' failed preconditions. Resolve the listed issues and retry.`;

  return NextResponse.json(
    {
      error: {
        code: 'INVALID_CASE_TRANSITION',
        message: `Cannot transition from '${currentStatus}' to '${targetStatus}'`,
        current_status: currentStatus,
        target_status: targetStatus,
        failed_preconditions: failedPreconditions,
        valid_targets: validTargets,
        hint,
      },
    },
    { status: 400 },
  );
}

export async function POST(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  let caseType: CaseType | undefined;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;

    // Heartbeat early: pick source from authType so token-auth (MCP) lights
    // up as ide_agent and Firebase-auth (web UI) as web.
    const { safeHeartbeat } = await import('@arbitra/backend');
    await safeHeartbeat({
      caseId: params.caseId,
      userId: auth.userId,
      source: auth.authType === 'token' ? 'ide_agent' : 'web',
    });

    const body = await request.json();
    const input = validateBody(transitionRequestSchema, body);

    // Fix F: Idempotent transitions — if already in the target status, return success
    const { CaseService } = await import('@arbitra/backend');
    const caseService = new CaseService();
    const currentCase = await caseService.getCase(params.caseId);
    caseType = currentCase.case_type;
    if (currentCase.status === input.target_status) {
      const share_url = resolveCaseShareUrl(request, currentCase.case_id, currentCase.status);
      return NextResponse.json(share_url ? { ...currentCase, share_url } : currentCase);
    }

    // One case, one branch: block transitions into in_build when another
    // non-terminal case in the same repo already owns this branch.
    if (input.target_status === 'in_build') {
      await assertBranchUniqueForCase({
        caseId: currentCase.case_id,
        repositoryId: currentCase.repository_id,
        branch: currentCase.current_branch,
      });
    }

    const updated = await orchestrationService.transition(
      params.caseId,
      input.target_status,
      auth.userId,
    );

    // Trigger pipeline for auto-transitions after manual transition.
    // Skip for in_build — the agent is about to implement code, commit, push, and
    // create a PR. The pipeline should NOT advance until the agent posts a build_run.
    if (input.target_status !== 'in_build') {
      try {
        const { FirestorePipelineAdapter, RunCompletionHandler } = await import('@arbitra/backend');
        const pipeline = new RunCompletionHandler(new FirestorePipelineAdapter());
        await pipeline.onRunCompleted(params.caseId);
      } catch {
        // Non-critical
      }
    }

    // Re-fetch case in case pipeline changed the status
    const fresh = await caseService.getCase(params.caseId);
    const share_url = resolveCaseShareUrl(request, fresh.case_id, fresh.status);
    return NextResponse.json(share_url ? { ...fresh, share_url } : fresh);
  } catch (error) {
    // Fix B: Better error messages for TransitionError
    // Use duck-typing — instanceof can fail across bundle boundaries
    const isTransitionError = (e: unknown): e is TransitionError =>
      e instanceof Error && 'fromStatus' in e && 'toStatus' in e && 'failedPreconditions' in e;

    if (isTransitionError(error)) {
      return buildTransitionErrorResponse(
        error.fromStatus,
        error.toStatus,
        error.failedPreconditions,
        caseType,
      );
    }
    // Duck-typed across bundle boundaries
    const isBranchConflict = (e: unknown): e is BranchConflictError =>
      e instanceof Error && (e as { code?: string }).code === 'BRANCH_CONFLICT';
    if (isBranchConflict(error)) {
      return NextResponse.json(
        {
          error: {
            code: 'BRANCH_CONFLICT',
            message: error.message,
            details: (error as BranchConflictError).details,
          },
        },
        { status: 409 },
      );
    }
    return handleError(error);
  }
}
