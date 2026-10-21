# Session Signal hook

The Session Signal hook tells an Arbitra instance that a Claude Code session is running in a repository, on which branch. The data feeds the session registry that Mission Control shows, and lets Arbitra create observed cases for branches it has not seen before (see [ADR 0001](./adr/0001-observe-by-default-enforce-by-policy.md)).

**Recommended install:** the Claude Code plugin wires the three hooks for you. See [`setup-claude-code.md`](./setup-claude-code.md). The manual install below is for clients that do not use the plugin.

## What it does

Three Claude Code hook events run `arbitra-mcp hook <event>`, and each invocation sends one Session Signal event to `POST {ARBITRA_URL}/api/signals`:

| Claude Code hook | Session Signal `event_type` | Notes |
|------------------|-----------------------------|-------|
| `SessionStart` | `session_start` | Once per session. |
| `PostToolUse` | `heartbeat` | At most one per two minutes per session. |
| `SessionEnd` | `session_end` | |

**Only Arbitra-governed workspaces emit.** Before looking up credentials or touching the network, the hook checks for a `.arbitra/` directory at the workspace root: the git top-level directory, then every parent directory up to the filesystem root. A session in a repository without `.arbitra/` sends nothing, not even a credential lookup. The setup script served by the instance (`curl -sL $ARBITRA_URL/api/init/init.sh | bash`) creates `.arbitra/` in a repository.

Every event carries identity and location only: `agent_name` (`claude-code`), `repository` (the `origin` URL with embedded credentials removed), `branch`, `session_id`, a client-generated `event_id`, `schema_version` and an optional `client_timestamp`. There is no field for tool output, diffs, code or file paths. The schema is in `packages/mcp/src/hooks/session-signal-schema.ts`.

**Fire and forget.** The network call has a hard 1.5 second timeout, every failure (no token, unreachable host, non-2xx response, bad input) is swallowed, and the process always exits with code 0. A slow or unreachable Arbitra instance never delays or fails your work. The hook never starts a login flow, because a hook has no chat turn in which to show a login link.

## Prerequisites

1. Node.js 20 or newer. The hook runs through `npx`.
2. A token for the `claude-code` client. The hook reuses the credential lookup of `arbitra-mcp`, in this order:
   - the `ARBITRA_TOKEN` environment variable,
   - the OS keychain entry written by `arbitra-mcp login` or by the Connect device flow,
   - the file `~/.config/arbitra/claude-code.json`.

   If no token exists yet, run `npx -y arbitra-mcp login` once. The hook then works silently in every later session.
3. `ARBITRA_URL` resolved the same way as for the rest of `arbitra-mcp`: the environment variable, then `.arbitra/.env` in the repository, then `http://localhost:3000`.

`ARBITRA_DISABLE_KEYCHAIN=1` makes credential lookup behave as if neither the keychain nor the fallback file holds anything. It exists so automated tests cannot pick up a developer's real credential. Do not set it for normal use; it makes every `arbitra-mcp` call behave as if you were logged out.

## Manual install

Add these entries to `~/.claude/settings.json`. If you already have hooks for these events, add the entries to the existing arrays.

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "npx -y arbitra-mcp hook session_start", "async": true }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "npx -y arbitra-mcp hook heartbeat", "async": true }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "npx -y arbitra-mcp hook session_end", "timeout": 10 }] }
    ]
  }
}
```

The plugin pins a major version (`arbitra-mcp@^4`). Do the same if you want to avoid picking up a new major release automatically.

## Verify

Run this from inside a governed workspace (one with `.arbitra/` at or above the repository root):

```bash
echo '{"session_id":"test-session","cwd":"'"$PWD"'"}' | npx -y arbitra-mcp hook session_start
echo "exit code: $?"   # always 0
```

With a resolvable token and a reachable instance, one `session_start` event is posted and the session appears in Mission Control. With no token, an unreachable host or malformed input, the exit code is still 0 and nothing visible happens. That is the fire-and-forget contract, not a fault. Outside a governed workspace the command exits 0 without sending anything, by design.

## Uninstall

Remove the three hook entries from `~/.claude/settings.json`, or uninstall the plugin.
