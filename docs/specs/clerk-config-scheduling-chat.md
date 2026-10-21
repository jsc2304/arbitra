# Clerk: context entries, scheduled task blueprints, Google Chat

Status: Design document; parts may differ from the code. Slices A to D and F are implemented. In slice E, identity mapping is implemented and the interactive decision cards are not.

This specification covers three extensions of the Clerk assistant and the notification pipeline: durable user context (slice A), recurring tasks (slice B), and Google Chat as a notification and request channel (slices C to F). Sequencing: A, B and C are independent; D needs C; E needs C; F needs E.

---

## Slice A: Clerk context entries

**Goal.** A user teaches Clerk durable facts (for example a team roster) on a Context tab at `/clerk`. Entries marked for injection are added to every one of that user's task prompts, visibly and within bounds.

**Storage.** Context entries are knowledge assets of type `clerk_context` in the user's private Clerk project (`scope_type: 'project'`, `scope_ref` = the project id from `clerkCoreIds(userId)`). `KnowledgeAsset` and its create and update inputs gain an optional boolean `always_inject`. A dedicated field is explicit, queryable and visible in every serializer, unlike a tag convention. `KnowledgeType` is an open union, so no schema change is needed for the new type.

**Write path.** The generic knowledge routes require the `tech_lead` or `admin` role, so a regular user could create but never edit an asset in their own private project. Dedicated routes `GET`/`POST /api/assistant/context` and `PATCH`/`DELETE /api/assistant/context/{knowledgeId}` authenticate the caller, resolve the caller's own Clerk project, and operate only on assets whose `scope_ref` equals it. Ownership of the private project is the authorization; there is no global role check.

**Prompt injection.** `buildAssistantSystemPrompt` adds an optional section for injected context. Explanatory text sits outside the fence and the payload is wrapped with `fenceUntrusted('untrusted_injected_context', body)`. The untrusted-content instruction names the new tag: data the requester stored about themselves or their team, not instructions. The executor fetches the entries once before the prompt is built and narrows them to `{knowledge_id, title, body}`; the same list feeds the trace.

**Bounds.** `AssistantBounds` has `maxInjectedContextEntries` (default 5) and `maxInjectedContextChars` (default 8000), overridable with `ARBITRA_ASSISTANT_MAX_INJECTED_CONTEXT_ENTRIES` and `ARBITRA_ASSISTANT_MAX_INJECTED_CONTEXT_CHARS`. Entries beyond the cap stay search-only, most recently updated first. Injected entries remain findable through `arbitra_search_knowledge`; the double exposure is accepted because the caps keep it cheap.

**Trace.** The result document gains `injected_context: {knowledge_id, title}[]`, a sibling of `tool_calls`. It is rendered as its own block in the method details, with names and ids only, no bodies.

**UI.** `/clerk` has a tab bar with Ask, Context and Scheduled. The Context panel is a list plus an editor with title, markdown body and an always-inject toggle. There are no type or scope selectors; scope is implicit.

**Done when.** A context entry created on the tab appears verbatim in the next task's prompt fence, is listed in that run's method details, respects both caps, and can be edited and deleted by its owner without a privileged role.

---

## Slice B: Task blueprints

**Goal.** A versioned, user-owned definition for recurring Clerk work. Every occurrence is one ordinary `assistant_task` case with a run, under the same governance as a manual request. Triggers are a cron schedule and a manual Run now button. Webhook triggers, typed parameters and outward actions are out of scope.

**Domain object.** `packages/shared/src/types/task-blueprint.ts`:

```
TaskBlueprint {
  blueprint_id, owner_user_id, project_id      // project_id is the owner's private Clerk project
  name, description?
  prompt_text                                   // passed verbatim to intake
  cron_schedule, timezone                       // IANA timezone, evaluated in process
  enabled: boolean, archived_at?: string|null
  version: number                               // bumped on every edit
  overlap_policy: 'skip'                        // one active occurrence per blueprint
  missed_run_policy: 'skip'                     // no catch-up
  created_at, updated_at
}
```

The collection is `task_blueprints`. The blueprint row is edited in place and never keeps history. An occurrence therefore stamps `blueprint_context: {blueprint_id, blueprint_version, prompt_text}` onto the case's `assistant_context` at creation, so earlier cases keep the content that actually ran.

**Scheduling.** A scheduler calls `POST /api/blueprints/tick` every five minutes (see [Scheduled jobs](../deployment.md#scheduled-jobs)). The route authenticates the scheduler and calls `BlueprintTickService`, which loads enabled, non-archived blueprints and computes fire times with `croner` (IANA time zones, correct across daylight saving changes). The service keeps no "last tick" state. Each call computes a window of one tick interval plus a ten-minute safety margin ending now. An occurrence is keyed by the computed fire time, not by the time the tick arrived, so two overlapping ticks produce the same key for the same fire time. Fire times older than the window are skipped.

**Occurrence creation.** The tick service calls `AssistantIntakeService.intake(request, actorId)` directly with `actorId = blueprint.owner_user_id`, never through `authenticate()` (a scheduler request carries no user token) and never with a service identity. That one boundary provides provisioning, project membership checks, per-user quotas, transactional creation of case, event and run, receipt-based deduplication, and the requester-only access rule for assistant cases. The idempotency key is `blueprint:{blueprint_id}:{version}:{occurrence_iso}` with `channel: 'blueprint'`. Overlap `skip`: before intake, one query looks for a non-terminal case carrying the same `blueprint_id`; if one exists, a skipped occurrence is recorded. After intake the run is dispatched like a manual request, and the assistant sweep recovers dropped runs.

**Run now.** `POST /api/assistant/blueprints/{id}/run` is authenticated as the owner (403 otherwise) and uses the same occurrence path with `occurrence_iso = now` and the same overlap check.

**CRUD and UI.** Owner-scoped routes under `/api/assistant/blueprints`. The Scheduled tab lists name, schedule in words, enabled toggle, last and next occurrence and a Run now button, and has an editor for name, prompt, cron, timezone and enabled. Editing bumps `version`. Occurrence rows link to their cases.

**Failure surfacing.** A run that completes with a documented gap (reads withheld) is shown by an outcome badge on the Scheduled tab (done, reads withheld, failed).

**Done when.** A blueprint with a `*/10`-style schedule produces exactly one case per computed fire time, survives a duplicate tick without a second case, skips while a prior occurrence is non-terminal, runs now for the owner and returns 403 to anyone else, bumps the version on edit while prior cases keep the old prompt, and fires nothing while disabled.

---

## Google Chat notifications: starting point

Before slice C, the Integrations tab advertised event types for which no dispatch existed, Clerk outcomes and run failures notified nowhere, and the send path was a single unretried request whose failures were only logged. Google's incoming webhooks post only to spaces; direct messages, buttons and inbound messages need a registered Google Chat app.

## Slice C: Notification pipeline

**Goal.** The event catalog matches what is dispatched, delivery is observable and retried once, configuration is validated, and events can be toggled per project.

1. **Event reconciliation.** Every catalog event has a dispatch site: `case_approved`, `case_done`, `critical_finding`, `rule_violation`, `evidence_missing`, `run_failed`, `run_retries_exhausted`, and the Clerk outcomes `assistant_task_completed` and `assistant_task_failed`. Events emitted inside a transaction go through the same post-commit notifier hook.
2. **Per-event toggles.** `Project.notification_events` is a partial map of event to boolean. Catalog defaults (`NOTIFICATION_EVENT_DEFAULTS`): events that need a human to act are on, findings, violations and run failures are on, informational events (approved, done) are off. The Integrations tab renders its toggle list from the catalog so the UI cannot drift from the code.
3. **Validated writes.** The project update route validates the webhook URL as `https://chat.googleapis.com/…` at write time.
4. **Delivery state and retry.** `GoogleChatNotifier.send` retries once with a short backoff on 429, 5xx and network errors. Each outcome is stored on `Project.notification_delivery` (`last_success_at`, `last_error`) and shown next to the Test button. There is no queue.

**Done when.** Every toggle-listed event fires (one test per mapping), a dead webhook shows its error on the Integrations tab after one send, and the tab's event list comes from the catalog the dispatcher uses.

## Slice D: Clerk answers into Chat

**Goal.** A finished Clerk task reaches the requester in Chat. Each user stores an incoming webhook for a private space they own (`User.notification_chat_webhook`, settings page). On `assistant_task_completed` or `assistant_task_failed`, and on a blueprint occurrence that ends with reads withheld, the dispatcher resolves the case's requester and posts to that user's webhook: title, one-line outcome and a deep link. Project webhooks keep serving engineering cases only. Clerk cases notify the requester's space only, because a private Clerk case posted to a shared space would leak requester-only content.

**Done when.** A completed Clerk task reaches the requester's space within seconds, a failed occurrence reports the failure class, and a user without a webhook gets no Chat message.

## Slice E: Chat app and identity mapping

**Operational prerequisite.** Register a Google Chat app in the Google Cloud project with an HTTP endpoint URL (`<instance>/api/chat/events`) and a service account.

**Goal.** Replace pasted webhooks with a first-class app. `POST /api/chat/events` verifies Google-signed ID tokens: a standard Google OIDC ID token (issuer `https://accounts.google.com`, audience the endpoint URL) whose `email` claim is the add-on service agent `service-<project number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`. `CHAT_PROJECT_NUMBER` derives that identity, `CHAT_EVENTS_SERVICE_ACCOUNT_EMAIL` overrides it, and `CHAT_EVENTS_AUDIENCE` overrides the audience. With neither identity variable set the endpoint rejects every request. See `packages/frontend/src/lib/chat-auth.ts`.

**Identity mapping (implemented).** On `ADDED_TO_SPACE` or the first `MESSAGE`, the verified email of the Chat user is matched to an Arbitra user and stored as `users/{id}.chat_identity = {space_name, chat_user_id, mapped_at}`.

**Interactive decision cards (not implemented).** The design calls for `case_needs_decision` notifications as Card v2 with Approve and Request changes buttons carrying `{case_id, action, nonce}`; the callback would verify the token, resolve the mapped user, re-check decision authorization with the same guards as the courtroom, run the decision service and update the card. The code does not build cards or handle card clicks.

## Slice F: Clerk in Chat

**Goal.** Ask Clerk from Google Chat. A direct message or mention of the app becomes a Clerk task. The `MESSAGE` handler resolves the mapped Arbitra user (an unmapped sender gets a short decline message and no task), calls `AssistantIntakeService.intake(text, actorId = mapped user)` with `channel: 'google_chat'` and an idempotency key taken from the Chat message name (Chat retries deliveries, and the receipt makes them one case), and replies with an acknowledgement and a case link. When the task finishes, the answer is posted into the same conversation, truncated to Chat limits with a link for the rest. Follow-ups route through the follow-up service, so a Chat conversation and the web thread are one conversation. Bounds, tool policy and trace are the same as for any other channel.

**Implementation notes.** Replies use the Chat REST API (`spaces.messages.create`) with Application Default Credentials and the `chat.bot` scope; an incoming webhook cannot target the originating thread. On a `MESSAGE` event the space is under `chat.messagePayload.space`. `chat_thread_links` maps a thread (or a direct conversation) to its latest case. For direct messages a per-user setting (`continuous`, `daily`, `idle_gap`, `per_message`) decides when a new message starts a new root case instead of a follow-up. `ARBITRA_CHAT_REPLIES_ENABLED=false` stops Clerk from posting replies.

**Done when.** A direct-message question yields an in-thread answer with a case behind it, a follow-up lands as a follow-up turn, redelivered messages do not duplicate cases, and an unmapped sender cannot create work.

---

## Out of scope

Org-shared context entries, blueprint parameters and webhook triggers, catch-up policies, outward actions from Chat or blueprints beyond decisions, an email channel, and delivery guarantees beyond retry-once.
