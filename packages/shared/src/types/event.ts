export type EventType =
  | 'case_created'
  | 'case_deleted'
  | 'track_assigned'
  | 'exploration_requested'
  | 'exploration_completed'
  | 'case_ready_for_build'
  | 'build_started'
  | 'validation_requested'
  | 'validation_started'
  | 'review_requested'
  | 'review_started'
  | 'human_decision_requested'
  | 'human_decision_recorded'
  | 'manual_verification_requested'
  | 'manual_validation_confirmed'
  | 'auto_approve_decision'
  | 'case_approved'
  | 'merge_ready'
  | 'pr_merged'
  | 'merge_skipped_not_applicable'
  | 'case_auto_closed_on_merge'
  | 'case_anomaly_merge_on_gated_status'
  | 'case_completed'
  | 'case_rejected'
  | 'changes_requested'
  | 'run_created'
  | 'run_started'
  | 'run_completed'
  | 'run_failed'
  | 'run_retries_exhausted'
  | 'evidence_registered'
  | 'evidence_missing_detected'
  | 'finding_created'
  | 'finding_updated'
  | 'rule_results_attached'
  | 'rule_override_created'
  | 'decision_created'
  | 'risk_level_changed'
  /**
   * A case-detail edit other than risk_level: title, description, case_type,
   * priority, or validation_track. One event per `CaseService.updateCase`
   * call, diffed against the existing doc so a no-op PATCH (same value
   * re-submitted) never emits. Payload: `{ changed: string[] }` plus, for
   * every field in `changed` except `description`, a `{ from, to }` entry
   * keyed by that field name (`title`, `case_type`, `priority`,
   * `validation_track`) — `description` is listed in `changed` but carries
   * no old/new body, only a changed-marker. Not in `NOTIFICATION_EVENT_DEFAULTS`
   * and not handled in `EventNotifier.onCaseEvent`'s switch — deliberately
   * timeline-only, no notification fan-out.
   */
  | 'case_updated'
  | 'comment_added'
  | 'knowledge_asset_created'
  | 'knowledge_asset_status_changed'
  | 'knowledge_asset_updated'
  | 'knowledge_asset_deleted'
  | 'role_changed'
  | 'gate_pending'
  | 'gate_confirmed'
  | 'gate_rejected'
  | 'profile_changed'
  | 'assistant_task_received'
  | 'assistant_task_started'
  | 'assistant_task_completed'
  | 'assistant_task_failed'
  /**
   * The assistant gave up on this task: an attempt failed for a reason no
   * retry can change, so no further attempt will be made. Distinct from
   * `assistant_task_failed`, which reports ONE attempt's outcome and is also
   * emitted for failures that do get retried. Carries the run id it documents,
   * which is what `assistant_terminal_failure_documented` scopes against.
   */
  | 'assistant_task_abandoned'
  | 'assistant_task_cancelled'
  | 'assistant_feedback_recorded'
  /** Immutable trace/usage receipt for one cancelled assistant Run. */
  | 'run_cancelled'
  /**
   * Human-filed counterpart to the pipeline's `review_marked_not_applicable`:
   * emitted when a `review_not_applicable` decision sets the case flag.
   * Distinct type (rather than reusing `review_marked_not_applicable`) so the
   * timeline/activity feed can attribute the flag to a human decision instead
   * of an automated pipeline bypass.
   */
  | 'review_not_applicable_marked'
  /**
   * Emitted by the `open → in_build` transition of the `observed` case-type
   * lifecycle slice (issue #986). Marks the moment an auto-created Observed
   * Case starts being tracked as active work — mirrors
   * `assistant_task_started`'s role for the assistant slice.
   */
  | 'observed_case_started'
  /**
   * Emitted when `evaluateObservedCaseEscalation` (issue #987 / ADR-0001)
   * flips an Observed Case out of the shortened `observed` lifecycle slice
   * into the full engineering lifecycle because the project's escalation
   * policy and the case's (re-)assessed risk level demanded it. Payload
   * carries `from_case_type: 'observed'`, `to_case_type` (the detected case
   * type the case re-enters the engineering matrix as), `from_risk_level`
   * (the case's `risk_level` immediately before this evaluation — issue
   * #1029, so the transition is reconstructable from this one event, not
   * just its destination), `risk_level` (the new value), `risk_level_reason`,
   * and `threshold`/`rule` naming the policy cause — this is the
   * case-history record the acceptance criteria requires ("the rule that
   * caused it" must be readable from the timeline).
   */
  | 'case_escalated'
  /**
   * Audit record for the admin-only `arbitra/case` commit-status recovery
   * path (issue #1032): an operator manually re-published the status for
   * this case's PR — e.g. after a GitHub API error, a lost webhook
   * delivery, or a rate-limit swallowed by `publishCaseCommitStatus`'s
   * fail-soft contract. Payload carries `pr_url`, `published`, and either
   * `state` (on success) or `failure_reason` (on failure) — see
   * `republishCommitStatus` in `commit-status-admin-service.ts`, which
   * emits this event whether or not the re-publish itself succeeded, so
   * every attempt is auditable. Timeline-only — not handled in
   * `EventNotifier.onCaseEvent`'s switch, so it never re-triggers a
   * publish or a notification.
   */
  | 'commit_status_republished'
  | (string & {});

export interface CaseEvent {
  event_id: string;
  case_id: string;
  type: EventType;
  actor_id: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface CreateEventInput {
  case_id: string;
  type: EventType;
  payload: Record<string, unknown>;
}
