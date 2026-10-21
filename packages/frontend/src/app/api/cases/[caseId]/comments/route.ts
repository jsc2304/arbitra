import { NextRequest, NextResponse } from 'next/server';
import { validateBody, collections, generateId, safeHeartbeat, CaseService } from '@arbitra/backend';
import { createCommentSchema, normalizeActorMetadata } from '@arbitra/shared';
import type { Comment } from '@arbitra/shared';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';
import { attachArtifactsToComments, storeCommentAttachments } from '@/lib/comment-attachments';
import { resolveCaseShareUrl } from '@/lib/public-base-url';

export const dynamic = 'force-dynamic';

const caseService = new CaseService();

export async function POST(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;

    // Heartbeat: token-auth → ide_agent, firebase → web (see agent-presence spec).
    await safeHeartbeat({
      caseId: params.caseId,
      userId: auth.userId,
      source: auth.authType === 'token' ? 'ide_agent' : 'web',
    });

    const body = await request.json();
    const input = validateBody(createCommentSchema, {
      ...body,
      parent_type: 'case',
      parent_id: params.caseId,
    });

    const commentId = generateId('comment');
    const attachments = await storeCommentAttachments({
      caseId: params.caseId,
      commentId,
      actorId: auth.userId,
      attachments: input.attachments,
    });
    const actorMetadata = normalizeActorMetadata(input.actor_metadata);
    const comment: Comment = {
      comment_id: commentId,
      parent_type: input.parent_type,
      parent_id: input.parent_id,
      author_id: auth.userId,
      body: input.body,
      created_at: new Date().toISOString(),
      source: input.source ?? 'human',
      ...(input.agent_name !== undefined && { agent_name: input.agent_name }),
      ...(actorMetadata !== undefined && { actor_metadata: actorMetadata }),
      ...(attachments.length > 0 && { attachment_refs: attachments.map((a) => a.artifact_id) }),
    };

    await collections.comments().doc(comment.comment_id).set(comment);

    // Surface a status-aware deep link so MCP clients can hand it back to the
    // human user. Best-effort: a status lookup failure must not break the POST.
    let share_url: string | null = null;
    try {
      const caseData = await caseService.getCase(params.caseId);
      share_url = resolveCaseShareUrl(request, caseData.case_id, caseData.status);
    } catch (error) {
      // Degraded Firestore should stay visible; share_url is silently omitted.
      console.warn('[share_url] failed to attach to comments response', {
        case_id: params.caseId,
        error,
      });
    }

    return NextResponse.json(
      share_url !== null ? { ...comment, attachments, share_url } : { ...comment, attachments },
      { status: 201 },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function GET(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;
    const snapshot = await collections.comments()
      .where('parent_type', '==', 'case')
      .where('parent_id', '==', params.caseId)
      .orderBy('created_at', 'desc')
      .get();

    const comments = await attachArtifactsToComments(snapshot.docs.map((doc) => doc.data()));
    return NextResponse.json({ comments });
  } catch (error) {
    return handleError(error);
  }
}
