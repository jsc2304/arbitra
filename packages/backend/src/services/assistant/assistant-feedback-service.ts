import {
  ArbitraError,
  ForbiddenError,
  NotFoundError,
  type AssistantFeedback,
  type AssistantFeedbackRequest,
  type AssistantFeedbackWriteResponse,
  type Case,
} from '@arbitra/shared';
import { collections, getDb } from '../../lib/firestore.js';
import { generateId } from '../../lib/ids.js';
import {
  AssistantFollowUpService,
  assertPinnedFollowUpSources,
} from './assistant-follow-up-service.js';

export class AssistantFeedbackError extends ArbitraError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ASSISTANT_FEEDBACK_INVALID', 409, details);
    this.name = 'AssistantFeedbackError';
  }
}

/** One current feedback projection per immutable Clerk Case. */
export function assistantFeedbackId(caseId: string): string {
  return caseId;
}

function isRequester(case_: Case, actorId: string): boolean {
  return case_.owner_user_id === actorId
    && case_.assistant_context?.requester_user_id === actorId;
}

export interface AssistantFeedbackServiceOptions {
  now?: () => Date;
}

export class AssistantFeedbackService {
  private readonly now: () => Date;
  private readonly followUps = new AssistantFollowUpService();

  constructor(options: AssistantFeedbackServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** Requesters see their own feedback; admins may inspect but never submit it. */
  async get(caseId: string, actorId: string): Promise<AssistantFeedback | null> {
    const [caseSnap, actorSnap, feedbackSnap] = await Promise.all([
      collections.cases().doc(caseId).get(),
      collections.users().doc(actorId).get(),
      collections.assistantFeedback().doc(assistantFeedbackId(caseId)).get(),
    ]);
    if (!caseSnap.exists || caseSnap.data()!.deleted_at) {
      throw new NotFoundError('Case', caseId);
    }
    const case_ = caseSnap.data()!;
    const isAdmin = actorSnap.data()?.roles?.includes('admin') ?? false;
    if (!isRequester(case_, actorId) && !isAdmin) {
      throw new ForbiddenError('Only the Clerk requester or an admin can inspect this feedback.', {
        case_id: caseId,
      });
    }
    if (case_.case_type !== 'assistant_task' || case_.status !== 'done') {
      throw new AssistantFeedbackError('Feedback is available only for completed Clerk tasks.', {
        case_id: caseId,
      });
    }
    return feedbackSnap.exists ? feedbackSnap.data()! : null;
  }

  /**
   * Record the requester's current judgement without reopening or mutating the
   * completed Case. Identical retries are no-ops; changed judgements append a
   * new audit event and advance the projection revision.
   */
  async record(
    caseId: string,
    actorId: string,
    input: AssistantFeedbackRequest,
  ): Promise<AssistantFeedbackWriteResponse> {
    // This also enforces requester-only access and resolves the exact newest
    // completed Run/Evidence/Artifact tuple before the transaction begins.
    const link = await this.followUps.resolveParentLink(caseId, actorId);
    const feedbackRef = collections.assistantFeedback().doc(assistantFeedbackId(caseId));
    const parentRef = collections.cases().doc(caseId);
    const runRef = collections.runs().doc(link.prior_run_id);
    const evidenceRef = collections.evidence().doc(link.prior_result_evidence_id);
    const artifactRef = collections.artifacts().doc(link.prior_result_artifact_id);

    return getDb().runTransaction(async (tx) => {
      const [feedbackSnap, parentSnap, runSnap, evidenceSnap, artifactSnap] = await Promise.all([
        tx.get(feedbackRef),
        tx.get(parentRef),
        tx.get(runRef),
        tx.get(evidenceRef),
        tx.get(artifactRef),
      ]);
      const parent = parentSnap.data();
      if (!parent) throw new NotFoundError('Case', caseId);
      assertPinnedFollowUpSources(
        link,
        actorId,
        parent.project_id,
        parent.repository_id,
        {
          parent,
          run: runSnap.data(),
          evidence: evidenceSnap.data(),
          artifact: artifactSnap.data(),
        },
      );

      const existing = feedbackSnap.data();
      if (existing && (
        existing.case_id !== caseId
        || existing.feedback_id !== assistantFeedbackId(caseId)
        || existing.requester_user_id !== actorId
        || existing.run_id !== link.prior_run_id
        || existing.result_evidence_id !== link.prior_result_evidence_id
        || existing.result_artifact_id !== link.prior_result_artifact_id
      )) {
        throw new AssistantFeedbackError('Existing feedback does not match the completed result.', {
          case_id: caseId,
        });
      }
      if (existing?.rating === input.rating && existing.reason === input.reason) {
        return { feedback: existing, replayed: true };
      }

      const now = this.now().toISOString();
      const eventId = generateId('event');
      const feedback: AssistantFeedback = {
        schema_version: 1,
        feedback_id: assistantFeedbackId(caseId),
        case_id: caseId,
        run_id: link.prior_run_id,
        result_evidence_id: link.prior_result_evidence_id,
        result_artifact_id: link.prior_result_artifact_id,
        requester_user_id: actorId,
        rating: input.rating,
        reason: input.reason,
        revision: (existing?.revision ?? 0) + 1,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      tx.set(feedbackRef, feedback);
      tx.create(collections.caseEvents().doc(eventId), {
        event_id: eventId,
        case_id: caseId,
        type: 'assistant_feedback_recorded',
        actor_id: actorId,
        payload: {
          feedback_id: feedback.feedback_id,
          run_id: feedback.run_id,
          result_evidence_id: feedback.result_evidence_id,
          result_artifact_id: feedback.result_artifact_id,
          rating: feedback.rating,
          reason: feedback.reason,
          revision: feedback.revision,
        },
        created_at: now,
      });
      return { feedback, replayed: false, event_id: eventId };
    });
  }
}
