# Architecture

Arbitra is a TypeScript monorepo. One Next.js application serves the web UI and every REST API route, imports the domain services as a library, and talks to Firestore through the Firebase Admin SDK. IDE agents reach the same API through an MCP server that runs on the developer's machine. There is no separate backend service.

For the data model see [`database-schema.md`](./database-schema.md); for running an instance see [`deployment.md`](./deployment.md).

## Components

| Component | Package | Responsibility |
|-----------|---------|----------------|
| Shared | `packages/shared` (`@arbitra/shared`) | Domain types, status and transition constants, Zod validators, utilities. No side effects. Used by every other package. |
| Backend | `packages/backend` (`@arbitra/backend`) | Domain services (cases, orchestration, review, decisions, rules, evidence, knowledge, notifications, Clerk assistant, intelligence, webhooks), Firestore repositories, LLM provider adapter, auth middleware. Compiled with `tsc` and imported by the frontend. It starts no HTTP server. |
| Frontend | `packages/frontend` (`@arbitra/frontend`) | Next.js 14 App Router: browser UI plus all HTTP API routes under `src/app/api/`. Built as a standalone Node server. Background work runs inside this process. |
| MCP server | `packages/mcp` (`arbitra-mcp`) | stdio MCP server and CLI for IDE agents (Claude Code, Cursor, Codex). A thin client of the REST API with a device-flow login and OS keychain storage. Published to npm. Also contains the Claude Code plugin (`plugin/`). |
| Firestore | Firebase project | All persistent state. Accessed only from the server. `firestore.rules` denies every client access. |
| Firebase Auth | Firebase project | Sign-in for the web UI (Google provider). |
| Artifact storage | Local disk or a GCS bucket | File bytes for artifacts. Firestore holds the metadata. |
| Emulators | `docker-compose.yml`, `docker/` | Firebase Auth, Firestore and Storage emulators for local development. |
| IDE templates | `templates/` | Files served by `/api/init/*` for setting up a repository (agent instructions, PR template, Cursor commands and hooks). |

The monorepo is built with Turborepo in the order `shared`, `backend`, `frontend`.

## Request flow

1. The browser (SWR hooks in `packages/frontend/src/lib/api-client.ts`) or an IDE agent calls a route under `/api/...` with an `Authorization: Bearer` header.
2. The route handler authenticates the caller (see below), validates the body with a Zod schema from `@arbitra/shared`, and checks access to the case or project (`requireCaseAccess`, project membership, role checks).
3. The handler calls a service from `@arbitra/backend`. Services contain the domain logic and use repositories that wrap Firestore collections (`packages/backend/src/lib/firestore.ts`).
4. State changes append events to `case_events`. An event notifier reacts after the write: in-app notifications, Google Chat messages, and the GitHub commit status.
5. Errors are mapped to JSON error bodies by `handleError`.

## Authentication

| Caller | Mechanism |
|--------|-----------|
| Web UI | Firebase Auth with Google sign-in. The Firebase JS SDK produces an ID token; the server verifies it with the Admin SDK. A user document is created or updated on first request. `AUTH_HOSTED_DOMAIN` restricts sign-in to one Google Workspace domain. `ARBITRA_ADMIN_EMAILS` grants the admin role to listed, verified accounts. |
| IDE agents, CI | Arbitra access tokens (`arb_` prefix). Only the SHA-256 hash is stored in the `tokens` collection. Tokens are issued per tool and device through an OAuth device flow (`/api/auth/connect/*`, confirmed on the `/connect` page) or created as CI service tokens in Settings. See [`specs/device-flow-and-per-tool-tokens.md`](./specs/device-flow-and-per-tool-tokens.md). |
| Scheduler jobs | A shared bearer secret (`ARBITRA_CRON_SECRET`) or a Google OIDC token from Cloud Scheduler. |
| Webhooks | HMAC signature (`X-Hub-Signature-256`) with `GITHUB_WEBHOOK_SECRET` or `CI_WEBHOOK_SECRET`. |
| Google Chat | Google-signed ID token, verified against the configured audience and project number. |

Roles are `developer`, `reviewer`, `tech_lead` and `admin`. Project membership scopes what a user can see.

## Case lifecycle and orchestration

A case is the unit of governed work. Its status moves through a state machine defined in `packages/shared/src/constants/status-transitions.ts` (`open`, `exploration`, `ready_for_build`, `in_build`, `in_validation`, `in_review`, `needs_human_decision`, `verification_pending`, `approved`, `pending_merge`, `done`, `rejected`).

- Each transition lists preconditions (evidence satisfied, rule runs completed, review completed, human approval documented, four-eyes, PR merged). Preconditions are evaluated in `services/orchestration/preconditions.ts`.
- `OrchestrationService` applies human-triggered transitions transactionally (`transition-core.ts`). `Pipeline` (`RunCompletionHandler`) re-evaluates the case when a run completes, starts the runs a new status needs, and performs automatic transitions. A per-case lock (`case_pipeline_locks`) prevents concurrent evaluations.
- Lifecycle profiles (`autonomous`, `standard`, `strict`, with per-gate overrides) decide per project which automatic transitions pause for human confirmation. See [`specs/lifecycle-profiles-spec.md`](./specs/lifecycle-profiles-spec.md).
- Two case types run shortened lifecycles outside the governed matrix: `observed` cases (created from session signals and PR activity, see [ADR 0001](./adr/0001-observe-by-default-enforce-by-policy.md)) and `assistant_task` cases (Clerk tasks). A case can be escalated from `observed` into the full lifecycle when its risk reaches the project's threshold.
- Evidence requirements come from per-project evidence policies, one cell per risk level and validation track. `CompletenessEvaluator` decides whether the required evidence is present.
- Decisions (approve, waive, request changes, reject, and others) are written by `DecisionService`, which enforces four-eyes and self-approval rules.

## Review engine

`ReviewService` runs the AI review for a case in `in_review`:

1. `DiffResolver` fetches the diff of the case's pull request or branch from GitHub (never from the request body) and records the reviewed commit SHA.
2. The LLM adapter calls the configured model through the Vercel AI SDK. The model depends on the case risk level; optional consensus models can be configured. Anthropic is the enabled provider.
3. Observations are consolidated into findings with a stable signature, so repeated reviews do not duplicate findings.
4. A verification pass re-checks each finding against the repository contents and registered evidence and lowers the confidence of refuted findings (`ARBITRA_REVIEW_VERIFICATION=false` disables it).
5. Findings gate the lifecycle: unrefuted high and critical findings route the case to a human decision. Findings in newly added submodule or vendored code are tagged with their origin and do not block.

Rule sets (global or per project) add checks of five kinds: metadata, diff pattern, evidence, LLM evaluation, and human confirmation. Knowledge assets are injected into review prompts.

## Clerk, Helper bot and Intelligence

- **Clerk** (`services/assistant`) answers questions and runs scheduled tasks. It is the one place where a model runs a tool loop. All tools are read-only and resolve what the requesting user may see. Each task is an `assistant_task` case with a run. Task blueprints (cron schedules) create tasks through the tick endpoint.
- **Helper bot** answers questions about Arbitra itself from an allowlist of Markdown files in `docs/` and the knowledge assets. See [`helper-bot.md`](./helper-bot.md).
- **Intelligence** runs deterministic detectors daily and records flags and nudges. See [`intelligence.md`](./intelligence.md).

## Background work

Arbitra has no worker process. Background work runs in the Node process that handles HTTP requests, so the host must keep the process alive and CPU available after a response is sent.

| Work | How it runs |
|------|-------------|
| Rule and assistant runs | `RunExecutor` starts them detached from the request. Each run holds a lease in Firestore that a heartbeat refreshes. |
| Review runs | Started by the pipeline when a case enters `in_review`, or by `POST /api/runs`. The pipeline retries diff resolution a few times and arms a timeout notification. A review run has no lease; the sweeper treats it as stale after a maximum age (30 minutes by default). |
| Failed runs | A retry policy classifies failures. Retries use an in-process timer plus a persisted `retry_at`, so a retry survives a restarted instance. |
| Stale runs | `POST /api/runs/sweep` (every few minutes) fails runs whose lease or age has expired, dispatches overdue retries, and claims unclaimed assistant runs. A Firestore lock makes it single-flight. |
| Scheduled Clerk tasks | `POST /api/blueprints/tick` (every 5 minutes) creates a task case for every blueprint whose cron time falls in the window. Idempotency keys make overlapping ticks safe. |
| Intelligence | `POST /api/intelligence/run` (daily) runs the detectors under a Firestore lock. Admins can also run it from the Observatory. |
| Activity stream | `GET /api/activity/stream` is a server-sent-events endpoint that polls Firestore every two seconds per open connection. |

## Integrations

- **GitHub webhooks.** `POST /api/webhooks/git` handles `pull_request`, `push` and `repository` events. It links pull requests to cases (by branch name, case id in the title or body, or PR reference), creates observed cases, detects merges, and closes cases.
- **GitHub commit status.** Arbitra publishes the `arbitra/case` status on the pull request head commit. Marking it as a required check in branch protection makes the lifecycle block the merge.
- **CI webhook.** `POST /api/webhooks/ci` accepts CI build results and registers them as evidence for a case.
- **Session signals.** The Claude Code plugin posts session start, heartbeat and end events to `POST /api/signals`. They feed Mission Control and observed cases.
- **Google Chat.** Project and per-user incoming webhooks deliver notifications. An optional Chat app posts to `POST /api/chat/events`, maps the sender to a user, and lets users ask Clerk from a Chat conversation.
- **GitHub API.** Diff fetching and commit statuses use a per-repository token (stored encrypted with `ARBITRA_ENCRYPTION_KEY`) or the `GITHUB_TOKEN` fallback.

## Storage

- **Firestore** holds every collection. There are no subcollections; relations use id fields. A named database can be selected with `FIRESTORE_DATABASE_ID`. Indexes are in `firestore.indexes.json`.
- **Artifacts** are written by `getArtifactStorage()` to a GCS bucket when `GCS_BUCKET` is set, otherwise to `.arbitra-storage/` (or `ARBITRA_STORAGE_PATH`) on local disk. Local disk is not suitable for a host without persistent storage.
- **Secrets at rest.** Per-repository GitHub tokens are encrypted with AES-256-GCM. Access tokens and device codes are stored as hashes.

## Tests

Vitest runs in every workspace (`npm test`). `npm run typecheck` checks all packages.
