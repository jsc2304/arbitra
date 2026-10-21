import type { Artifact, InlineAttachment } from '@arbitra/shared';
import { generateId } from '../../lib/ids.js';
import { getArtifactStorage } from '../../lib/artifact-storage.js';

export class ArtifactService {
  /**
   * Store a single artifact from base64-encoded data.
   */
  async createFromBase64(input: {
    caseId: string;
    commentId?: string;
    filename: string;
    contentType: string;
    base64Data: string;
    actorId: string;
  }): Promise<Artifact> {
    const storage = getArtifactStorage();

    const storagePath = await storage.save(
      input.filename,
      input.contentType,
      input.base64Data,
    );

    const sizeBytes = Math.ceil(input.base64Data.length * 3 / 4);

    const artifact: Artifact = {
      artifact_id: generateId('artifact'),
      case_id: input.caseId,
      ...(input.commentId !== undefined && { comment_id: input.commentId }),
      filename: input.filename,
      content_type: input.contentType,
      storage_path: storagePath,
      size_bytes: sizeBytes,
      created_by: input.actorId,
      created_at: new Date().toISOString(),
    };

    return artifact;
  }

  /**
   * Process inline attachments from a case creation request.
   * Returns created Artifact records.
   */
  async processInlineAttachments(
    caseId: string,
    attachments: InlineAttachment[],
    actorId: string,
  ): Promise<Artifact[]> {
    const results: Artifact[] = [];

    for (const att of attachments) {
      const artifact = await this.createFromBase64({
        caseId,
        filename: att.filename,
        contentType: att.content_type,
        base64Data: att.data,
        actorId,
      });
      results.push(artifact);
    }

    return results;
  }

  /**
   * Read artifact content as a data URL.
   */
  async readContent(storagePath: string): Promise<string> {
    const storage = getArtifactStorage();
    return storage.read(storagePath);
  }
}
