import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  actorMetadataSchema,
  createCommentSchema,
  normalizeActorMetadata,
} from '@arbitra/shared';
import type { Comment } from '@arbitra/shared';
import {
  authenticate,
  handleError,
  invalidJsonResponse,
  requireCaseAccess,
  validate,
  validationErrorResponse,
} from '@/lib/api-helpers';
import { resolveCaseShareUrl } from '@/lib/public-base-url';

// ---------------------------------------------------------------------------
// POST /api/agent/explore
//
// High-level action that replaces three separate calls:
//   1. Transition case to `exploration`
//   2. Post exploration summary as a comment (source: ide_agent)
//   3. Create an `exploration_run` (auto-triggers transition to ready_for_build)
// ---------------------------------------------------------------------------

const exploreRequestSchema = z.object({
  case_id: z.string().min(1),
  summary: z.string().min(1),
  actor_metadata: actorMetadataSchema.optional(),
});

export async function POST(request: NextRequest) {
  // --- Parse & validate request body ---
  let body: z.infer<typeof exploreRequestSchema>;
  try {
    const rawBody = await request.json();
    const parsed = exploreRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return validationErrorResponse('Invalid request payload', parsed.error.issues);
    }
    body = parsed.data;
  } catch {
    return invalidJsonResponse();
  }

  const { case_id, summary, actor_metadata: topLevelActorMetadata } = body;

  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(case_id, auth.userId);
    if (denied) return denied;

    const { safeHeartbeat } = await import('@arbitra/backend');
    await safeHeartbeat({ caseId: case_id, userId: auth.userId, source: 'ide_agent' });

    const { CaseService, OrchestrationService, collections, generateId } = await import('@arbitra/backend');
    const caseService = new CaseService();
    const orchestrationService = new OrchestrationService();

    const caseData = await caseService.getCase(case_id);

    // 1. Transition to exploration if currently open
    if (caseData.status === 'open') {
      await orchestrationService.transition(case_id, 'exploration', auth.userId);
    } else if (caseData.status !== 'exploration') {
      return NextResponse.json(
        {
          error: {
            code: 'INVALID_CASE_STATE',
            message: `Case is in '${caseData.status}' — must be 'open' or 'exploration' to explore`,
            details: {
              current_status: caseData.status,
              required_statuses: ['open', 'exploration'],
            },
          },
        },
        { status: 400 },
      );
    }

    // 2. Post exploration summary as a comment. Mirrors the build-complete
    // route so both summary channels carry the same actor_metadata payload
    // and render the same client/model badge in the UI.
    const commentInput = validate(createCommentSchema, {
      parent_type: 'case',
      parent_id: case_id,
      body: summary,
      source: 'ide_agent',
      agent_name: 'ide-agent',
      ...(topLevelActorMetadata !== undefined && { actor_metadata: topLevelActorMetadata }),
    });
    const commentActorMetadata = normalizeActorMetadata(commentInput.actor_metadata);
    const comment: Comment = {
      comment_id: generateId('comment'),
      parent_type: commentInput.parent_type,
      parent_id: commentInput.parent_id,
      author_id: auth.userId,
      body: commentInput.body,
      created_at: new Date().toISOString(),
      source: commentInput.source ?? 'ide_agent',
      ...(commentInput.agent_name !== undefined && { agent_name: commentInput.agent_name }),
      ...(commentActorMetadata !== undefined && { actor_metadata: commentActorMetadata }),
      // Structural tag — lets the dossier locate this summary slot without
      // temporal pairing against the lifecycle event. Server-side only; the
      // request payload is unchanged.
      kind: 'exploration_summary',
    };
    await collections.comments().doc(comment.comment_id).set(comment);

    // 3. Create exploration_run + trigger pipeline
    const { FirestorePipelineAdapter, RunCompletionHandler } = await import('@arbitra/backend');
    const adapter = new FirestorePipelineAdapter();
    const run = await adapter.createRun(case_id, 'exploration_run', auth.userId);
    await adapter.completeRun(run.run_id, case_id, 'Exploration completed via agent action endpoint');
    const pipeline = new RunCompletionHandler(adapter);
    await pipeline.onRunCompleted(case_id);

    // Fetch status after pipeline
    let fresh = await caseService.getCase(case_id);

    // Auto-transition to in_build so agents don't need a separate call
    if (fresh.status === 'ready_for_build') {
      try {
        await orchestrationService.transition(case_id, 'in_build', auth.userId);
        fresh = await caseService.getCase(case_id);
      } catch {
        // Non-critical — agent can still transition manually
      }
    }

    const share_url = resolveCaseShareUrl(request, fresh.case_id, fresh.status);

    return NextResponse.json({
      status: fresh.status,
      message: `Exploration complete. Case is now in '${fresh.status}'.`,
      next: fresh.status === 'in_build'
        ? 'Implement the changes, then call signal_build_complete when done.'
        : `Case is in '${fresh.status}'. Check context endpoint for next steps.`,
      ...(share_url !== null && { share_url }),
    });
  } catch (error) {
    return handleError(error);
  }
}
