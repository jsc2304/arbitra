# arbitra-mcp

MCP (Model Context Protocol) server for [Arbitra](https://github.com/jsc2304/arbitra). It gives AI coding agents (Claude Code, Cursor, Codex) access to your Arbitra instance: case lifecycle, evidence, review findings, rules, knowledge assets and search. It is a thin bridge to the Arbitra REST API. It holds no state of its own besides the credentials it stores locally.

## Requirements

- Node.js 20 or newer.
- A running Arbitra instance that you can reach over HTTP(S). There is no hosted default. See the [Arbitra repository](https://github.com/jsc2304/arbitra) for how to run one.
- An MCP client: Claude Code, Cursor, Codex, or any other stdio MCP client.

## Configure

The server finds your instance through `ARBITRA_URL`. Resolution order:

1. `ARBITRA_URL` in the process environment
2. `ARBITRA_URL` in the nearest `.arbitra/.env` (searched from the working directory upwards)
3. `http://localhost:3000`

Claude Code:

```bash
claude mcp add arbitra -e ARBITRA_URL=<instance url> -- npx -y arbitra-mcp
```

Claude Code (`.mcp.json`) and Cursor (`.cursor/mcp.json`):

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

An `ARBITRA_URL` in the MCP client config applies to every repository and overrides the per-repository `.arbitra/.env`. If you work against several instances, leave it out of the client config and let `arbitra-mcp login` write `.arbitra/.env` in each repository instead.

### Environment variables

| Variable | Description |
|----------|-------------|
| `ARBITRA_URL` | Base URL of the Arbitra instance (default: `http://localhost:3000`). An empty value counts as unset. |
| `ARBITRA_TOKEN` | Access token. Wins over everything stored locally. Meant for CI and service accounts. |
| `ARBITRA_PROJECT_ID` | Default project pin, reported by the `arbitra://defaults` resource. |
| `ARBITRA_REQUEST_TIMEOUT_MS` | Timeout per API request in milliseconds (default: `10000`). |

The environment is read when the server process starts. After changing `ARBITRA_URL` or `ARBITRA_TOKEN`, restart the MCP server in your client; a reconnect is not enough.

## First run and authentication

No token is configured by hand. The first tool call without a credential returns a Connect link (device-code flow). Open it in a browser, confirm the project, and the call is retried. You can do the same from a terminal:

```bash
npx -y arbitra-mcp login
```

Where the token is looked up, in this order:

1. `ARBITRA_TOKEN` in the environment (CI override).
2. The OS keychain (macOS Keychain, Windows Credential Manager, libsecret), via [keytar](https://github.com/atom/node-keytar), keyed by instance URL and client name.
3. A fallback file `~/.config/arbitra/<client>.json` (mode 0600), used only when the keychain module cannot be loaded, for example on Linux without libsecret.

A token stored in `.arbitra/.env` is not used. The server prints a warning and ignores the line.

If the API rejects a keychain token with `401`, the server discards it and returns a fresh Connect link. A rejected `ARBITRA_TOKEN` is a hard failure, because CI must not wait for a human.

## CLI

```bash
npx -y arbitra-mcp <subcommand>
```

| Subcommand | Purpose |
|------------|---------|
| `login [--client <name>] [--url <baseUrl>]` | Device-code login from the terminal. Stores the token in the keychain and writes `.arbitra/.env` with `ARBITRA_URL` and the chosen `ARBITRA_PROJECT_ID`. |
| `logout [--client <name>] [--all] [--url <baseUrl>]` | Remove locally stored credentials. Does not revoke the token on the server; do that in your instance under Settings, Connections. |
| `token [--client-name <name>] [--base-url <url>]` | Print the resolved bearer token to stdout, for scripts and CI. Exit code 1 if none is found. |
| `doctor [--json]` | Check credentials, server reachability, token validity, visible projects and MCP client configuration. Exit code 1 if a check fails. |
| `use [<url>]` | Without an argument: show the resolved URL, where it came from and whether a token exists for it. With a URL: rewrite `ARBITRA_URL` in the nearest `.arbitra/.env`. Restart the MCP server afterwards. |
| `hook <session_start\|heartbeat\|session_end>` | Session-signal hook for Claude Code (see below). Reads the hook JSON from stdin, never prints, always exits 0. |

Without a subcommand, `arbitra-mcp` starts the MCP server on stdio.

## Claude Code plugin

The plugin bundles the MCP server, the session-signal hooks and a `/status` command. It contains no code of its own and runs this npm package through `npx`.

```text
/plugin marketplace add jsc2304/arbitra
/plugin install arbitra@arbitra
```

Set `ARBITRA_URL` in the environment Claude Code starts in; the plugin forwards it to the server. If it is unset, the server falls back to `.arbitra/.env` and then to `http://localhost:3000`. Restart Claude Code (or run `/reload-plugins`) after installing.

The plugin pins the major version (`arbitra-mcp@^4`), so it picks up minor and patch releases automatically.

### What the session hook sends

The hook runs on `SessionStart`, `PostToolUse` (at most one heartbeat every 2 minutes per session) and `SessionEnd`, and posts one event to `POST {ARBITRA_URL}/api/signals`. It sends identity and location only:

| Field | Content |
|-------|---------|
| `agent_name` | `claude-code` |
| `event_type` | `session_start`, `heartbeat` or `session_end` |
| `session_id` | Claude Code session id |
| `repository` | URL of the `origin` remote with any embedded credentials removed; the directory name if there is no remote |
| `branch` | Current branch, or `detached:<short sha>` |
| `event_id`, `schema_version`, `client_timestamp` | Event bookkeeping |

No tool output, diffs, code or file paths are sent. The hook only emits in workspaces that contain an `.arbitra/` directory (checked at the git root and its parent directories); other repositories are not contacted at all, not even for a credential lookup. It never starts a login flow, uses a 1.5 second network timeout, swallows every error and exits 0. Without a stored token it does nothing.

### What login sends

`login` and the automatic Connect flow identify the device to the server: the client name (for example `claude-code`), a device label (the machine's hostname), and a device id. The device id is the first 16 hex characters of a SHA-256 over the hostname and the first non-loopback MAC address (or a random id stored in `~/.config/arbitra/machine-id.txt` if no MAC is available). `arbitra-mcp login` also sends the `origin` remote URL (credentials removed) and repository name so the Connect page can match the repository to a registered project.

## Tools

Agent workflow:

- `get_case_context` — full context for a case: details, findings, evidence, rules, knowledge, preconditions, pending gate
- `progress_case` — advance a case through its lifecycle (the single lifecycle verb)
- `signal_exploration_complete`, `signal_build_complete`, `get_agent_instructions` — deprecated, kept for compatibility

Cases:

- `create_case`, `list_cases`, `get_case`, `update_case` — create, list, read and update cases
- `transition_case` — move a case to another status along the state machine
- `create_decision` — file a formal decision (approve, reject, request changes, merge not applicable)
- `detect_case_fields` — suggest case fields from a natural-language prompt

Evidence and review:

- `register_evidence`, `get_evidence_requirements` — attach evidence, see what a case still needs
- `add_comment` — comment on a case
- `list_findings`, `resolve_finding` — read review findings, propose a waiver

Projects:

- `list_projects`, `get_project`, `list_repositories`

Rules:

- `list_rules`, `create_rule`, `update_rule`, `create_rule_set`, `update_rule_set`

Knowledge and search:

- `search` — search across cases, findings and knowledge assets
- `list_knowledge_assets`, `create_knowledge_asset`

Authentication:

- `reconnect` — clear the stored keychain token and return a Connect link. It cannot clear an `ARBITRA_TOKEN` and cannot change the host.

Resources:

- `arbitra://case/{caseId}` — case metadata
- `arbitra://case/{caseId}/context` — enriched agent context
- `arbitra://defaults` — default project pin, client and device identity, the resolved `base_url`, an `environment` hint (`local` or `custom`) and the project's `default_language` when set

Tool responses that carry a `share_url` tell the agent to show it to the user as a link. Case comments are written in the project's `default_language` (`en` or `de`; English if unset). Client name and version from the MCP handshake are attached to comments, evidence and build signals as `actor_metadata`.

## Troubleshooting

```bash
npx -y arbitra-mcp doctor          # human-readable
npx -y arbitra-mcp doctor --json   # for pasting into a chat or issue
```

- **401 or 404 on every call.** Usually the wrong host. Read `arbitra://defaults` and compare `base_url` with your instance. Fix `ARBITRA_URL`, then restart the MCP server.
- **Expired or revoked token.** Run the `reconnect` tool, or `arbitra-mcp logout` followed by `login`, then restart the MCP server.
- **macOS keychain prompt.** After the package updates, macOS may ask whether `arbitra-mcp` may read its keychain entry. Choose Allow.

## Development

From the monorepo root:

```bash
npm --workspace packages/mcp run build       # tsc
npm --workspace packages/mcp run typecheck
npm --workspace packages/mcp test            # build, then node --test
npm --workspace packages/mcp run dev         # run the server with tsx
```

Build output goes to `dist/` and is not committed. The Claude Code plugin lives in `plugin/`; the marketplace file is `.claude-plugin/marketplace.json` at the repository root.

## License

Apache-2.0
