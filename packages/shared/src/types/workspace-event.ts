import type { ActorMetadata } from './actor-metadata.js';

/**
 * A workspace-level event NOT scoped to any single case. Used for system
 * actions whose effect spans the whole workspace (scheduled intelligence
 * runs, policy changes, deployments, etc.) so they remain auditable in the
 * activity feed even when they produce no per-case artifacts.
 *
 * Schema choice: a standalone top-level collection (`workspace_events`)
 * rather than a sentinel `case_id` on `case_events` — the Case shape already
 * carries many case-specific invariants (project_id, status, etc.) and
 * polluting it with non-case rows would leak into dashboards and access
 * filters. A dedicated collection keeps the model honest.
 */
export interface WorkspaceEvent {
  event_id: string;
  /**
   * Extensible discriminator. Initial V1 value: `"intelligence_run"`.
   * Future candidates: `"deployment"`, `"policy_changed"`, `"scheduler_paused"`.
   * Left as `string` to avoid forcing a shared-package bump for every new
   * system event — the UI falls back to a generic icon for unknown values.
   *
   * `"unlinked_pull_request"` is recorded by the webhook router when GitHub
   * reports a newly-opened PR that cannot be linked to an existing case. The
   * router does NOT create a case from the PR; operators can inspect the nudge
   * and create/link a case intentionally.
   *
   * `"webhook_repository_id_conflict"` is recorded by the webhook router when a
   * GitHub numeric `repository.id` is owned by more than one Arbitra repository
   * row (or a name/URL-matched row would be backfilled with an id another row
   * already carries). Routing STOPS instead of picking one arbitrary row, so the
   * event is diagnosable rather than silently mis-attributed (see issue #628).
   *
   * `"webhook_repository_url_conflict"` is the `url`-match counterpart (issue
   * #1048): recorded when the webhook router's step-3 fallback finds MORE
   * THAN ONE Arbitra repository row whose `url` resolves to the same
   * `owner/repo` target. UNLIKE `webhook_repository_id_conflict`, routing
   * does NOT stop: registration enforces `url` uniqueness going forward
   * (issue #1048 follow-up F2), but a row pair that predates that guard can
   * still collide, and refusing to route it would leave such a pair
   * permanently unroutable (no id/full_name backfill ever runs, so it can
   * never self-heal) while publishing a case-less `success` on every PR for
   * both rows forever. So step 3 routes deterministically to the OLDEST
   * matching row instead, while still refusing the backfill that would risk
   * stamping identity onto the wrong one — this event exists to tell an
   * operator to deduplicate the rows, not to say routing was blocked.
   *
   * `"commit_status_republished"` is the workspace-level twin of the
   * `CaseEvent` type of the same name (issue #1032): recorded when the
   * admin re-publish endpoint resolves a PR to NO Arbitra case, so the
   * audit trail still exists even though there is no case to attach a
   * `CaseEvent` to.
   *
   * `"changed_files_fetch_failed"` is recorded by the webhook router (issue
   * #1028) when a `pull_request` `opened`/`synchronize` event's real
   * changed-file fetch (`fetchPullRequestChangedFiles`) fails — bad/missing
   * GitHub token, rate limit, network error — rather than the PR genuinely
   * changing no files. Deduped per `(arbitra repository, UTC day)` so a
   * persistently broken token doesn't spam one event per PR/push; makes the
   * failure visible in the activity feed instead of only Cloud Run logs.
   *
   * `"chat_identity_cleared"` is recorded by
   * `PATCH /api/users/:userId/chat-identity` (issue #1069 fix 1) when an
   * admin clears a user's `chat_identity` back to unmapped. The clear-only
   * scope (issue #1069) means `evidence` never
   * carries a NEW `chat_user_id` — only the previous binding being removed.
   */
  type:
    | 'intelligence_run'
    | 'unlinked_pull_request'
    | 'webhook_repository_id_conflict'
    | 'webhook_repository_url_conflict'
    | 'commit_status_republished'
    | 'changed_files_fetch_failed'
    | 'chat_identity_cleared'
    | (string & {});
  /**
   * Authoritative actor id (e.g. `"system:arbitra-intelligence"`). The
   * frontend's system-actor renderer converts `system:*` ids to friendly
   * display names.
   */
  actor_user_id: string;
  /** Authoritative client/model signature for the actor — mirrors CaseEvent payloads. */
  actor_metadata?: ActorMetadata;
  /** ISO timestamp when the event occurred. */
  timestamp: string;
  /** Short human-readable summary rendered directly in the activity feed row. */
  summary: string;
  /**
   * Structured payload for detail views / debugging. No schema is enforced
   * at the collection level — consumers type-narrow based on `type`.
   */
  evidence?: Record<string, unknown>;
  /**
   * When set, the event has been globally resolved by an admin or tech_lead
   * and is hidden from the activity feed for all viewers. `resolved_by`
   * carries the acting user id. Absence means the event is still live. Only
   * a forward move is supported — there is no reopen action.
   */
  resolved_at?: string;
  resolved_by?: string;
}

/**
 * Per-user dismissal record. Workspace events can be dismissed for the
 * current viewer only (leaving the canonical event untouched and visible to
 * others). Doc id is `${user_id}_${event_id}` so lookup by either field is
 * cheap via a prefix / `where` query.
 */
export interface WorkspaceEventDismissal {
  user_id: string;
  event_id: string;
  dismissed_at: string;
}
