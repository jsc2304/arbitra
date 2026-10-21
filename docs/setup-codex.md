# Setup: Codex CLI

What you get: the Arbitra MCP server wired into Codex CLI, so the agent can call tools such as `list_projects` and `create_case` (shown as `mcp__arbitra__list_projects` and so on). Codex has no slash-command surface; the agent calls MCP tools directly. Arbitra governs merges, not writes ([ADR-0001](adr/0001-observe-by-default-enforce-by-policy.md)): no client, Codex included, blocks an edit for lack of a case. Setup takes about five minutes.

The package is `arbitra-mcp` 4.x; its [README](../packages/mcp/README.md) is the reference for environment variables and the CLI.

## Prerequisites

- Codex CLI installed (`codex --version` works) and Node.js 20 or newer.
- A running Arbitra instance. For a local one, follow the Quickstart in the [user guide](onboarding-guide.md#quickstart). There is no hosted default.
- A git repository (`git rev-parse --show-toplevel` works), registered in an Arbitra project with a URL that matches its `origin` remote.

## Step 1: Add the MCP server

Codex reads MCP servers from `~/.codex/config.toml`. Add:

```toml
[mcp_servers.arbitra]
command = "npx"
args = ["-y", "arbitra-mcp"]
```

A local instance at `http://localhost:3000` needs nothing more. The file is global: one entry serves every repository. Two ways to reach a non-local instance:

- One instance for everything: add `env = { ARBITRA_URL = "<instance url>" }` to the table. This overrides every repository's `.arbitra/.env`.
- Several instances: leave `env` out and let each repository's `.arbitra/.env` (written by `arbitra-mcp login`, step 2) name its instance.

For CI or scripted use, add `ARBITRA_TOKEN` to `env` with a service token from Settings, Connections, Advanced, Create CI service token. For human use, leave it out; the server returns a Connect link on the first tool call.

TOML is whitespace-sensitive: keep the table header on its own line and do not indent the keys.

### macOS: absolute `npx` path

Codex started from a desktop launcher can miss your shell `PATH`, so `npx` is not found. Use the absolute path (`which npx`, for example `/opt/homebrew/bin/npx` or `/usr/local/bin/npx`) as `command`.

## Step 2: Log in from the repository

From the repository root:

```bash
npx -y arbitra-mcp login
```

This opens the device-code flow, stores the token in the OS keychain and writes `.arbitra/.env` (instance URL and project id) in the repository. Skip it and the first tool call prints a Connect link instead; open it and confirm.

Optionally run the instance's setup script, which also installs `.arbitra/AGENTS.md` (the agent contract) and prints the TOML block to paste:

```bash
curl -sL $ARBITRA_URL/api/init/init.sh | bash -s -- --ide codex <project_id>
```

The script never writes a token and does not touch your home directory. Settings, IDE Agent in the web app shows the command with your URL and project id.

## Step 3: Restart Codex

MCP configuration is read at startup. Quit Codex and start a new session.

## Step 4: Verify

In a new session ask:

> list arbitra projects

The agent should call `list_projects` and return your projects. If it answers in prose instead, the server did not load (see Troubleshooting).

## No slash commands

Unlike Cursor (skill and commands) and Claude Code (optional `.claude/commands/`), Codex drives the lifecycle through tool calls. After the setup script, point the agent at the contract:

> Read `.arbitra/AGENTS.md` and create a case for the bug we just discussed.

The agent resolves the case bound to the current branch, then loops `get_case_context` and `progress_case`. The [tool catalog](mcp.md#tool-catalog) lists the tools.

## Mission Control

Codex does not run the session hooks that the Claude Code plugin installs, so Mission Control learns about Codex work from GitHub pull request webhooks, once a case has a linked pull request, not while you are mid-session. Evidence, status and merge detection keep working from the case.

## Troubleshooting

Start with `npx -y arbitra-mcp doctor`.

**`config.toml` is not picked up.** Codex was not restarted after the edit.

**`ENOENT: npx`.** Use the absolute `npx` path (see above).

**Tool not found or the server is not registered.** Usually a TOML syntax error. Validate the file (Python 3.11 or newer):

```bash
python3 -c 'import os, tomllib; tomllib.load(open(os.path.expanduser("~/.codex/config.toml"), "rb"))'
```

Common mistakes: missing quotes around string values, indented keys, or `[mcp_servers]` instead of `[mcp_servers.arbitra]`.

**Tool calls return 401.** The token is missing, wrong or revoked. Run `npx -y arbitra-mcp logout` and make a tool call again, or use the `reconnect` tool. For CI configurations that set `ARBITRA_TOKEN`, create a fresh service token and update the secret.

**Tool calls return 404.** `ARBITRA_URL` points at the wrong host. The default is `http://localhost:3000`. Check for trailing slashes and typos, then restart Codex.
