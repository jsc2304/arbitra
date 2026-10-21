# Setup: Claude Code

What you get: the Arbitra MCP server, the session hooks that make your work show up on Mission Control, and a `/status` command, installed once per machine as a Claude Code plugin. Arbitra governs merges, not writes ([ADR-0001](adr/0001-observe-by-default-enforce-by-policy.md)): there is no pre-write gate in any client.

The package behind the plugin is `arbitra-mcp` 4.x; its [README](../packages/mcp/README.md) is the reference for environment variables, the CLI and exactly what the hooks send.

## Prerequisites

- Claude Code installed (`claude --version` works) and Node.js 20 or newer (the plugin runs the server through `npx`).
- A running Arbitra instance. For a local one, follow the Quickstart in the [user guide](onboarding-guide.md#quickstart). There is no hosted default.
- A browser session signed in to that instance, for the Connect step.
- The repository registered in an Arbitra project (Projects, Repositories tab) with a URL that matches its `origin` remote. The Connect page uses it to preselect the project.

## Step 1: Install the plugin

In Claude Code:

```text
/plugin marketplace add jsc2304/arbitra
/plugin install arbitra@arbitra
```

From a shell the same steps are `claude plugin marketplace add jsc2304/arbitra` and `claude plugin install arbitra@arbitra`. The install is per machine and not tied to a repository. It adds:

| What | How |
|---|---|
| The Arbitra MCP server | Registered as `arbitra`; runs `arbitra-mcp@^4` through `npx` |
| Session hooks | `SessionStart`, `PostToolUse` (at most one heartbeat every 2 minutes per session) and `SessionEnd` run `npx -y arbitra-mcp hook <event>` and post identity and location (agent, repository, branch, session id) to the instance. No code, diffs or file paths |
| `/status` | Reports the case bound to the current branch, if any |

## Step 2: Point it at your instance

A local instance at `http://localhost:3000` needs nothing. For any other instance, set `ARBITRA_URL` in the environment Claude Code starts in; the plugin forwards it to the server:

```bash
export ARBITRA_URL=<instance url>
```

If `ARBITRA_URL` is unset, the server falls back to the nearest `.arbitra/.env` and then to `http://localhost:3000`. An `ARBITRA_URL` in the environment applies to every repository and overrides each repository's `.arbitra/.env`.

## Step 3: Restart Claude Code

Plugin and MCP configuration load at startup. Quit and relaunch Claude Code, or run `/reload-plugins`.

## Step 4: Connect

Start a session in a git repository and ask something that uses an Arbitra tool:

> list arbitra projects

The first call returns a one-time Connect link. Open it, confirm tool, device and project, and the call is retried. Nothing to copy; the token goes into the OS keychain, and later sessions authenticate silently. From a terminal, `npx -y arbitra-mcp login` does the same and also writes `.arbitra/.env` (instance URL and project id) in the repository.

## Step 5: Check Mission Control

Open the instance and go to **Mission Control** (the landing page). Your session, with agent, repository and branch, appears there. The hooks only report from a workspace that contains an `.arbitra/` directory, so run `npx -y arbitra-mcp login` once in each repository (or the setup script in the appendix). A session on a branch with no case also creates an observed case for that branch, provided the repository is registered and the branch is not the default branch.

## What the plugin does not do

- It does not pin a repository to a project. Use `arbitra-mcp login` (writes `ARBITRA_PROJECT_ID` to `.arbitra/.env`) or the setup script below.
- It ships `/status` only. The full lifecycle command set comes from the setup script.
- It does not touch other clients. Cursor and Codex setup are described in the [user guide](onboarding-guide.md#connect-an-ide-agent) and [setup-codex.md](setup-codex.md).

## Without the plugin

```bash
claude mcp add arbitra -e ARBITRA_URL=<instance url> -- npx -y arbitra-mcp
```

This registers the MCP server only; there are no session hooks. A project-level `.mcp.json` works too (see [mcp.md](mcp.md#claude-code)).

## Troubleshooting

Start with `npx -y arbitra-mcp doctor`.

**Plugin install fails.** `marketplace add` clones the GitHub repository; check network access and that `git` works.

**The `arbitra` server does not show up.** Run `claude plugin list` to confirm `arbitra@arbitra` is installed and enabled, then `claude mcp list`. Restart Claude Code after any fix.

**Tool calls return 401.** The token is missing, wrong or revoked. Run the `reconnect` tool, or `npx -y arbitra-mcp logout` and make a tool call again. In CI, create a service token under Settings, Connections, Advanced and set `ARBITRA_TOKEN`.

**Tool calls return 404, or data from the wrong instance.** Read the `arbitra://defaults` resource or run `doctor` to see which host and project are resolved, fix `ARBITRA_URL` and restart.

**The session does not appear on Mission Control.** The hooks are fire-and-forget and fail silently. Check that the repository has an `.arbitra/` directory, that the Connect step completed (a tool call succeeds without a Connect link), and that the instance is reachable, then start a fresh session so `SessionStart` fires again.

---

## Appendix: per-repository setup script (optional)

For a repository pin and the full lifecycle commands, run the instance's setup script from the repository root:

```bash
export ARBITRA_URL=<instance url>
curl -sL $ARBITRA_URL/api/init/init.sh | bash -s -- --ide claude-code <project_id>
```

(`--ide all` also wires up Cursor and Codex.) Settings, IDE Agent in the web app shows this command with your URL and project id filled in. The script creates:

| Path | Purpose |
|---|---|
| `.arbitra/AGENTS.md`, `CREATE-CASE.md`, `case-spec.json`, `.env` | Agent contract and project pin (`ARBITRA_URL`, `ARBITRA_PROJECT_ID`, no token) |
| `AGENTS.md` (root) | A marked Arbitra block, added or refreshed in place |
| `.mcp.json` | Project-scoped MCP registration with the absolute `npx` path and a derived `PATH`; redundant with the plugin |
| `.claude/commands/*.md` | The lifecycle slash commands below |
| `.github/PULL_REQUEST_TEMPLATE.md` | Pull request template with an Arbitra checklist, if none exists |
| `.gitignore` | Adds `.arbitra/.env` and `.mcp.json` |

| Command | What it does |
|---|---|
| `/arbitra` | Drives the case lifecycle from your intent |
| `/create-case` | Creates a case from the current git context, after confirmation |
| `/explore` | Runs exploration and posts the summary |
| `/build` | Moves the case to `in_build` |
| `/review` | Submits the work for review |
| `/status` | Reads the case bound to the branch and reports the next action |
| `/request-changes` | Sends the case back to `in_build` |

The commands point at `.arbitra/AGENTS.md`, the source of truth for fields, transitions, evidence and findings triage. Edit a file in `.claude/commands/` to customize it; the script does not overwrite existing files.

**`.mcp.json` problems.** Run `claude mcp list` in the repository. If `arbitra` is missing, the file is malformed or misplaced; validate it with `jq . .mcp.json`.

**`ENOENT: node` or `ENOENT: npx`.** The script writes a `PATH` derived from `dirname $(command -v npx)`. If your Node lives somewhere unusual, check that its directory appears in `.mcp.json` under `env.PATH`.

### Differences from Cursor

| Aspect | Cursor | Claude Code |
|---|---|---|
| Install | Setup script, per repository | Plugin, per machine |
| Slash commands | Commands and a skill from the setup script | `/status` from the plugin; the full set from the setup script |
| Mission Control | Pull request webhooks only | Native, through the plugin's session hooks |
