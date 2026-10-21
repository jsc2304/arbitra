export const ASSISTANT_FEEDBACK_RATINGS = ['useful', 'not_useful'] as const;

export type AssistantFeedbackRating = (typeof ASSISTANT_FEEDBACK_RATINGS)[number];

/**
 * The requester's current judgement of one immutable Clerk result.
 *
 * One document exists per Case. Revisions replace the current projection while
 * an append-only Case event retains every judgement the requester recorded.
 */
export interface AssistantFeedback {
  schema_version: 1;
  /** Deterministic document id; equal to `case_id`. */
  feedback_id: string;
  case_id: string;
  /** Exact completed assistant attempt whose answer was judged. */
  run_id: string;
  result_evidence_id: string;
  result_artifact_id: string;
  requester_user_id: string;
  rating: AssistantFeedbackRating;
  /** Required human rationale; retained verbatim for later pattern analysis. */
  reason: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface AssistantFeedbackRequest {
  rating: AssistantFeedbackRating;
  reason: string;
}

export interface AssistantFeedbackWriteResponse {
  feedback: AssistantFeedback;
  /** True when the same rating and reason were already current. */
  replayed: boolean;
  /** Present only when this request appended a new audit event. */
  event_id?: string;
}

