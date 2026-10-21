/**
 * AssistantAnswerLookup — the backend-side reader of a case's stored Clerk
 * answer (Slice F, `docs/specs/clerk-config-scheduling-chat.md`). Placed
 * alongside `assistant-task-executor.ts` and `assistant-follow-up-service.ts`
 * — the modules that own the `task_result` artifact's lifecycle — rather
 * than under `services/chat/`, because reading that artifact is an
 * assistant-task concern with its own future consumers (any backend code
 * that ever needs "the answer text for this case", not only the Chat
 * reply path this slice adds first).
 *
 * Mirrors exactly what `GET /api/artifacts/:id/content` already does for
 * the UI (`packages/frontend/src/app/api/artifacts/[artifactId]/content/route.ts`):
 * newest `task_result` evidence row → its artifact doc → storage bytes →
 * parsed result. The one difference is failure handling: the UI route
 * surfaces a 404/500 because a human is looking at a specific case page:
 * this helper is a best-effort read for an automated notification (posting
 * into Chat), so every "no answer yet" and every read/parse failure
 * collapses to `null` — never a thrown error a caller would have to guard.
 */

import { taskResultArtifactRef, parseAssistantTaskResult } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';
import { EvidenceRepository } from '../evidence/evidence-repository.js';
import { ArtifactService } from '../artifact/artifact-service.js';

export class AssistantAnswerLookup {
  constructor(
    private readonly evidenceRepo: EvidenceRepository = new EvidenceRepository(),
    private readonly artifactService: ArtifactService = new ArtifactService(),
  ) {}

  /**
   * Resolves the decoded `answer` text of a case's newest `task_result`
   * artifact, or `null` when there is none yet, the artifact doc is
   * missing/unlinked, or the stored bytes don't parse as an assistant
   * result.
   */
  async getAnswerForCase(caseId: string): Promise<string | null> {
    const evidence = await this.evidenceRepo.getByCaseId(caseId);
    const artifactId = taskResultArtifactRef(evidence);
    if (!artifactId) return null;

    const artifactDoc = await collections.artifacts().doc(artifactId).get();
    if (!artifactDoc.exists) return null;
    const artifact = artifactDoc.data()!;

    try {
      const dataUrl = await this.artifactService.readContent(artifact.storage_path);
      return parseAssistantTaskResult(dataUrl).answer;
    } catch (err) {
      console.warn(
        `[AssistantAnswerLookup] Failed to read/parse task_result artifact ${artifactId} for case ${caseId}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }
}
