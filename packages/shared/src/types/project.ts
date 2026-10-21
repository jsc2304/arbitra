import type { LlmProviderName } from './llm-settings.js';
import type { RiskLevel } from './case.js';
import type { LifecycleProfile } from './lifecycle-profile.js';
import type { NotificationEvent } from './notification.js';

export interface Project {
  project_id: string;
  name: string;
  description: string;
  owner_user_id?: string;
  reviewer_pool: string[];
  tech_leads: string[];
  members?: string[];
  default_evidence_policy_id?: string;
  default_rule_set_refs: string[];
  notification_webhook_url?: string;
  /** Per-event message templates with {{placeholder}} variables. Keys are NotificationEvent names. */
  notification_templates?: Partial<Record<string, string>>;
  /**
   * Per-project override of the Google Chat dispatch default for each
   * catalog event (`NOTIFICATION_EVENT_DEFAULTS`,
   * `constants/notification-events.ts`). A key absent from this map falls
   * back to the catalog default — see `resolveEventChatEnabled` in
   * `packages/backend/src/services/notification/notification-dispatcher.ts`.
   */
  notification_events?: Partial<Record<NotificationEvent, boolean>>;
  /**
   * Delivery observability for the Google Chat webhook send path (spec
   * Slice C item 4, `docs/specs/clerk-config-scheduling-chat.md`).
   * Server-owned: written by `NotificationDispatcher.dispatch` and the
   * `test-webhook` route after each real send attempt, never by a client
   * PATCH (`notificationConfigSchema` rejects it — see
   * `project-validators.ts`). `last_success_at` and `last_error` are
   * independent — a success does NOT clear a previous `last_error`, so the
   * Integrations tab can show "last delivered X ago" and "last error Y" at
   * the same time. A missing/unconfigured webhook is config, not a
   * delivery failure, and does not touch this field.
   */
  notification_delivery?: {
    last_success_at?: string;
    last_error?: {
      /** ISO timestamp of the failed attempt. */
      at: string;
      /** HTTP status as a string (e.g. "429", "500") or "network_error" when the fetch itself threw. */
      code: string;
      /** Response body text (truncation is the caller's concern) or the thrown error's message. */
      message: string;
    };
  };
  /** Optional per-project LLM overrides. Unset fields inherit from global settings. */
  llm_overrides?: {
    provider?: LlmProviderName;
    models?: Partial<Record<RiskLevel, string>>;
  };
  /** Lifecycle profile controlling case autonomy. Defaults to 'standard' if absent. */
  lifecycle_profile?: LifecycleProfile;
  /** Default validation track for new cases. IDE agents can override per-case. Defaults to 'direct' if absent. */
  default_validation_track?: 'direct' | 'manual';
  /** Default written language for case comments, descriptions, and summaries authored by IDE agents. 'en' if unset. */
  default_language?: 'en' | 'de';
  created_at: string;
  updated_at: string;
}

export interface Repository {
  repository_id: string;
  project_id: string;
  name: string;
  url: string;
  provider: 'github' | 'gitlab' | 'other';
  webhook_secret?: string;
  /** GitHub PAT for fetching PR diffs during AI review. Falls back to global GITHUB_TOKEN env var. */
  github_token?: string;
  /**
   * Immutable numeric id assigned by GitHub to the repository (`repository.id`
   * on webhook payloads). This survives org/repo renames, so matching by it is
   * the only way to keep webhook → case routing alive when a user renames the
   * repo on GitHub. Optional because legacy rows predate the field; the
   * webhook handler opportunistically backfills it on the first event that
   * hits the legacy (full_name) fallback path.
   */
  github_repository_id?: number;
  /**
   * Cached `owner/repo` slug from GitHub (`repository.full_name`). Used as the
   * legacy fallback matcher and kept in sync when `repository.renamed` events
   * arrive. Previously derived on the fly from `url`; stored now so lookups
   * don't have to parse URLs in the hot path.
   */
  github_full_name?: string;
  /**
   * ISO timestamp of the first time a `pull_request` webhook event arrived for
   * this repo. Used to detect push-only subscriptions: if a `push` arrives
   * more than 24h after the row was created but this field is still unset,
   * the GitHub hook is almost certainly missing the `pull_request` event and
   * auto-close on merge will never fire. Absence means "never seen".
   */
  pull_request_event_seen_at?: string;
  /**
   * ISO timestamp of the `webhook_misconfigured` workspace event emitted for
   * this repo. Used to dedupe: we surface the warning once per repo and let
   * the UI keep rendering it until a `pull_request` event arrives and flips
   * `pull_request_event_seen_at`.
   */
  webhook_misconfig_warned_at?: string;
  /**
   * GitHub's actual default branch (`repository.default_branch` on every
   * webhook payload that carries a `repository` object — `pull_request`,
   * `push`, `repository`). Opportunistically backfilled the same way
   * `github_repository_id`/`github_full_name` are (`backfillRepositoryIdentity`
   * in `webhook-service.ts`) the first time a webhook for this repo arrives.
   * Optional because a repo that has never received a webhook has no stored
   * value yet — Observed Case default-branch exclusion (issue #1009,
   * `isDefaultBranchName` in `@arbitra/shared`) falls back to a name
   * heuristic (`main`/`master`) for that case.
   */
  default_branch?: string;
  created_at: string;
  updated_at: string;
}
