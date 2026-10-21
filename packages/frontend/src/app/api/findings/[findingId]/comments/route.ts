import { NextRequest, NextResponse } from 'next/server';
import { validateBody, collections, generateId } from '@arbitra/backend';
import { createCommentSchema, normalizeActorMetadata } from '@arbitra/shared';
import type { Comment } from '@arbitra/shared';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';
import { attachArtifactsToComments, storeCommentAttachments } from '@/lib/comment-attachments';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, props: { params: Promise<{ findingId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    // Look up the finding's case_id to check project access
    const findingDoc = await collections.findings().doc(params.findingId).get();
    const caseId = findingDoc.exists ? findingDoc.data()!.case_id : undefined;
    if (findingDoc.exists) {
      const denied = await requireCaseAccess(caseId!, auth.userId);
      if (denied) return denied;
    }
    const body = await request.json();
    const input = validateBody(createCommentSchema, {
      ...body,
      parent_type: 'finding',
      parent_id: params.findingId,
    });

    if (input.attachments?.length && !caseId) {
      return NextResponse.json(
        { error: { message: 'Finding not found' } },
        { status: 404 },
      );
    }

    const commentId = generateId('comment');
    const attachments = await storeCommentAttachments({
      caseId: caseId!,
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
    return NextResponse.json({ ...comment, attachments }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

export async function GET(request: NextRequest, props: { params: Promise<{ findingId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const findingDoc = await collections.findings().doc(params.findingId).get();
    if (findingDoc.exists) {
      const denied = await requireCaseAccess(findingDoc.data()!.case_id, auth.userId);
      if (denied) return denied;
    }
    const snapshot = await collections.comments()
      .where('parent_type', '==', 'finding')
      .where('parent_id', '==', params.findingId)
      .orderBy('created_at', 'desc')
      .get();

    const comments = await attachArtifactsToComments(snapshot.docs.map((doc) => doc.data()));
    return NextResponse.json({ comments });
  } catch (error) {
    return handleError(error);
  }
}
