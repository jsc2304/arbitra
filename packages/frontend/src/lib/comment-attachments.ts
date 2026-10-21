import type { Artifact, InlineAttachment } from '@arbitra/shared';

export async function storeCommentAttachments(input: {
  caseId: string;
  commentId: string;
  actorId: string;
  attachments?: InlineAttachment[];
}): Promise<Artifact[]> {
  if (!input.attachments?.length) return [];

  const { ArtifactService, collections } = await import('@arbitra/backend');
  const artifactService = new ArtifactService();
  const artifacts: Artifact[] = [];

  for (const attachment of input.attachments) {
    const artifact = await artifactService.createFromBase64({
      caseId: input.caseId,
      commentId: input.commentId,
      filename: attachment.filename,
      contentType: attachment.content_type,
      base64Data: attachment.data,
      actorId: input.actorId,
    });
    await collections.artifacts().doc(artifact.artifact_id).set(artifact);
    artifacts.push(artifact);
  }

  return artifacts;
}

export async function attachArtifactsToComments<T extends { comment_id: string }>(
  comments: T[],
): Promise<Array<T & { attachments?: Artifact[] }>> {
  const attachmentRefs = comments.flatMap((comment) => {
    const refs = (comment as T & { attachment_refs?: string[] }).attachment_refs;
    return refs ?? [];
  });

  if (attachmentRefs.length === 0) return comments;

  const { collections } = await import('@arbitra/backend');
  const uniqueRefs = [...new Set(attachmentRefs)];
  const artifacts = await Promise.all(
    uniqueRefs.map(async (artifactId) => {
      const doc = await collections.artifacts().doc(artifactId).get();
      return doc.exists ? doc.data() : null;
    }),
  );
  const artifactMap = new Map(
    artifacts
      .filter((artifact): artifact is Artifact => artifact !== null)
      .map((artifact) => [artifact.artifact_id, artifact]),
  );

  return comments.map((comment) => {
    const refs = (comment as T & { attachment_refs?: string[] }).attachment_refs;
    if (!refs?.length) return comment;
    const commentAttachments = refs
      .map((ref) => artifactMap.get(ref))
      .filter((artifact): artifact is Artifact => artifact !== undefined);
    return commentAttachments.length > 0
      ? { ...comment, attachments: commentAttachments }
      : comment;
  });
}
