# Model Context Protocol (MCP) in Arbitra

The [Model Context Protocol](https://modelcontextprotocol.io) is how IDE agents (Claude Code, Cursor, Codex, Cline) talk to Arbitra. The bridge is the npm package `arbitra-mcp` (4.x), whose source is `packages/mcp` in this repository. The [package README](../packages/mcp/README.md) is authoritative for installation, environment variables, the CLI and the Claude Code plugin. This page adds the tool catalog, the actor-metadata contract and troubleshooting.

## Contents

1. [What is MCP?](#what-is-mcp)
2. [How Arbitra uses MCP](#how-arbitra-uses-mcp)
3. [Setup](#setup)
4. [Tool catalog](#tool-catalog)
5. [Actor metadata and self-signing](#actor-metadata-and-self-signing)
6. [Package and source](#package-and-source)
7. [Troubleshooting](#troubleshooting)

---

## What is MCP?

The **Model Context Protocol** is an open, stdio-based protocol that lets LLM-backed agents discover and call tools exposed by an external server process. The IDE acts as the **MCP client**: it spawns the server as a subprocess, exchanges a JSON-RPC `initialize` handshake, and the model can then call the server's tools during its reasoning loop. Each tool ships a typed schema that the model sees at discovery time, and the same server works from any MCP-capable client.

---

## How Arbitra uses MCP

`arbitra-mcp` is a thin, typed bridge between the IDE and the Arbitra REST API. It translates MCP tool calls into authenticated HTTP calls against one Arbitra instance.

| Component | Runs where | Role |
|-----------|-----------|------|
| IDE agent (Claude Code, Cursor, Codex, Cline) | Your machine | MCP client; calls tools |
| `arbitra-mcp` | Your machine, spawned by the IDE over stdio | Stateless bridge; adds credentials and actor metadata |
| Arbitra API | `ARBITRA_URL` (default `http://localhost:3000`) | Next.js routes backed by Firestore |

The bridge exists for three reasons:

1. **A typed tool surface.** The REST API is general-purpose; the MCP surface is the agent-shaped subset. `progress_case` dispatches on the current status, and evidence items are arrays of structured objects.
2. **Actor-metadata injection.** Every write (comment, evidence, build signal, decision) is stamped with the client name and version from the MCP `initialize` handshake. The agent does not have to remember to pass them.
3. **One entry per IDE.** The client configuration is `command` and `args`, plus `ARBITRA_URL` when the instance is not local. Credentials come from the OS keychain through the device-code login on the first tool call.

The server holds no state besides the credentials it stores locally. The IDE starts it when a workspace opens and stops it on close; cases, findings, evidence and decisions live in Arbitra.

---

## Setup

There is no hosted default instance. The server resolves the instance URL in this order: `ARBITRA_URL` in the process environment, `ARBITRA_URL` in the nearest `.arbitra/.env` (searched from the working directory upwards), then `http://localhost:3000`. A local instance needs no configuration. The environment is read when the server process starts, so restart the MCP server after changing `ARBITRA_URL` or `ARBITRA_TOKEN`.

| Variable | Description |
|----------|-------------|
| `ARBITRA_URL` | Base URL of the instance (default `http://localhost:3000`) |
| `ARBITRA_TOKEN` | Access token for CI and service accounts; wins over everything stored locally |
| `ARBITRA_PROJECT_ID` | Default project pin, reported by `arbitra://defaults` |
| `ARBITRA_REQUEST_TIMEOUT_MS` | Timeout per API request (default `10000`) |

An `ARBITRA_URL` in the MCP client configuration applies to every repository and overrides each repository's `.arbitra/.env`. If you work against several instances, leave it out of the client configuration and let `arbitra-mcp login` write `.arbitra/.env` in each repository.

### Claude Code

Plugin (recommended; also installs the session hooks and a `/status` command, see [setup-claude-code.md](setup-claude-code.md)):

```text
/plugin marketplace add jsc2304/arbitra
/plugin install arbitra@arbitra
```

Or register only the MCP server:

```bash
claude mcp add arbitra -e ARBITRA_URL=<instance url> -- npx -y arbitra-mcp
```

Claude Code reads project-level servers from `.mcp.json` at the repository root (the Cursor extension reads the same file). `~/.claude.json` works as a global fallback; `.claude/settings.json` does not register MCP servers.

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

### Cursor

Cursor reads `.cursor/mcp.json` in the project or `~/.cursor/mcp.json` globally, with the same JSON as above. Restart Cursor after editing, or use Refresh in Settings, MCP Servers. In the user-global file, leave `ARBITRA_URL` out unless every repository uses the same instance.

### Codex

`~/.codex/config.toml` (see [setup-codex.md](setup-codex.md)):

```toml
[mcp_servers.arbitra]
command = "npx"
args = ["-y", "arbitra-mcp"]
env = { ARBITRA_URL = "<instance url>" }
```

### Cline

Cline stores its servers in `cline_mcp_settings.json` (Command Palette, Cline: Edit MCP Settings):

```json
{
  "mcpServers": {
    "arbitra": {
      "command": "npx",
      "args": ["-y", "arbitra-mcp"],
      "env": { "ARBITRA_URL": "<instance url>" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

`autoApprove: []` keeps every tool call behind a confirmation. Add read-only tool names such as `get_case_context` and `list_cases` once you trust them.

### Other clients

Any MCP-conformant client works: launch a subprocess with `command` and `args`, wire stdin and stdout, pass `ARBITRA_URL` in the environment if the instance is not local. For headless clients set `ARBITRA_TOKEN`.

A client started from a desktop launcher can have a stripped `PATH`, in which case `npx` is found but cannot start `node`. Use the absolute path of `npx` as `command` (`which npx`) and add its directory to `env.PATH`. The per-repository setup script (`$ARBITRA_URL/api/init/init.sh`) does this for you.

### Authentication and CLI

No token is configured by hand. The first tool call without a credential returns a **Connect** link (device-code flow). Open it, confirm tool, device and project, and the call is retried; the token is stored in the OS keychain (or a `0600` file under `~/.config/arbitra/` where no keychain is available). A token in `.arbitra/.env` is ignored.

```bash
npx -y arbitra-mcp login    # device login from a terminal; writes .arbitra/.env
npx -y arbitra-mcp doctor   # credentials, reachability, token validity, projects, client configuration
npx -y arbitra-mcp use      # show or change the resolved ARBITRA_URL
npx -y arbitra-mcp logout   # remove local credentials (revoke the token in Settings, Connections)
npx -y arbitra-mcp token    # print the resolved bearer token for scripts
```

`npx -y arbitra-mcp hook <session_start|heartbeat|session_end>` is the session-signal hook the Claude Code plugin runs. It sends identity and location only (agent name, repository, branch, session id), only from workspaces that contain an `.arbitra/` directory, and never starts a login. The README lists exactly what `login` and the hook send.

---

## Tool catalog

Grouped by purpose. All tools are registered under the `arbitra` server (`mcp__arbitra__<name>` in clients that prefix names).

### Case lifecycle

The agent's primary verbs. Call `get_case_context` first on every loop iteration, then `progress_case`, which dispatches on the current status so the agent needs no status-to-endpoint table.

| Tool | Purpose | Key args | When to use |
|---|---|---|---|
| `get_case_context` | Full case state: status, findings, evidence, rules, preconditions, `lifecycle_profile`, `pending_gate`, `next_action` | `case_id` | First call on every iteration. `next_action.tool_to_call` says what to do next |
| `progress_case` | State-driven dispatcher: routes to `/api/agent/explore`, `/api/cases/:id/transition` or `/api/agent/build-complete` depending on status | `case_id`, `summary?`, `branch?`, `pr_url?`, `evidence?`, `force_target?` | The single lifecycle verb. `summary` is required at `open`, `exploration` and `in_build`; `branch`, `pr_url` and `evidence` apply at `in_build` |
| `transition_case` | Move a case to a specific status; the server validates preconditions | `case_id`, `target_status` | Informal rewind (a bug found after build: back to `in_build`). Pair with `add_comment` so the rewind is audited |
| `create_case` | Create a case (`POST /api/cases`) | `title`, `description`, `project_id`, `repository_id`, optional `source_type`, `validation_track`, `risk_level`, `priority`, `case_type`, `git_context`, `jira_refs`, `assigned_reviewer_id` | New work. Pass `git_context.branch` when the branch is known so pull request webhooks link to the case |
| `detect_case_fields` | Extract title, description, risk level and case type from a free-form prompt | `prompt`, `project_id?` | Pre-fill a `create_case` call |
| `update_case` | `PATCH /api/cases/:id`; only given fields change | `case_id` and any of `title`, `description`, `risk_level`, `priority`, `validation_track`, `case_type`, `current_branch`, `current_pr_ref`, `assigned_reviewer_id` | Fix triage mistakes before the case leaves `exploration` |

### Workflow writes

| Tool | Purpose | Key args | When to use |
|---|---|---|---|
| `add_comment` | Markdown comment on a case; `actor_metadata` is attached | `case_id`, `body` | Talk to reviewers, record a rewind reason. Sign the body (see [below](#actor-metadata-and-self-signing)) |
| `register_evidence` | Register one evidence item. Deprecated: pass `evidence: [...]` to `progress_case` | `case_id`, `type`, `source_type?`, `summary?`, `artifact_ref?`, `machine_readable?` | Legacy paths only |
| `signal_build_complete`, `signal_exploration_complete` | Deprecated, superseded by `progress_case`; kept for compatibility | `case_id`, `summary`, ... | Do not use in new integrations |
| `create_decision` | File a formal decision (`approve`, `reject`, `request_changes`, `merge_not_applicable`) with a rationale | `case_id`, `type`, `rationale` (10 to 5000 chars), `finding_id?` | The user asks the agent to act as a reviewer. `merge_not_applicable` closes a case that has no pull request; the backend refuses it when the case has a PR reference. Waivers, gate confirmations and escalations are made in the web app |
| `resolve_finding` | Propose waiving or resolving a finding (`waived`, `resolved`, `false_positive`) | `case_id`, `finding_id`, `resolution`, `rationale` (10 or more chars), `severity_contested?`, `knowledge_asset_ref?` | Analysis shows a false positive or an existing exception. The finding moves to `waiver_proposed` and still blocks until a human confirms in the Courtroom. If the finding is real and the code is fixed, use `create_decision` with `request_changes` instead |

### Read-only

| Tool | Purpose | Key args |
|---|---|---|
| `get_case` | Full case record | `case_id` |
| `list_cases` | Filter by status, project, risk | `status?`, `project_id?`, `risk_level?`, `limit?` |
| `list_findings` | Review findings for a case | `case_id` |
| `get_evidence_requirements` | Required, optional and satisfied evidence types | `case_id` |
| `list_projects`, `get_project`, `list_repositories` | Projects visible to the token, project detail (reviewer pool, tech leads, lifecycle profile, default track), repositories of a project | `project_id` where applicable |
| `search` | Search cases, findings and knowledge | `query` |
| `list_knowledge_assets`, `list_rules` | All knowledge assets; all rules and rule sets | none |
| `get_agent_instructions` | Deprecated phase-specific guidance | `case_id` |

### Rules and knowledge writes

| Tool | Purpose | Key args |
|---|---|---|
| `create_rule` | New rule, any evaluation mode. Flat `scope_layer` and `scope_ref` args are sent as a nested `scope` object | `name`, `category`, `evaluation_mode`, `severity_if_failed`, `config` (JSON string), `description?`, `rationale?`, `scope_layer?`, `scope_ref?`, `status?` |
| `update_rule` | Activate, deactivate or draft a rule | `rule_id`, `status` |
| `create_rule_set` | Group rules and optionally attach to a project | `name`, `rule_refs` (comma-separated rule ids), `description?`, `project_id?`, `status?` |
| `update_rule_set` | Change a rule set's status | `rule_set_id`, `status` |
| `create_knowledge_asset` | File a `suggested` knowledge asset; promotion to `verified` or `canonical` happens in the web app | `type`, `title`, `summary`, `body`, `scope_type?`, `scope_ref`, `tags?`, `source_case_refs?` |

### Session

| Tool | Purpose | When to use |
|---|---|---|
| `reconnect` | Clear the stored keychain token for the resolved host and client and return a Connect link | Repeated `401` after the token worked, or a suspected wrong host. Restart the MCP server after approving in the browser. It cannot clear an `ARBITRA_TOKEN` and cannot change the host |

### Resources

Besides tools, the server exposes three resources (read with MCP `resources/read`):

- `arbitra://defaults`: the default project pin and the client and device identity: `default_project_id`, `default_project_name`, `client_name`, `device_label`, the resolved `base_url`, an `environment` hint (`local` or `custom`) and the project's `default_language` (`en` or `de`) when set. Case comments and summaries are written in that language.
- `arbitra://case/{caseId}`: the case record as JSON.
- `arbitra://case/{caseId}/context`: the enriched agent context.

Most agents use `get_case_context` instead. Tool responses that carry a `share_url` tell the agent to show it to the user as a link.

---

## Actor metadata and self-signing

Every write carries an `actor_metadata` record that tells the audit trail who produced the content. The bridge splits responsibility between **client identity** (injected) and **model identity** (supplied by the agent).

### Injected: client name and version

During `initialize` the IDE sends `clientInfo`, for example `{ name: "claude-code", version: "..." }`. The bridge captures it once and stamps every comment, evidence item, build signal and decision with `client_name` (lowercased, trimmed) and `client_version` (trimmed). Tool signatures do not expose these fields; the bridge adds them just before the HTTP call, and the backend normalizes the same way.

### Not injected: the model

Users switch models per prompt, so a startup-time setting would go stale and mislead the audit trail. The bridge therefore does not read or inject a model field. Agents add a trailing line `— <client> · <model>` to comments, summaries and decision rationales (for example `— claude-code · <model name>`), naming the model they actually use. If the exact model is unknown, the provider name is enough. The signature lives in the audit trail.

Callers that know the model (headless harnesses, CI-driven agents) can pass `actor_metadata.model` on individual evidence items; the bridge keeps caller-supplied `actor_metadata` untouched. A mixed trail (`claude-code` and `cursor` on one case) is expected; mis-signed comments make it impossible to tell later which model produced a wrong finding.

---

## Package and source

| Need | Where |
|------|-------|
| Source | `packages/mcp/src/`; tools in `src/tools/`, one file per group (`agent-tools.ts`, `case-tools.ts`, `evidence-tools.ts`, `rule-tools.ts`, ...) |
| Claude Code plugin | `packages/mcp/plugin/` (hooks, `/status` command); the marketplace file is `.claude-plugin/marketplace.json` at the repository root |
| Build and test | `npm --workspace packages/mcp run build`, `npm --workspace packages/mcp test` |
| Run from source | `npm --workspace packages/mcp run dev` |

The plugin pins the major version (`arbitra-mcp@^4`), so it picks up minor and patch releases automatically. A client configured with `npx -y arbitra-mcp` also fetches the latest published version when its npx cache is cold.

---

## Troubleshooting

Start with `npx -y arbitra-mcp doctor` (add `--json` to paste the result into an issue).

### The MCP server does not show up in the IDE

1. Restart the IDE after editing the MCP configuration; none of the clients hot-reload server definitions.
2. Check the IDE's MCP or output panel for the server's status and error.
3. Start the server by hand: `npx -y arbitra-mcp` from a terminal. The first run fetches the package and can take 10 to 20 seconds.
4. If the IDE was started from a desktop launcher, use the absolute `npx` path and set `env.PATH` (see [Other clients](#other-clients)).

### `401 Unauthorized` or `404` on every call

Usually the wrong host. Read `arbitra://defaults`, compare `base_url` with your instance, fix `ARBITRA_URL` and restart the MCP server. For an expired or revoked token, call `reconnect`, or run `arbitra-mcp logout` followed by `login`, then restart the server. In CI, a rejected `ARBITRA_TOKEN` is a hard failure: create a new service token under Settings, Connections, Advanced, Create CI service token. Tokens carry the role of the user who created them, so role limits (no sole self-approval on high or critical risk, knowledge promotion by tech leads) apply to every MCP call.

### `400 Preconditions not met` on `progress_case` or `transition_case`

Call `get_case_context` and read `preconditions`. Each outgoing transition lists `{satisfied, reason?}`, and the reason names the blocker: missing evidence, unresolved high or critical findings, a four-eyes requirement, a pending gate. Fix the underlying state. Use `force_target` only when you are sure the state machine misjudges the case.

### Evidence is rejected with a validation error

Pass an array of objects, not a comma-separated string:

```json
[
  { "type": "unit_test_result", "summary": "42/42 pass" },
  { "type": "ci_result", "summary": "Build green", "artifact_ref": "https://ci.example.com/runs/1234" }
]
```

Use the top-level `summary` for prose; evidence items are discrete, typed pieces, not Markdown reports.

### `actor_metadata.client_name` shows as `unknown`

The client starts the server without a proper `initialize` handshake with a `clientInfo` block. Real IDE clients always send it; custom harnesses that pipe MCP frames directly sometimes skip it.

### Tool signatures in the IDE do not match this page

An older `arbitra-mcp` is cached. Remove it from the npx cache (`rm -rf ~/.npm/_npx/*/node_modules/arbitra-mcp`) and restart the IDE, or pin explicitly with `"args": ["-y", "arbitra-mcp@latest"]`.

### Bridge and backend disagree on a field

This happens after upgrading only one side. Upgrade the side that lags and check the instance version with `GET /api/version`. Do not pin the bridge to an older release to work around it.

### macOS asks about the keychain

After the package updates, macOS may ask whether `arbitra-mcp` may read its keychain entry. Choose Allow.

---

## See also

- [Package README](../packages/mcp/README.md): installation, environment, CLI, plugin.
- [User guide](onboarding-guide.md): concepts and the day-to-day flow.
- [setup-claude-code.md](setup-claude-code.md) and [setup-codex.md](setup-codex.md): per-client setup.
- `.arbitra/AGENTS.md` (in any repository set up with the init script): the agent-facing loop, in-build checklist and hard rules.
- [intelligence.md](intelligence.md): the scheduled, non-agent surface.
