# Database schema (Firestore)

Arbitra stores all state in Firestore. Every collection is declared in [`packages/backend/src/lib/firestore.ts`](../packages/backend/src/lib/firestore.ts) (the `collections` object), and the document types live in [`packages/shared/src/types/`](../packages/shared/src/types/). Composite indexes are in [`firestore.indexes.json`](../firestore.indexes.json). [`firestore.rules`](../firestore.rules) denies every direct client access; the server uses the Firebase Admin SDK, which bypasses rules.

Conventions:

- There are no subcollections. Documents refer to each other by id fields (`case_id`, `project_id`, `parent_id`, and so on).
- Timestamps are ISO-8601 strings.
- Most ids are a prefix plus 16 random characters (`run_`, `fnd_`, `ev_`, `dec_`, `cmt_`, `proj_`, `repo_`, `tok_`, `evt_` and others, from `lib/ids.ts`). Case ids look like `case-<adjective>-<noun>-<4 chars>`. User ids are Firebase Auth uids.
- Some collections use a computed document id and are never queried, only read by id: device codes, rate-limit counters, intake receipts, session-signal receipts, observed-case claims, chat thread links, locks. The computed id is what makes an atomic claim or an idempotent write possible.
- Cases are soft-deleted (`deleted_at`, `deleted_by`). Code that lists or searches cases reads `collections.activeCases()`, which filters on `deleted_at == null`; the raw `collections.cases()` is for audit paths and the delete itself.

## Cases and lifecycle

| Collection | Document id | Purpose and notable fields |
|------------|-------------|----------------------------|
| `cases` | `case_id` | The unit of governed work. Fields: `title`, `description`, `project_id`, `repository_id`, `owner_user_id`, `assigned_reviewer_id`, `status` (12 values, see below), `validation_track` (`direct` or `manual`), `risk_level` (`low` to `critical`), `priority`, `case_type`, `source_type` (`jira`, `manual`, `git`, `google_chat`, `other`), `current_branch`, `current_pr_ref`, `current_head_sha`, `approved_head_sha`, `active_rule_set_refs`, `knowledge_context_refs`, `decision_ready`, `pending_gate`, `review_not_applicable`, `intelligence_flags`, `assistant_context`, `assistant_thread`, `assistant_cancel_intent`. |
| `case_events` | `event_id` | Append-only audit trail (the rules forbid update and delete). One document per lifecycle event with `case_id`, `type`, `actor_id`, `created_at` and an untyped `payload`. Drives the timeline, the activity feed and notifications. |
| `case_templates` | `template_id` | Per-project defaults for case creation (`defaults`: case type, risk, priority, track, title prefix, description template, rule sets). |

Statuses: `open`, `exploration`, `ready_for_build`, `in_build`, `in_validation`, `in_review`, `needs_human_decision`, `verification_pending`, `approved`, `pending_merge`, `done`, `rejected`. Transitions and preconditions are defined in `packages/shared/src/constants/status-transitions.ts`.

Case types: `ticket_implementation`, `bugfix`, `refactoring`, `security_review`, `pr_review`, `manual_verification`, `other`, plus two system types with shortened lifecycles: `observed` (created from session signals and PR activity) and `assistant_task` (Clerk tasks).

Notes on `cases`:

- `current_head_sha` is the latest pull request head commit Arbitra has seen. `approved_head_sha` is the commit an approval covers. It is written on every transition to `approved` and is what the `arbitra/case` commit status compares against, so a commit pushed after approval does not inherit the approval.
- `current_branch` and `current_pr_ref` are locked once a case reaches `approved`, `pending_merge`, `done` or `rejected`. A branch can be owned by at most one non-terminal case per repository.
- `assistant_context` carries Clerk request metadata (channel, requester, Chat coordinates, blueprint reference, outcome flags). `assistant_thread` and `assistant_cancel_intent` are system-owned; the public case routes cannot set them.
- `intelligence_flags` holds detector findings that target the case (see [`intelligence.md`](./intelligence.md)).

## Runs, findings and decisions

| Collection | Document id | Purpose and notable fields |
|------------|-------------|----------------------------|
| `runs` | `run_id` | One document per pipeline run. `run_type` is one of `exploration_run`, `implementation_run`, `review_run`, `rule_run`, `build_run`, `test_run`, `evidence_collection_run`, `manual_validation_run`, `assistant_task_run`, `assistant_action_run`. `status`: `pending`, `running`, `completed`, `failed`, `cancelled`. Lease fields (`lease_expires_at`, `worker_id`) let the sweeper detect abandoned runs; `attempt`, `retry_at` and `retry_dispatched` implement durable retries; `reviewed_head_sha` binds a review to the commit it reviewed; the `assistant_*` fields carry Clerk policy, cancellation and repair state. |
| `findings` | `finding_id` | AI review and rule engine output. `severity` (`info` to `critical`), `confidence`, `status` (`open`, `accepted`, `fixed`, `waived`, `contested`, `resolved`, `waiver_proposed`, `waived_on_completion`), `origin_type`, `origin` (`authored`, `submodule`, `vendored`), `signature` (deduplicates findings across re-reviews), `consensus`, and the verification fields (`verification_status`, `verification_note`, `verifier_model`). `waiver_proposed` is an agent-suggested waiver that still blocks approval until a human confirms it. |
| `raw_review_observations` | generated | Untyped reviewer output before consolidation into findings. Debugging and audit. |
| `decisions` | `decision_id` | One document per human or system decision: `approve`, `waive`, `propose_waiver`, `request_changes`, `reject`, `escalate`, `manual_validation_confirmed`, `merge_not_applicable`, `review_not_applicable`, `gate_confirmed`, `gate_rejected`, `auto_approve`, `waived_on_completion`. The rationale field is `rationale`. `snapshot` records the rule set versions, evidence policy version and knowledge assets in force. The server alone writes `auto_approve` and `waived_on_completion`. |
| `comments` | `comment_id` | Discussion on a case or finding (`parent_type`, `parent_id`), with `source` (`human`, `ide_agent`, `google_chat`), `actor_metadata` and `attachment_refs`. `kind` marks server-written lifecycle summaries. |

## Evidence and rules

| Collection | Document id | Purpose and notable fields |
|------------|-------------|----------------------------|
| `evidence` | `evidence_id` | Test results, CI results, screenshots, manual confirmations and similar items for a case. `type` is open (`unit_test_result`, `integration_test_result`, `ci_result`, `lint_result`, `runtime_log`, `screenshot`, `diff_snapshot`, `manual_confirmation`, `benchmark_result`, `external_reference`, `pr_merged`, `detection_report`, plus custom types). `source_type`: `automated`, `manual`, `webhook`, `agent`. |
| `evidence_policies` | `policy_id` | Required and optional evidence per `(risk_level, validation_track)` cell, with `four_eyes_required` and `allow_self_approval`. Stored risk first, track second. A missing cell inherits the built-in default; a cell can state explicitly that no evidence is required. `escalation.risk_threshold` (default `high`) sets the risk at which an observed case enters the enforced lifecycle. |
| `rules` | `rule_id` | Rule definitions with `category`, `scope` (`global` or `project` layer), `evaluation_mode` (`metadata_check`, `diff_pattern`, `evidence_check`, `llm_evaluation`, `human_confirmation`), `severity_if_failed`, `config`, `status`, `version`. Global rules are admin-only; project rules need a tech lead or admin who is a member of the project. |
| `rule_sets` | `rule_set_id` | Bundles of rules attached to cases through `active_rule_set_refs`. Same role rules as `rules`. |
| `rule_results` | `rule_result_id` | Result of evaluating one rule for one case in one run (`pass`, `fail`, `warning`, `not_applicable`, `blocked`). |
| `rule_overrides` | `override_id` | States that one rule overrides another within a scope, with frozen version numbers for audit. |

## Knowledge and artifacts

| Collection | Document id | Purpose and notable fields |
|------------|-------------|----------------------------|
| `knowledge_assets` | `knowledge_id` | Reusable patterns, anti-patterns, decisions and guidelines. `scope_type` (`global`, `org`, `team`, `project`, `repo`) with `scope_ref`, `status` (`suggested`, `verified`, `canonical`, `deprecated`, `superseded`), `trust_level`, `tags`, `expires_at`, `always_inject`. Clerk stores per-user context entries here as `clerk_context` assets in the user's private project. The Helper bot reads every asset. |
| `artifacts` | `artifact_id` | Metadata (`filename`, `content_type`, `size_bytes`, `storage_path`) for files attached to cases, runs or comments. The bytes live in the artifact storage backend (GCS bucket or local disk). |

## Projects, users and access

| Collection | Document id | Purpose and notable fields |
|------------|-------------|----------------------------|
| `projects` | `project_id` | Groups repositories and people. `reviewer_pool`, `tech_leads`, `members`, `default_evidence_policy_id`, `default_rule_set_refs`, `lifecycle_profile` (preset, per-gate overrides, `gate_confirmer_roles`), `llm_overrides`, `default_language` (`en` or `de`), and Google Chat notification settings (`notification_webhook_url`, `notification_events`, `notification_delivery`). |
| `repositories` | `repository_id` | A Git repository of a project: `url`, `provider`, `github_full_name`, `github_repository_id`, `default_branch`, and an encrypted `github_token`. Webhook routing matches on the repository id, then the full name, then the URL. |
| `users` | Firebase uid | Profile synced from Firebase Auth at sign-in: `email`, `display_name`, `roles` (`developer`, `reviewer`, `tech_lead`, `admin`), personal Chat webhook, Chat identity mapping, conversation window. |
| `tokens` | `token_id` | Arbitra access tokens for IDE agents and CI. Only `token_hash` (SHA-256) and a display prefix are stored. Per-tool fields: `client_name`, `client_version`, `device_id`, `device_label`, `created_via` (`manual`, `unified_connect`, `ci_service`). |
| `device_codes` | `sha256(device_code)` | Pending, approved, denied and consumed device-flow grants. The raw device code is never stored. `expires_at` is 10 minutes after creation. |
| `auth_rate_limits` | `sha256(ip)` or `<bucket>_<sha256(user_id)>` | Sliding-window request timestamps: per caller IP for the unauthenticated device-flow init endpoint (10 per minute), per user for device-code lookup (30 per minute) and Helper bot questions. Fails open on storage errors. |
| `notifications` | `notification_id` | Per-user in-app notifications (`type`, `title`, `body`, `case_id`, `read`). |

## Settings and workspace events

| Collection | Document id | Purpose and notable fields |
|------------|-------------|----------------------------|
| `settings` | `llm` (single document) | Workspace LLM settings: `provider`, per-risk `models`, optional `consensus_models`. Takes precedence over the model environment variables. |
| `prompt_templates` | `template_id` | Versioned prompts identified by `slug`, one active version per slug. |
| `workspace_events` | `event_id` | System events that belong to no case: intelligence runs and nudges, unlinked pull requests, webhook misconfiguration, commit status republishing, cleared Chat identities. `resolved_at` hides an event for everyone. |
| `workspace_event_dismissals` | `<user_id>_<event_id>` | A user's dismissal of one workspace event. |

## Background work, assistant and sessions

| Collection | Document id | Purpose and notable fields |
|------------|-------------|----------------------------|
| `intelligence_runs` | `run_id` | History of detector runs (scheduled or manual) with per-detector summaries. |
| `intelligence_config` | `detectors` (single document) | Per-detector enable flags. A missing document or entry means enabled. |
| `intelligence_locks` | `run:intelligence` | Lock against overlapping intelligence runs. Expires after 10 minutes. |
| `case_pipeline_locks` | `run:pipeline:<case_id>` | Per-case lock so two evaluations of the same case do not race. |
| `run_sweep_locks` | `run:sweep`, `run:sweep:assistant` | Locks against overlapping sweeper calls. |
| `helper_bot_logs` | `log_id` | One document per Helper bot question: the question, a 500-character answer preview, latency, token counts. |
| `agent_presence` | `<case_id>__<actor_user_id>` | Heartbeat of an IDE agent working on a case. Stale rows are filtered by `last_seen_at` in code. |
| `task_blueprints` | `bp_…` | Versioned, owner-scoped recurring Clerk tasks: `prompt_text`, `cron_schedule`, `timezone`, `enabled`, `archived_at`, `overlap_policy`, `missed_run_policy`. Each occurrence is a normal `assistant_task` case that points back through `assistant_context.blueprint_id` and keeps a snapshot of the prompt. |
| `assistant_intake_receipts` | computed `air_…` | Idempotency receipts for Clerk task requests, keyed by channel, requester and caller key. A repeated request resolves to the same case. Kept 30 days. |
| `assistant_feedback` | generated | The requester's current judgement of one completed Clerk result. |
| `chat_thread_links` | computed `ctl_…` | Pointer from a Google Chat thread or direct conversation to its latest Clerk case. A routing hint, overwritten on each new turn. |
| `sessions` | `session_id` | Registry of IDE sessions, upserted by session signals: agent, repository, branch, `last_seen_at`, `ended`. Mission Control reads it. |
| `session_signal_events` | `sha256(event_id)` | Receipt per accepted session signal, so redelivery changes nothing. |
| `observed_case_claims` | `sha256(repository_id + NUL + branch)` | Atomic claim that makes concurrent signals for one new branch create exactly one observed case. |

## Retention

Documents are kept until deleted by an operator. Documents in `device_codes`, `auth_rate_limits`, `assistant_intake_receipts` and the lock collections carry an `expires_at` string that the code honours but nothing deletes. See [Data retention in the deployment guide](./deployment.md#data-retention).
