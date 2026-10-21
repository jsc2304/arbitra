# Arbitra

**See what your AI coding agents are doing, and let evidence and risk decide what gets merged.**

[![Release](https://img.shields.io/github/v/release/jsc2304/arbitra)](https://github.com/jsc2304/arbitra/releases)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![MCP: Claude Code, Cursor, Codex](https://img.shields.io/badge/MCP-Claude%20Code%20%7C%20Cursor%20%7C%20Codex-8A2BE2)](docs/mcp.md)
[![Node ≥ 20.19](https://img.shields.io/badge/node-%E2%89%A520.19-339933)](#requirements)

![A recorded run: a coding agent's session appears in Mission Control, its case moves from Open through Building to AI Review, the review raises two high-severity findings (idempotency keys shared across merchants, concurrent retries refunding twice), and the reviewer requests changes in the Courtroom, which sends the case back to Building](docs/images/tour.gif)

<sub>A real run against a local instance: a script plays the coding agent through the `arbitra-mcp` server on a demo repository, the AI review ran on OpenAI `gpt-6.1-sol`, the decision was made in the browser. Sped up 1.25×, waiting time cut.</sub>

Arbitra records the work that AI coding agents (Claude Code, Cursor, Codex) do in your repositories as **cases**. It collects evidence such as CI results, tests and review verdicts, runs an AI review that produces findings, and gives people a **Courtroom** view to decide on risky changes. By default it only observes. Project policy and risk escalate single cases into an enforced lifecycle, which blocks the merge through a GitHub commit status (`arbitra/case`). It is meant for teams that let agents write code and want an audit trail and a four-eyes gate without slowing down every change.

- **Cases, evidence and decisions**: a lifecycle with server-side gates, evidence policies per risk level, a Courtroom for human decisions, four-eyes approval and an append-only audit trail.
- **Mission Control and Activity**: which agent works on which branch and case right now. Needs the Claude Code plugin or the `arbitra-mcp` server on the developer's machine.
- **AI review, Clerk and Helper**: findings from an LLM review of each change, verified against the source, an assistant that answers questions about your cases and runs scheduled tasks, and a bot that answers from the docs. Needs an Anthropic or OpenAI API key.

## Quick start

Requires Node.js 20.19 or newer (24 recommended) and Docker. No Google account or cloud project is needed.

```bash
git clone https://github.com/jsc2304/arbitra && cd arbitra
npm install
cp .env.example packages/frontend/.env.local
npm run emulators   # Firebase Auth, Firestore and Storage emulators in Docker
npm run seed        # demo projects, cases, agents and three sign-in accounts
npm run dev         # http://localhost:3000
```

Open http://localhost:3000, click **Sign in with Google** and pick **Alex Example** in the emulator's account list. Alex is an admin of the demo data. To enable AI review, Clerk and the Helper, put an `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` plus `ARBITRA_LLM_PROVIDER=openai`) into `packages/frontend/.env.local` and restart `npm run dev`.

## Features

| Area | What you get |
|---|---|
| **Mission Control** | Live agent sessions grouped by project: agent, repository and branch, linked case and status, session counts for 24 h, 7 days and 30 days. |
| **Activity** | A live feed of case events, evidence, findings and decisions with filters by type, actor, project and time, a "what needs me" bar and a per-project activity overview. |
| **Cases** | List, board and lifecycle views with tabs for Needs me, Ready to approve, Blocked, Waiting on others, My active. Observed cases are opened automatically from agent sessions and pull requests. |
| **Case page** | Lifecycle progress, blockers, owner and reviewer, evidence, AI review findings, runs, comments, timeline and related cases. |
| **Courtroom** | The decision view for a case awaiting judgment: findings with confidence and verification, evidence, and the steps to approval (resolve or waive blockers, record the decision). |
| **Dossier** | A printable audit trail of one case: exploration and build summaries, evidence, decisions with rationale, knowledge used. |
| **Review session** | Work through actionable cases one at a time, with what Arbitra needs next and what your local agent can do. |
| **Projects** | Repositories, members and roles (reviewers, tech leads), rule sets, evidence policies per risk level and track, webhook and integration setup, and a five-step setup wizard. |
| **Rules and AI review** | Rules as metadata checks, diff patterns, evidence checks, LLM evaluation or human confirmation; an AI review that produces findings, verifies them against the diff and deduplicates them. |
| **Knowledge** | Patterns, precedents, anti-patterns and exception policies with a suggested → verified → canonical lifecycle; canonical assets are fed into reviews. |
| **Clerk** | An assistant that answers questions about your cases (Ask), reads context entries you mark (Context), and runs questions on a cron schedule (Scheduled). Every request becomes a case with a traceable answer. Optional: Clerk in Google Chat. |
| **Helper** | A chat bot for "how do I …" questions, answered from the docs shipped with the instance. |
| **Observatory and Intelligence** | Approval rates, cases by status, risk and findings, top contributors, reviewers and repositories; daily detectors that flag stale or orphaned work and incomplete repository setup. |
| **Dashboard and notifications** | A personal start page with onboarding checklist and counters, in-app notifications, and optional Google Chat notifications per project or user. |
| **Settings** | Users and roles, AI models per risk level, prompt templates, access tokens for IDE agents and CI, and the IDE agent setup. |
| **IDE integration** | The `arbitra-mcp` MCP server (29 tools), a Claude Code plugin with a session hook, and a setup script that adds the agent contract, commands and hooks to a repository. |
| **Merge gate** | GitHub webhook for pull requests and pushes, CI webhook for test and build evidence, and the `arbitra/case` commit status for branch protection. |

## What it looks like

All screenshots show the demo data from `npm run seed`; every person, project and repository in it is fictional.

<table>
<tr>
<td width="50%"><img src="docs/images/mission-control.png" alt="Mission Control: three live agent sessions (codex, claude-code, cursor) grouped by project, with session counts for 24 hours, 7 days and 30 days"><br><b>Mission Control</b></td>
<td width="50%"><img src="docs/images/activity.png" alt="Activity: live feed of case events with filters, a needs-me bar with three cases awaiting a decision, and hot projects on the right"><br><b>Activity</b></td>
</tr>
<tr>
<td><img src="docs/images/cases-list.png" alt="Cases list with status, risk, priority, project and owner for 16 cases"><br><b>Cases: list</b></td>
<td><img src="docs/images/cases-board.png" alt="Cases board with columns per lifecycle status"><br><b>Cases: board</b></td>
</tr>
<tr>
<td><img src="docs/images/cases-lifecycle.png" alt="Cases lifecycle view: cases spread over the stages from Open to Done, two needing a decision and one waiting for manual verification"><br><b>Cases: lifecycle</b></td>
<td><img src="docs/images/case.png" alt="Case page of a high-risk case with lifecycle progress, one high-severity blocker, owner, reviewer and branch"><br><b>Case</b></td>
</tr>
<tr>
<td><img src="docs/images/courtroom.png" alt="Courtroom: findings on the left, the selected high-severity finding in the middle, evidence and approval steps on the right"><br><b>Courtroom</b></td>
<td><img src="docs/images/dossier.png" alt="Dossier: printable audit trail with project, branch, PR, exploration and build summaries and audit metrics"><br><b>Dossier</b></td>
</tr>
<tr>
<td><img src="docs/images/review-session.png" alt="Review session: one case at a time with why it is here, what Arbitra needs next and session actions"><br><b>Review session</b></td>
<td><img src="docs/images/projects.png" alt="Projects list with Payments API, Web Storefront and Mobile App"><br><b>Projects</b></td>
</tr>
<tr>
<td><img src="docs/images/project.png" alt="Project page with settings, rule sets, evidence policy and team members with reviewer and tech lead roles"><br><b>Project</b></td>
<td><img src="docs/images/new-project.png" alt="Project setup wizard, step 1 of 5: create project, connect repository, configure webhook, invite team, install in IDE"><br><b>Project setup wizard</b></td>
</tr>
<tr>
<td><img src="docs/images/knowledge.png" alt="Knowledge: list of assets and the detail of a canonical anti-pattern with lifecycle, scope, trust level and source case"><br><b>Knowledge</b></td>
<td><img src="docs/images/clerk-ask.png" alt="Clerk Ask tab with the request form and recent tasks"><br><b>Clerk: Ask</b></td>
</tr>
<tr>
<td><img src="docs/images/clerk-answer.png" alt="A Clerk answer listing the cases waiting for a human decision and what blocks each one"><br><b>Clerk: answer</b></td>
<td><img src="docs/images/clerk-context.png" alt="Clerk Context tab with a team roster entry that Clerk reads with every task"><br><b>Clerk: Context</b></td>
</tr>
<tr>
<td><img src="docs/images/clerk-scheduled.png" alt="Clerk Scheduled tab with a daily review-queue digest blueprint and its last run"><br><b>Clerk: Scheduled</b></td>
<td><img src="docs/images/helper.png" alt="Assistant launcher: start a task with Clerk or ask the Helper about Arbitra"><br><b>Clerk and Helper launcher</b></td>
</tr>
<tr>
<td><img src="docs/images/observatory.png" alt="Observatory: 18 cases, 86% approval rate, 19 findings, cases by status and risk distribution"><br><b>Observatory</b></td>
<td><img src="docs/images/intelligence.png" alt="Intelligence: run history of the daily detectors and per-detector status"><br><b>Intelligence</b></td>
</tr>
<tr>
<td><img src="docs/images/dashboard.png" alt="Dashboard with greeting, onboarding checklist and counters"><br><b>Dashboard</b></td>
<td><img src="docs/images/settings-ai-models.png" alt="Settings, AI models: provider OpenAI with a model per risk level"><br><b>Settings: AI models</b></td>
</tr>
<tr>
<td><img src="docs/images/settings-users.png" alt="Settings, users: three users with their roles"><br><b>Settings: users</b></td>
<td></td>
</tr>
</table>

## How it works

1. An agent session starts in a repository connected to Arbitra. The session hook reports agent, repository and branch; Arbitra shows it in Mission Control and opens an **observed case** for the branch.
2. Pushes and pull requests arrive through the GitHub webhook. Rules and the AI review evaluate the change; evidence is attached from CI, tests and agents.
3. Project policy and the risk level decide whether a case stays observed or is **escalated** to the enforced lifecycle. Enforced cases need their required evidence and a human decision; high and critical risk need two approvers.
4. Arbitra publishes the `arbitra/case` commit status. Make it a required check in branch protection to block merges until the case is approved.

Agents can also drive cases explicitly through the MCP tools (`create_case`, `get_case_context`, `progress_case`, …). The domain language is defined in [CONTEXT.md](CONTEXT.md), the design decision in [ADR 0001](docs/adr/0001-observe-by-default-enforce-by-policy.md).

| Package | Responsibility |
|---|---|
| `packages/frontend` | Next.js app: UI, REST API, background work |
| `packages/backend` | Domain services: cases, review engine, rules, evidence, decisions, knowledge, Clerk |
| `packages/shared` | Types, validators, the case state machine |
| `packages/mcp` | MCP server and Claude Code plugin for IDE agents ([README](packages/mcp/README.md)) |

## Connect an IDE agent

For Claude Code, install the plugin. It adds the MCP server and the session hook that feeds Mission Control, and uses `ARBITRA_URL` from your environment (default `http://localhost:3000`):

```text
/plugin marketplace add jsc2304/arbitra
/plugin install arbitra@arbitra
```

Or add only the MCP server:

```bash
claude mcp add arbitra -e ARBITRA_URL=http://localhost:3000 -- npx -y arbitra-mcp
```

The first tool call prints a Connect link; open it, confirm, and the token is stored in your OS keychain. Cursor, Codex and the per-repository setup script are covered in [docs/mcp.md](docs/mcp.md), [docs/setup-claude-code.md](docs/setup-claude-code.md) and [docs/setup-codex.md](docs/setup-codex.md).

## Running your own instance

The local setup above needs none of the following. For an instance that a team uses, this is what you set up yourself; [docs/deployment.md](docs/deployment.md) has the commands and every environment variable.

| Step | Needed for | What to do |
|---|---|---|
| **Database and sign-in** | everything | Create a Firebase project with Firestore (native mode) and Firebase Authentication with the Google provider. Add your domain to the authorized domains. Deploy `firestore.rules` and `firestore.indexes.json` with the Firebase CLI. |
| **Server access to Firestore** | everything | On Google Cloud the runtime service account is used; elsewhere set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key, and `GOOGLE_CLOUD_PROJECT`. |
| **Build the image** | everything | `docker build` with the Firebase web config as build args (`NEXT_PUBLIC_FIREBASE_*`); these are baked into the browser bundle. |
| **Host the container** | everything | Any host that keeps a Node process running (Cloud Run with CPU always allocated, a VM, Kubernetes). Background work continues after HTTP responses. Put it behind HTTPS. |
| **Public URL** | links, device login | Set `ARBITRA_PUBLIC_BASE_URL` and `ARBITRA_URL` to the instance URL. |
| **Access control** | security | Set `AUTH_HOSTED_DOMAIN` to your Google Workspace domain (otherwise any Google account can sign in) and `ARBITRA_ADMIN_EMAILS` for the first admins. |
| **LLM key** | AI review, Clerk, Helper | `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` with `ARBITRA_LLM_PROVIDER=openai`; choose models per risk level in Settings. |
| **Scheduled jobs** | run recovery, Clerk schedules, Intelligence | Set `ARBITRA_CRON_SECRET` and call `POST /api/runs/sweep` (every few minutes), `/api/blueprints/tick` (every 5 minutes) and `/api/intelligence/run` (daily) from any scheduler. |
| **GitHub** | observed cases from PRs, diffs, merge gate | Per repository: a webhook to `/api/webhooks/git` with `GITHUB_WEBHOOK_SECRET`; a token (`GITHUB_TOKEN`, or per repository, which needs `ARBITRA_ENCRYPTION_KEY`); `arbitra/case` as a required status check. |
| **CI** | test and build evidence | A CI step that posts results to `/api/webhooks/ci`, signed with `CI_WEBHOOK_SECRET`. |
| **File storage** | screenshots, reports, Clerk answers | Set `GCS_BUCKET` on hosts without a persistent disk; otherwise files go to `.arbitra-storage/`. |
| **Google Chat** (optional) | notifications, Clerk in Chat | Webhook URLs per project or user for notifications; a Chat app with `CHAT_PROJECT_NUMBER` and `CHAT_EVENTS_AUDIENCE` for Clerk. |
| **Developers** | Mission Control, agent-driven cases | Each developer installs the plugin or MCP server and signs in once through the Connect link; each repository gets the setup script from the project setup wizard or Settings → IDE Agent. |

## Requirements

| What | Version / note |
|---|---|
| OS | Tested on macOS 26 (Apple silicon). Linux should work; Windows is untested |
| Node.js | 20.19 or newer; tested with 24.4 |
| Docker | Tested with Docker 29; runs the local Firebase emulators and builds the production image |
| Anthropic or OpenAI API key | Optional locally. Adds AI review, Clerk and the Helper. Anthropic is the default provider; OpenAI was tested with `gpt-6.1-sol` and `gpt-5-mini` |
| GitHub webhook and token | Optional. Adds observed cases from pull requests, diff-based review and the `arbitra/case` merge gate |
| Claude Code plugin or `arbitra-mcp` | Optional. Adds live sessions in Mission Control and lets agents drive cases |
| Google Chat app | Optional. Adds Chat notifications and Clerk in Chat |
| Firebase project | Only for a deployed instance: Firestore and Firebase Auth with the Google provider |

## Updating

```bash
git pull
npm install
npm run emulators   # rebuilds the emulator container if its definition changed
npm run dev
```

Demo data in the emulators survives restarts. `npm run seed -- --reset` replaces it with a fresh demo data set. For a deployed instance, rebuild and redeploy the image and deploy `firestore.indexes.json` again when it changed.

## Usage

| Command | What it does |
|---|---|
| `npm run emulators` | Starts the Firebase Auth, Firestore and Storage emulators in Docker and waits until they are ready (UI on http://localhost:4000) |
| `npm run seed` | Writes the demo data set and the three sign-in accounts; refuses to run against anything but the emulators |
| `npm run seed -- --reset` | Deletes the demo collections first, then seeds |
| `npm run dev` | Runs the app with hot reload on http://localhost:3000 |
| `docker compose down` | Stops the emulators (data is kept in a Docker volume; add `-v` to drop it) |
| `npm run build` | Builds all packages, the Next.js app in standalone mode |
| `npm run typecheck`, `npm run test`, `npm run lint` | Checks, see [Development](#development) |
| `npx -y arbitra-mcp doctor` | Checks an IDE machine's connection to an instance; more commands in the [MCP README](packages/mcp/README.md) |

In the app, **Enter Courtroom** on a case page opens the decision view, **New Case** creates a case by hand, **Start session** walks through the cases that need you, and the round button at the bottom right opens Clerk and the Helper.

## Data and privacy

- **AI review, Clerk and the Helper** send case content (title, description, diffs, changed file contents, findings, evidence summaries, your question) to the configured provider (Anthropic or OpenAI) using your credentials.
  - Default models: `claude-haiku-4-5-20251001` / `claude-sonnet-5` on Anthropic and `gpt-5-mini` / `gpt-5.5` on OpenAI, the smaller one for low-risk cases; admins change them under Settings → AI Models.
- **GitHub**: with a token configured, Arbitra reads pull request diffs and file lists and writes the `arbitra/case` commit status.
- **Google Chat**: only when configured, notifications and Clerk replies go to your Chat space.
- **Session hook and MCP server** talk only to your Arbitra instance. The hook sends agent name, repository URL (credentials stripped), branch and session id. At login the MCP server sends a device id, a hash of the hostname and a MAC address.
- Everything else stays in your Firestore database and storage.

## Known limitations

- **Google dependency.** Data lives in Firestore and sign-in uses Firebase Auth with Google accounts. Locally the emulators remove the need for a Google account; a deployed instance needs a Firebase project. A port to Postgres with a provider-neutral sign-in would remove this, but has not been started.
- **Two LLM providers.** Anthropic (default) and OpenAI are enabled. For this release the OpenAI path was verified end to end (the recording above); Anthropic, the provider used during development, was not re-run. Adapters for Gemini and OpenRouter exist but are disabled.
- **Expired documents are not purged.** `device_codes`, `auth_rate_limits` and Clerk intake receipts store `expires_at` as a string, so Firestore TTL policies cannot delete them.
- **Open security follow-ups**: the gate confirmation has a check-then-act window, a cross-client conflict response reveals that another client's case exists, `POST /api/cases/detect` answers without authentication, and the Google Chat decision cards (with a single-use nonce) are not implemented. See [SECURITY.md](SECURITY.md).
- **Dependency advisories** remain in the Firebase SDKs (`@grpc/grpc-js` in the client SDK, `node-forge` in `firebase-admin` 12). The fixed `firebase-admin` 14 requires Node 22.
- The escalation threshold for observed cases is fixed at `high` and cannot be changed through the UI or API.
- The new React Compiler lint rules of Next.js 16 are switched off; enabling them reports about 70 findings.

## Project status

Arbitra was built in 2026 and is published as a reference implementation, as is. There is no maintenance commitment and no support.

## Feedback

Questions and ideas go to [Discussions](https://github.com/jsc2304/arbitra/discussions), bugs to [Issues](https://github.com/jsc2304/arbitra/issues); security reports follow [SECURITY.md](SECURITY.md). Answers may take a while or not come at all. If Arbitra is useful to you, a star helps others find it.

## Development

```bash
npm run typecheck
npm run test        # Vitest for shared, backend and frontend; node --test for the MCP server
npm run lint
npm run build
```

Conventions for contributors and coding agents are in [AGENTS.md](AGENTS.md).

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
