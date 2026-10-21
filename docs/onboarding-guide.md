# Arbitra User Guide

Arbitra is a control plane for AI-assisted software work. An IDE agent or a developer changes code on a branch; Arbitra records the work as a **case**, runs rule checks and an AI review, collects evidence, and routes the merge decision to a human where the risk calls for one. This guide covers running Arbitra locally, connecting an IDE agent, the core concepts, and the day-to-day flow for developers and reviewers.

## Contents

- [What Arbitra does](#what-arbitra-does)
- [Quickstart](#quickstart)
- [Connect an IDE agent](#connect-an-ide-agent)
- [Core concepts](#core-concepts)
- [Your first case](#your-first-case)
- [The web app](#the-web-app)
- [Reviewing and deciding](#reviewing-and-deciding)
- [AI review and LLM setup](#ai-review-and-llm-setup)
- [Rules and evidence policies](#rules-and-evidence-policies)
- [Enforcing at merge](#enforcing-at-merge)
- [Roles](#roles)
- [Clerk and the Helper](#clerk-and-the-helper)
- [Troubleshooting](#troubleshooting)
- [Reference](#reference)

---

## What Arbitra does

AI-assisted development happens fast and locally. Code written in an IDE session reaches review through a branch and a pull request, often without a record of what the agent did, what was tested, or who looked at it. Arbitra turns each unit of work into a case with structured findings, evidence requirements and decisions, and keeps an append-only audit trail.

Arbitra observes by default and enforces by policy ([ADR-0001](adr/0001-observe-by-default-enforce-by-policy.md)). It learns about work from IDE session signals and GitHub pull request webhooks and records it as an **observed case**. Cases that are created manually, or that observed cases escalate into because their risk is high, run the full **enforced lifecycle**. The blocking point is the merge (a GitHub status check), never the act of writing code.

Arbitra is not a Jira replacement and not a general code review bot. It combines AI review, configurable rules, evidence management and human decision gates in one system, and keeps the human in charge of the decision.

---

## Quickstart

Requirements: Node.js 20.19 or newer (24 recommended), Docker, git. No Google account and no Java on the host; the Firebase emulators run in a container.

```bash
git clone https://github.com/jsc2304/arbitra && cd arbitra
npm install
cp .env.example packages/frontend/.env.local
npm run emulators   # docker compose up -d firebase: Auth, Firestore and Storage emulators, UI on :4000
npm run seed        # demo data, including the sign-in account alex@example.com
npm run dev         # http://localhost:3000
```

Open http://localhost:3000. The sign-in popup is the Firebase Auth emulator; pick the seeded account "Alex Example". That account is an admin because `ARBITRA_ADMIN_EMAILS=alex@example.com` is set in `.env.example`. You land on Mission Control; **Cases** lists the demo cases.

| URL | Service |
|-----|---------|
| http://localhost:3000 | Arbitra |
| http://localhost:4000 | Firebase Emulator UI (Firestore data, auth users, storage) |
| localhost:8080, 9099, 9199 | Firestore, Auth and Storage emulators |

AI review, Clerk and the Helper call Anthropic. Put `ANTHROPIC_API_KEY=<your key>` into `packages/frontend/.env.local` and restart `npm run dev`. Without a key the app runs, but those features fail with a provider error.

Emulator data is exported to a Docker volume when the container stops and imported on the next start. `docker compose down -v` removes the volume and resets everything.

The repository [README](../README.md) has the full local setup, and [deployment.md](deployment.md) covers running Arbitra for a team. Hands-on exercise: [e2e-test-walkthrough.md](e2e-test-walkthrough.md).

---

## Connect an IDE agent

IDE agents reach Arbitra through `arbitra-mcp`, an MCP server published on npm. It translates tool calls into REST calls against your instance and stores nothing except the credentials it keeps locally. It needs Node.js 20 or newer.

The server finds the instance through `ARBITRA_URL`: the process environment first, then the nearest `.arbitra/.env`, then `http://localhost:3000`. A local instance therefore needs no configuration at all. Replace `<instance url>` below with the URL of a shared instance. [mcp.md](mcp.md) and the [package README](../packages/mcp/README.md) are the reference.

### Claude Code plugin

```text
/plugin marketplace add jsc2304/arbitra
/plugin install arbitra@arbitra
```

The plugin registers the MCP server, the session hooks that report your sessions to Mission Control, and a `/status` command. Set `ARBITRA_URL` in the environment Claude Code starts in if the instance is not at `http://localhost:3000`. Restart Claude Code (or run `/reload-plugins`) after installing. Details: [setup-claude-code.md](setup-claude-code.md).

### Claude Code without the plugin

```bash
claude mcp add arbitra -e ARBITRA_URL=<instance url> -- npx -y arbitra-mcp
```

Leave out `-e ARBITRA_URL=...` for a local instance. The session hooks are only part of the plugin.

### Cursor and Codex

Cursor (`.cursor/mcp.json`, or `.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "arbitra": {
      "command": "npx",
      "args": ["-y", "arbitra-mcp"],
      "env": { "ARBITRA_URL": "<instance url>" }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.arbitra]
command = "npx"
args = ["-y", "arbitra-mcp"]
env = { ARBITRA_URL = "<instance url>" }
```

Restart the client after editing its configuration. An `ARBITRA_URL` in the client configuration applies to every repository and overrides each repository's `.arbitra/.env`. If you work against several instances, leave it out and let `arbitra-mcp login` write `.arbitra/.env` per repository. Details for Codex: [setup-codex.md](setup-codex.md).

### First call and login

No token is configured by hand. The first tool call without a credential returns a **Connect** link (device-code flow). Open it, sign in, confirm the tool, device and project, and the call is retried. The token is stored in the OS keychain. From a terminal:

```bash
npx -y arbitra-mcp login     # also writes .arbitra/.env with ARBITRA_URL and ARBITRA_PROJECT_ID
npx -y arbitra-mcp doctor    # checks credentials, reachability, token and client configuration
```

The Connect page preselects the project whose repository URL matches your `origin` remote, so register the repository first (Projects, Repositories tab). CI jobs use `ARBITRA_TOKEN`, a service token created under Settings, Connections, Advanced, Create CI service token.

### Per-repository files (optional)

The instance serves a setup script that writes agent instructions and a project pin into a repository:

```bash
curl -sL $ARBITRA_URL/api/init/init.sh | bash -s -- --ide claude-code <project_id>
```

`--ide` accepts `cursor` (default), `claude-code`, `codex` or `all`. The script creates `.arbitra/` (`AGENTS.md`, `CREATE-CASE.md`, `case-spec.json`, a `.env` with the instance URL and project id, never a token), a root `AGENTS.md` block, a pull request template, and per-client files: `.cursor/` agents, commands, hooks and a skill for Cursor, `.mcp.json` and `.claude/commands/` for Claude Code, and a TOML block to paste for Codex. Settings, IDE Agent shows the same commands with your URL and project filled in.

The session hook only reports sessions from a workspace that contains an `.arbitra/` directory, which `arbitra-mcp login` and the setup script both create.

### What each client gets

| | Claude Code plugin | Cursor | Codex |
|---|---|---|---|
| MCP tools | yes | yes | yes |
| Slash commands | `/status`; the full set (`/arbitra`, `/create-case`, `/explore`, `/build`, `/review`, `/request-changes`) after running the setup script | via the setup script | none, the agent calls MCP tools |
| Session visible on Mission Control | yes, through the session hooks | pull request webhooks only | pull request webhooks only |

Clients without session hooks still work: once a case has a linked pull request, GitHub webhooks update it (evidence, status, merge detection). What they lose is the live, in-progress view.

Case identity derives from the git branch: one branch, one case. Two sessions on two branches, including two worktrees of one checkout, never collide. The agent resolves its case with `GET $ARBITRA_URL/api/cases/resolve?repository_id=...&branch=...`.

---

## Core concepts

### Cases

A **case** is a unit of work with a title, description, project, repository, branch or pull request, owner, risk level, validation track and priority. It has one of two lifecycles.

- **Observed case.** Created automatically when a session signal or pull request webhook names a repository and branch that have no case yet. The repository must be registered. Sessions on the default branch (`main`, `master`, or the stored default branch), on a detached HEAD or without a branch do not create a case. An observed case runs `open → in_build → done` and closes when its pull request merges. Nothing blocks.
- **Enforced case.** Created manually (web app, `create_case`, a case template) or escalated from an observed case. Escalation happens when the risk, re-assessed from the pull request's changed files, title and description, reaches the escalation threshold (`high` by default, so `high` and `critical` escalate). Enforced cases run the full lifecycle below.

Clerk tasks are a third, separate kind (see [Clerk and the Helper](#clerk-and-the-helper)).

### Lifecycle

| Status | Meaning |
|--------|---------|
| `open` | Created, waiting for triage |
| `exploration` | Scope is being analyzed; an exploration summary completes the step |
| `ready_for_build` | Exploration done |
| `in_build` | Implementation under way |
| `in_validation` | Rule checks run and required evidence is checked |
| `in_review` | AI review runs |
| `needs_human_decision` | High or critical findings, or high or critical risk: a reviewer decides |
| `verification_pending` | Manual track: waiting for manual verification |
| `approved` | Approved, automatically for low and medium risk or by a human decision |
| `pending_merge` | Waiting for the pull request to merge |
| `done` | Finished |
| `rejected` | Terminated |

The main path is `open → exploration → ready_for_build → in_build → in_validation → in_review → approved → pending_merge → done`. Most steps fire automatically once their preconditions hold: an exploration summary moves the case to `ready_for_build`, a completed build signal moves it through validation and review, and a completed review moves it to `approved`, `needs_human_decision` or `verification_pending`.

`request_changes` returns a case to `in_build` from `in_validation`, `in_review`, `needs_human_decision`, `verification_pending` or `pending_merge`. A case can be rejected from `exploration` onward. A merged pull request completes a case in `pending_merge` and closes one in `in_build`, `in_validation`, `in_review` or `approved` (a high or critical risk case needs a documented approval first; `ARBITRA_AUTO_CLOSE_ON_MERGE=false` turns the early close off). On a case that is still `open`, `exploration`, `ready_for_build`, `needs_human_decision` or `verification_pending`, a merge does not close the case; the activity feed shows an anomaly event and a person reconciles it. A case with neither pull request nor branch (work done outside the repository) gets a `merge_not_applicable` decision, attached automatically, and closes without a merge.

### Lifecycle profiles and gates

Each project has a lifecycle preset that decides which transitions wait for a person:

| Preset | Behavior |
|--------|----------|
| `autonomous` | Every transition is automatic |
| `standard` (default) | Starting the build needs a confirmation; everything else is automatic |
| `strict` | A confirmation at each phase boundary |

A **gate** pauses an automatic transition until a confirmer acts. By default confirmers are the project's reviewers and tech leads, and the case owner cannot confirm their own gate unless the evidence policy allows self-approval for that risk and track. Set the preset under Projects, project, Overview, Lifecycle. For a solo local run, switch the project to `autonomous`.

### Findings

A **finding** is a problem identified during review. Sources are AI reviewers, the rule engine and humans. Each has a severity (`info`, `low`, `medium`, `high`, `critical`) and a status (`open`, `accepted`, `fixed`, `waived`, `contested`, `resolved`, `waiver_proposed`, `waived_on_completion`). Open high and critical findings block approval. A finding an agent proposes to waive stays blocking in `waiver_proposed` until a human confirms.

AI findings are verified before they are stored: each is re-checked against the repository content at the pull request head and the registered evidence. A finding the check refutes does not gate the case; it stays visible.

### Evidence

**Evidence** is proof that a change works. Canonical types: `unit_test_result`, `integration_test_result`, `ci_result`, `lint_result`, `runtime_log`, `screenshot`, `diff_snapshot`, `manual_confirmation`, `benchmark_result`, `external_reference`, `pr_merged`, `detection_report`. Each project has an **evidence policy** that lists the required and optional types for every risk level and validation track. A case cannot leave `in_build` while required evidence is missing.

### Decisions

A **decision** is the recorded outcome of a human or system judgment, with a rationale.

| Type | Meaning |
|------|---------|
| `approve` | Approve the case, or mark a finding resolved |
| `request_changes` | Send the case back to `in_build` |
| `waive` | Accept one finding with a written justification |
| `propose_waiver` | An agent proposes a waiver; a human must confirm |
| `reject` | Terminate the case |
| `manual_validation_confirmed` | Manual verification was done |
| `merge_not_applicable` | Close a case that has no pull request |
| `review_not_applicable` | Unblock a case stuck in `in_review` because the AI review cannot run |
| `gate_confirmed`, `gate_rejected` | Resolve a lifecycle gate or a human-confirmation rule |
| `auto_approve` | Written by the system when all criteria are met |

### Validation tracks and risk levels

The **direct track** is for systems whose tests and CI Arbitra can see. The **manual track** is for work that needs manual verification (a system behind a remote desktop, a UI without an API): after review the case waits in `verification_pending` for a person to confirm. A project can set a default track; a new case inherits it.

| Risk | Approval |
|------|----------|
| `low`, `medium` | Auto-approved when review is complete, no high or critical finding is open, rules pass and required evidence is present |
| `high`, `critical` | Never auto-approved. A human decision is required, and the default evidence policy requires four-eyes (two different approvers) |

Risk downgrades are audited.

### Knowledge assets

A **knowledge asset** records something worth remembering: a precedent, pattern, anti-pattern, review guideline, architecture decision, exception policy, implementation note or mock template. Lifecycle: `suggested` (proposed, for example by an agent or from a decision), `verified` and `canonical` (a tech lead or admin promoted it), then `deprecated` or `superseded`. Only `verified` and `canonical` assets of the review-relevant types are injected into AI review prompts.

---

## Your first case

This walks one case through the enforced lifecycle with an IDE agent. [e2e-test-walkthrough.md](e2e-test-walkthrough.md) is the same flow as a step-by-step exercise.

1. **Register the repository.** Projects, New project (or the demo project), then the Repositories tab: add the repository with a URL that matches your `origin` remote.
2. **Connect the agent** as described above and run `npx -y arbitra-mcp doctor` in the repository.
3. **Create the case.** In the web app: Cases, New Case (title, project, repository, track, risk, priority, branch). Or ask the agent: "Create an Arbitra case for fixing the currency rounding bug." The agent proposes the fields, asks for confirmation and calls `create_case`.
4. **Explore.** The agent analyzes the code and calls `progress_case` with a summary. The case advances to `ready_for_build`.
5. **Build.** On the `standard` preset a person other than the owner confirms the start of the build (the gate banner on the case); on `autonomous` it starts by itself. The agent works on a feature branch, runs tests, pushes, opens a pull request and collects evidence. It then calls `progress_case` with summary, branch, pull request URL and evidence.
6. **Validation and review run automatically.** Open the case and watch the lifecycle tracker. The **Proof** tab shows findings, evidence and decisions; **Runs** shows each run with model and token details.
7. **Approval.** With no high or critical findings, low and medium risk cases are approved automatically and move to `pending_merge`. Otherwise the case waits in `needs_human_decision` for a reviewer ([Reviewing and deciding](#reviewing-and-deciding)).
8. **Merge.** When the pull request merges, GitHub's webhook completes the case. Without webhooks, the case page checks the pull request on GitHub when you open it, and **Mark as Merged** in the case header records the merge by hand.

The agent follows `next_action` in each tool response. The tool descriptions and the agent contract in `.arbitra/AGENTS.md` define the loop: `get_case_context`, then `progress_case`, repeated until the case reaches `pending_merge` or a terminal state. If the agent finds a problem after a forward transition, it files `create_decision` with type `request_changes`.

Evidence is passed as an array of typed items:

```json
[
  { "type": "unit_test_result", "summary": "42/42 pass" },
  { "type": "ci_result", "summary": "Build green", "artifact_ref": "https://ci.example.com/runs/1234" }
]
```

---

## The web app

| Area | What it shows |
|------|---------------|
| **Mission Control** | Landing page. Active agent sessions (agent, repository, branch) and their cases; polled every 10 seconds |
| **Activity** | Live workspace event stream and leaderboard |
| **Cases** | Board of all cases |
| **Projects** | Projects, repositories, team, rules, evidence policy |
| **Clerk** | The assistant (see below) |
| **Knowledge** | Knowledge assets: create, filter by status and type, promote |
| **Dashboard** | Personal overview of your cases |
| **Observatory** | Engineering metrics: stat cards, charts, throughput leaderboard. Admins also get **Intelligence** (detector runs and flags) |
| **Docs** | Searchable help |
| **Settings** | Profile, General, Users, Connections, IDE Agent, AI Models, Prompts |

Press Cmd+K (Ctrl+K) for global search across cases, findings, comments and docs. The Helper launcher is at the bottom right of every page.

### Cases board

Three layouts, selectable in the header and as the default under Settings, General: **List**, **Board** (Kanban columns per status) and **Lifecycle**. Triage views filter to what needs you: Needs Me, Ready to Approve, Blocked, Waiting on Others, Recently Updated, My Active, All. Reviewers, tech leads and admins open on Needs Me, everyone else on My Active. Filters cover project, owner, risk, track, priority and status.

**Start review session** opens `/review-session`, a guided one-case-at-a-time walk through the current queue. Each step says why the case is in your queue and what the next safe action is, and points to the IDE agent when the next step belongs in the working tree.

### Case detail

The header shows title, status, risk, track, priority, owner, linked branch and pull request, and the transition and gate buttons. Banners appear when the pipeline is stuck on a technical error (for example "diff could not be fetched", with the setting to fix) or when a specific human action is pending. Tabs:

- **Proof**: findings (filter by severity, status, source; blocking findings are highlighted), evidence (required versus provided), decisions.
- **Runs**: exploration, build, validation and review runs.
- **Comments**: discussion thread. Comments from agents carry a badge; Markdown is rendered.
- **Timeline**: the append-only event log. Events cannot be edited or deleted.
- **Related**: cases that share branch, repository, project or owner.

**View Dossier** opens a chronological, print-friendly audit record. **Enter Courtroom** opens the decision view. Deleting a case is a soft delete: the case leaves the board, and its events, evidence and decisions remain in Firestore.

### Projects and settings

A project groups repositories, rules and people. The project page has Overview (team: members, reviewer pool, tech leads; default validation track; default language of agent-written comments, `en` or `de`; lifecycle preset), Integrations (AI models and chat-notification webhook for the project), Repositories, Rules and Evidence Policy. A five-step wizard at `/setup/new-project` creates a project, connects a repository, shows the webhook settings, invites the team and shows the IDE setup.

Settings tabs:

- **Profile**: name, avatar.
- **General**: theme and board defaults.
- **Users** (admin): assign roles.
- **Connections**: every tool and device that signed in through the Connect flow, with last-used time; revoke single tokens or all tokens of a device. Advanced, Create CI service token creates a long-lived token shown once. A personal Google Chat webhook for Clerk outcomes is configured here too.
- **IDE Agent**: install snippets and the setup script for a chosen project.
- **AI Models**: provider and model per risk level, with a test button. Changes need the admin role.
- **Prompts**: the reviewer prompt templates. Load the built-in defaults, then edit.

---

## Reviewing and deciding

A case reaches a reviewer in `needs_human_decision` (open high or critical findings, or high or critical risk on the direct track) or in `verification_pending` (manual track). It shows up under Needs Me for reviewers, tech leads and admins, and in Mission Control and Activity.

**Courtroom.** Open the case and choose Enter Courtroom. It shows the findings with severity, confidence and source, the rule violations, the evidence, relevant knowledge assets and the comment thread.

Finding-level actions (select a finding):

| Action | Effect |
|--------|--------|
| Mark as resolved | The finding is resolved; the case does not move |
| Flag as blocking | Keeps the finding open |
| Waive finding | Accepts the risk with a written rationale that becomes part of the audit trail |

Case-level actions (no finding selected):

| Action | Effect |
|--------|--------|
| Approve | Moves the case toward `done`. Open high and critical findings must be waived or resolved first, required evidence must be present |
| Request Changes | Returns the case to `in_build`; a new iteration begins and the AI review receives the earlier findings as context |
| Reject | Terminates the case |

When the last blocking finding is resolved on a case in `needs_human_decision`, the case advances to `approved` without a separate approve click.

Rules for who may do what:

- High and critical findings can be waived only by a reviewer, tech lead or admin. A medium finding by those roles or by the owner with a rationale. Low findings by anyone.
- Four-eyes: where the evidence policy requires it (default for high and critical risk), two different people must approve. Decisions from before a `request_changes` do not count after the case loops back.
- The owner of a high or critical risk case cannot approve it, unless the evidence policy allows self-approval for that risk and track. Owners of low and medium risk cases may approve their own case.
- On the manual track, approving in `verification_pending` also records the manual validation confirmation.

After deciding, the Courtroom asks whether the decision is worth capturing as a knowledge asset (type, short description). The asset starts as `suggested`.

An agent can act as a reviewer on your behalf with `create_decision` (approve, reject, request changes, merge not applicable) and can propose a waiver with `resolve_finding`; a proposed waiver always waits for a human. Waivers, gate confirmations and escalations are otherwise made in the web app.

---

## AI review and LLM setup

When a case enters `in_review`, Arbitra resolves the diff on the server from the case's pull request (or, without one, a comparison of its branch with `main`) using the GitHub API, then runs the AI reviewers. The review input contains the diff, the case metadata (title, scope, risk, track), the active rules and relevant verified knowledge assets. Reviewers return structured findings: category, severity, file and line range, description, suggested fix, confidence. Findings that several reviewers report are merged into one, using hash-based signatures. A review is bound to the commit it reviewed; a later commit needs a fresh review before auto-approval.

Each review is a **run** on the case. A failed run (timeout, rate limit) is retried up to twice with exponential backoff (`ARBITRA_MAX_RUN_RETRIES`). Interrupted runs are recovered by the run sweeper, `POST /api/runs/sweep`, which a scheduler calls every few minutes. If the diff cannot be resolved after three attempts (no pull request or branch on the case, or GitHub refuses the request), Arbitra posts a system comment naming the reason, marks the review not applicable and lets the case continue. A banner on the case names the setting to fix. A person can also unblock a case whose review run failed permanently with a `review_not_applicable` decision.

Very large pull requests fall back to a branch comparison when GitHub refuses the pull request diff. A diff above 10,000 lines is truncated, and the reviewer is told so.

### Provider and models

Anthropic is the supported provider. Set `ANTHROPIC_API_KEY` in the server environment. The model for each risk level is chosen in this order:

1. Settings, AI Models (stored in Firestore, admin only).
2. `ARBITRA_LLM_MODEL_LOW`, `_MEDIUM`, `_HIGH`, `_CRITICAL`.
3. `ARBITRA_LLM_MODEL` for all levels.
4. Built-in defaults.

Each review consumes tokens; run metadata records token usage and latency. For development, choose a smaller model for the low and medium levels.

### GitHub token

Diff fetching needs a GitHub token with `repo` scope (or `contents:read` and `pull_requests:read` for a fine-grained token). Set `GITHUB_TOKEN` once on the server for all repositories, or store a token per repository (Projects, project, Repositories). A per-repository token wins over the global one and is encrypted at rest, which requires `ARBITRA_ENCRYPTION_KEY` (32 random bytes, base64: `openssl rand -base64 32`).

### Webhooks

`POST /api/webhooks/git` receives GitHub `pull_request` and `push` events and verifies the HMAC signature with `GITHUB_WEBHOOK_SECRET`. `POST /api/webhooks/ci` receives CI results as evidence and verifies `CI_WEBHOOK_SECRET`. GitHub cannot reach `localhost`; use a tunnel to test webhooks locally, or link the pull request on the case by hand.

---

## Rules and evidence policies

A **rule** is one check against a case. Evaluation modes:

| Mode | Checks | Example |
|------|--------|---------|
| `metadata_check` | A field on the case | "Risk level must be set" |
| `diff_pattern` | A regular expression against the diff; a match fails | "No console.log in production code" |
| `evidence_check` | Required evidence types are present | "CI result attached" |
| `llm_evaluation` | An LLM with a custom prompt evaluates the case | "Check for SQL injection" |
| `human_confirmation` | Blocks until a person confirms | "Architecture change needs tech lead sign-off" |

Rules are grouped into **rule sets** assigned to projects; rules have global or project scope. The **Starter Rule Set** has six advisory rules (CI evidence present, case description filled in, no `console.log` in the diff, no TODO or FIXME in the diff, risk level explicitly set, no secrets or keys in the diff), all `low` or `medium` severity. Manage them on the project's Rules tab: create a rule set, expand a set to see its rules, switch rules and sets on and off. An agent can create rules too: `create_rule`, `create_rule_set`, `list_rules`, `update_rule`, `update_rule_set`.

**Evidence policies** define what proof a change needs. Defaults on the direct track:

| Risk | Required evidence | Four-eyes |
|------|-------------------|-----------|
| `low` | `ci_result` | no |
| `medium` | `ci_result`, `unit_test_result` | no |
| `high` | `ci_result`, `unit_test_result`, `runtime_log` | yes |
| `critical` | the `high` set plus `integration_test_result` | yes |

The manual track adds `manual_confirmation` at every level, and `screenshot` at high and critical. A project overrides any risk and track cell in the policy editor (Projects, project, Evidence Policy): required and optional evidence types, four-eyes, and whether the owner may approve their own case.

---

## Enforcing at merge

Arbitra publishes a GitHub commit status named `arbitra/case` on each pull request's head commit. It blocks the merge button only if the repository lists `arbitra/case` as a required status check (GitHub, Settings, Branches, branch protection rule, "Require status checks to pass before merging"). The status needs a `GITHUB_TOKEN` with `repo` scope.

Every pull request gets a status, so marking the check required does not strand pull requests without a case:

- Observed case: `success`, "observed, not enforced".
- No case at all: `success`, "no case, not enforced".
- Enforced case:

| Case status | State |
|-------------|-------|
| `approved`, `pending_merge`, `done` | `success`, only for the commit that was approved |
| `rejected` | `failure` |
| `needs_human_decision`, `verification_pending` | `failure` ("awaiting human decision" and similar) |
| required evidence missing | `failure`, naming the missing types |
| anything else with evidence complete | `pending` |

Approval is pinned to the reviewed commit. A new commit pushed after approval turns the status to `failure` until the case is reviewed and approved again. The status is republished when a pull request is linked or updated and when the case status changes. A GitHub error while publishing is logged and never breaks case processing.

If a webhook delivery was lost, the status for a head commit can be missing, and a required check then reads "Expected, waiting for status". An admin can republish it:

```bash
curl -X POST "$ARBITRA_URL/api/commit-status/republish" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"pr_url": "https://github.com/<owner>/<repo>/pull/<number>"}'
```

`$ADMIN_TOKEN` is an access token of an admin user, for example a CI service token they created. The repository must be registered in Arbitra. The call resolves the case the way the webhook does, publishes onto the given pull request and records an audit event. It publishes the current verdict; if the verdict is `failure`, call it again after the case is approved.

---

## Roles

| Role | Typical work |
|------|--------------|
| `developer` | Default for every new account. Creates cases, pushes code, registers evidence, comments, contests findings, suggests knowledge |
| `reviewer` | Decides on findings and cases in the Courtroom, confirms manual validation |
| `tech_lead` | Sets rule sets and evidence policies, promotes knowledge to `verified` and `canonical`, acts as escalation point |
| `admin` | Manages users and roles, LLM settings and integrations |

An account listed in `ARBITRA_ADMIN_EMAILS` becomes an admin when it signs in; the setting only adds the role. Admins assign the other roles under Settings, Users. Projects also keep a **reviewer pool** and a list of **tech leads**; gate confirmation and some permission checks use these lists.

In a shared instance set `AUTH_HOSTED_DOMAIN` and `NEXT_PUBLIC_AUTH_HOSTED_DOMAIN` to restrict sign-in to one Google Workspace domain. If they are unset, any Google account can sign in.

---

## Clerk and the Helper

**Clerk** is an assistant for questions about what is in Arbitra. Open **Clerk** in the navigation, describe the request, and Clerk reads cases and knowledge assets you have access to through a fixed set of read-only tools (search and count cases, read a case, search and read knowledge, count case transitions). Every request becomes a case in your private Clerk project, with the request, the reads it made and the answer in one place; submitting a request opens that case. Your first request provisions that project. Limits per user default to 10 active tasks and 30 tasks per day (`ARBITRA_ASSISTANT_MAX_ACTIVE_PER_USER`, `ARBITRA_ASSISTANT_DAILY_LIMIT`). Clerk needs `ANTHROPIC_API_KEY`.

Tabs on the Clerk page:

- **Ask**: submit a request and see your recent tasks. Follow-ups continue a thread.
- **Context**: durable facts about you or your team (a team roster, for example). Entries marked "always inject" are added to every one of your requests; the run's method details list them.
- **Scheduled**: recurring tasks (task blueprints) with a schedule and a Run now button.

Scheduled tasks run when `POST /api/blueprints/tick` is called, which any scheduler does every 5 to 15 minutes with `Authorization: Bearer $ARBITRA_CRON_SECRET`. Locally, call it by hand with `curl -X POST` and the secret set in `.env.local`. Clerk can also answer in Google Chat, as a direct message or an @mention in a space: this needs a registered Chat app and `CHAT_EVENTS_AUDIENCE`, `CHAT_PROJECT_NUMBER` and `ARBITRA_CHAT_REPLIES_ENABLED=true`. Users can paste a personal webhook under Settings, Connections to be pinged about their own task outcomes.

The **Helper** is the chat launcher at the bottom right. It answers questions about the platform (concepts, configuration, MCP and IDE setup) from this documentation and from knowledge assets. It does not look at your code or at a specific case; it points you to your IDE agent for that. History stays in the browser session, and the server uses the last 10 turns. See [helper-bot.md](helper-bot.md).

**Intelligence** detectors run daily (`POST /api/intelligence/run`) and attach nudges to cases; see [intelligence.md](intelligence.md).

---

## Troubleshooting

**`npm install` fails.** Check `node -v` (20.19 or newer) and `npm -v` (10 or newer). Delete `node_modules` and run `npm install` again.

**Port 3000 is in use.** `PORT=3001 npm run dev`.

**The page looks broken.** `rm -rf packages/frontend/.next` and restart `npm run dev`.

**The emulators do not start.** Run `docker compose ps` and `docker compose logs firebase`. Ports 4000, 4400, 8080, 9099 and 9199 must be free.

**The app cannot reach Firestore.** Check `FIRESTORE_EMULATOR_HOST=localhost:8080` and `FIREBASE_AUTH_EMULATOR_HOST=localhost:9099` in `packages/frontend/.env.local` and that the emulators are running. Arbitra always talks to Firestore; there is no in-memory mode.

**The sign-in popup does not open.** Allow popups for localhost. The popup is the Auth emulator and needs no Google account.

**Tool calls return 401 or 404.** Usually the wrong host. Read the `arbitra://defaults` resource or run `npx -y arbitra-mcp doctor`, fix `ARBITRA_URL` and restart the MCP server. Use `reconnect` or `arbitra-mcp logout` followed by `login` for an expired token. See [mcp.md](mcp.md#troubleshooting).

**A case does not leave `in_build` or `in_validation`.** Check the Proof tab, Evidence, for required types that are missing, then register them or fix the CI webhook.

**A case did not auto-approve.** Auto-approval needs low or medium risk, a completed review that covers the current commit, no open high or critical finding, all rules passing or not applicable, and required evidence present. On the manual track, manual validation must be confirmed. The case banner and `get_case_context` (`preconditions`) show what is missing.

**A review run failed.** Open Runs and the timeline. Typical causes: an invalid `ANTHROPIC_API_KEY`, a provider rate limit (retried automatically), a diff that cannot be fetched (set `GITHUB_TOKEN` or a per-repository token), or a model response that cannot be parsed (not retried; check the model setting). Start a new review once the cause is fixed.

**A `400 Preconditions not met` on a transition.** Call `get_case_context` and read `preconditions`; each outgoing transition lists what blocks it.

**What is the difference between waive and accept?** Accept acknowledges a finding you will fix. Waive acknowledges it and deliberately leaves it, with a justification in the audit trail.

**Can Arbitra run without AI review?** Yes. Rules, evidence tracking and human decisions work without a provider key; only AI findings, Clerk and the Helper need one.

**Can a repository use several projects?** A repository belongs to one project. A monorepo uses one project for the whole repository.

---

## Reference

### Case status flow

```text
open -> exploration -> ready_for_build -> in_build -> in_validation -> in_review
in_review -> approved                (low/medium risk, auto-approve criteria met)
in_review -> needs_human_decision    (high/critical findings, or high/critical risk on the direct track)
in_review -> verification_pending    (manual track, no high/critical findings)
needs_human_decision, verification_pending -> approved | in_build (request_changes) | rejected
approved -> pending_merge -> done    (pull request merged)
```

### Commands

| Command | Purpose |
|---------|---------|
| `npm install` | Install all workspaces |
| `npm run emulators` | Start the Firebase emulators in Docker |
| `npm run seed` | Load demo data into the emulators |
| `npm run dev` | Start the web app (not the MCP package) |
| `npm run build` | Build all packages |
| `npm run test` | Unit tests (Vitest) |
| `npm run typecheck` | TypeScript type check |
| `npm run lint` | Lint |
| `npx turbo run test --filter=@arbitra/backend` | Test one package |

### Environment variables

`.env.example` at the repository root is the authoritative list for local development. The ones you meet first:

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | AI review, Clerk, Helper |
| `ARBITRA_ADMIN_EMAILS` | Accounts that get the admin role on sign-in |
| `ARBITRA_PUBLIC_BASE_URL` | Public URL of the instance (device login links, MCP setup snippets) |
| `ARBITRA_LLM_MODEL`, `ARBITRA_LLM_MODEL_<LEVEL>` | Model overrides |
| `GITHUB_TOKEN` | Diff fetching and the `arbitra/case` status |
| `GITHUB_WEBHOOK_SECRET`, `CI_WEBHOOK_SECRET` | HMAC secrets for the webhook endpoints |
| `ARBITRA_ENCRYPTION_KEY` | Encrypts per-repository GitHub tokens |
| `ARBITRA_CRON_SECRET` | Bearer secret for the scheduled-job endpoints |
| `AUTH_HOSTED_DOMAIN`, `NEXT_PUBLIC_AUTH_HOSTED_DOMAIN` | Restrict sign-in to one Workspace domain |
| `GCS_BUCKET` | Store artifacts in a bucket instead of `.arbitra-storage/` |

On the MCP side: `ARBITRA_URL`, `ARBITRA_TOKEN`, `ARBITRA_PROJECT_ID`, `ARBITRA_REQUEST_TIMEOUT_MS` ([mcp.md](mcp.md)).

### Next steps

- Create rules for your project (Projects, Rules tab) and set an evidence policy that matches your standards.
- Set a default validation track and a lifecycle preset for the project.
- Register your repositories and add a GitHub token so AI review can fetch diffs.
- Adjust the reviewer prompts under Settings, Prompts.
- Connect Git and CI webhooks to link pull requests and collect test results automatically.
- Self-hosting and scheduled jobs: [deployment.md](deployment.md). Internals: [architecture.md](architecture.md).
