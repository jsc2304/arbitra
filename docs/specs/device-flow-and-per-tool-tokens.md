# Device Flow and Per-Tool Tokens

Status: Design document; parts may differ from the code. The endpoints, the `/connect` page, the Connections panel and the `arbitra-mcp` login, keychain storage and auto-connect described here are implemented.

**Scope.** Access tokens are issued per tool and per device through an OAuth 2.0 Device Authorization Grant (RFC 8628). Project selection happens in the same browser visit, so connecting an IDE takes one confirmation click and no token is copied by hand.

---

## A. Context

- **Project resolution is explicit.** Every MCP tool that needs a project takes `project_id` as an argument. The MCP server exposes a per-repository default (`ARBITRA_PROJECT_ID`, read from the environment or `.arbitra/.env`) through the resource `arbitra://defaults`, and the agent may override it per call. No header-based project pin exists. The backend checks that the authenticated user is a member of the supplied project (`isEffectiveMember`).
- **Wire format.** The MCP server sends `Authorization: Bearer arb_…`. The auth middleware resolves the token hash to a user (`authType: 'token'`). Client name and version travel as `actor_metadata` on comments, decisions and evidence, not as part of authentication.
- **Sign-in is a popup.** The web UI signs in with `signInWithPopup` (Firebase Auth, Google provider), so the `/connect?code=…` URL survives sign-in unchanged; the page re-renders when the user becomes available.
- **Firestore rules** deny all client access, so a new `device_codes` collection needs no rule change.
- **Repository matching** for `/api/projects/match` reuses the technique of the GitHub webhook: `github_repository_id`, then `github_full_name`, then a bounded URL scan.

---

## B. API contracts

All endpoints are Next.js route handlers under `packages/frontend/src/app/api/auth/connect/*`, plus `/api/projects/match`.

### B.1 `POST /api/auth/connect/init`

**Auth:** none (RFC 8628 section 3.1). Rate limited per IP: 10 requests per minute (sliding window).

Request:

```jsonc
{
  "client_name": "cursor",                       // required, lowercase, normalized
  "client_version": "0.42.3",                    // optional
  "device_label": "alex-macbook",                // optional, default "Unknown device"
  "device_id": "d_a1b2c3...",                    // optional, derived by the MCP client
  "repo_url": "git@github.com:acme/widgets.git", // optional, `git remote get-url origin`
  "repo_name": "widgets"                         // optional, basename hint
}
```

Response (RFC 8628 section 3.2):

```jsonc
{
  "device_code": "GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIySk9eS",   // opaque, 256 bits
  "user_code": "WDJB-MJHT",                                       // 8 characters, 2 groups of 4
  "verification_uri": "https://arbitra.example.com/connect",
  "verification_uri_complete": "https://arbitra.example.com/connect?code=WDJB-MJHT",
  "expires_in": 600,                                              // 10 minutes
  "interval": 5                                                   // minimum seconds between polls
}
```

Notes:

- `device_code` is 32 random bytes, base64url. The server stores only `sha256(device_code)` as the document id, so a leak of Firestore contents cannot be used to poll for a token.
- `user_code` uses the alphabet `BCDFGHJKLMNPQRSTVWXZ` (no vowels or look-alike digits, RFC 8628 section 6.1). A collision with an active code is retried up to 5 times, then the endpoint returns 503.
- The origin in the returned URIs comes from `ARBITRA_PUBLIC_BASE_URL`, then forwarded headers, then the request host.

Errors: `400 invalid_request` (missing `client_name`), `429 too_many_requests`, `503 server_error`.

### B.2 `POST /api/auth/connect/token`

**Auth:** none (device polling, RFC 8628 section 3.4).

```jsonc
{ "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": "GmRhmhcxhwAzkoEqiMEg_..." }
```

Success:

```jsonc
{
  "access_token": "arb_4f2c…",        // shown once
  "token_type": "Bearer",
  "token_prefix": "arb_4f2c...x9a",
  "project_id": "proj_1729...",       // chosen on the /connect page
  "project_name": "widgets-app",
  "server_url": "https://arbitra.example.com"
}
```

Pending and failure states are HTTP 400 with a discriminating body (RFC 8628 section 3.5): `authorization_pending`, `slow_down`, `access_denied` (the user cancelled, or three slow-down strikes), `expired_token`, `invalid_grant` (unknown or already consumed code).

Implementation:

- The document is looked up by `sha256(device_code)`. Missing gives `invalid_grant`. An expired document gives `expired_token`. `pending` gives `authorization_pending`. `denied` gives `access_denied`. `approved` mints a token.
- **Slow-down.** `last_polled_at` is tracked. A poll arriving earlier than the interval allows adds 5 seconds to the interval and returns `slow_down`. Three strikes deny the grant.
- **Minting** runs inside a Firestore transaction that also flips the grant to `consumed`, so a crash cannot produce a token without the binding, and two racing polls cannot both mint. The token document gets `client_name`, `client_version`, `device_id`, `device_label` and `created_via: 'unified_connect'`.

### B.3 `GET /api/projects/match?repo_url=…`

**Auth:** Firebase ID token. The `/connect` page calls it after sign-in to pre-select a project.

The server canonicalizes the URL: strips `.git`, lowercases the host, treats `git@github.com:owner/repo` and `https://github.com/owner/repo` as equal, drops a trailing slash and `www.`. The canonical form is `github.com/owner/repo`. It matches `repositories.github_full_name` first, then falls back to a URL substring scan limited to 500 documents. Only projects the caller can access are returned.

```jsonc
{
  "matches": [
    { "project_id": "proj_1729...", "project_name": "widgets-app",
      "repositories": [ { "repository_id": "repo_xxx", "url": "https://github.com/acme/widgets", "name": "widgets" } ] }
  ]
}
```

The array is empty when nothing matches and has several entries when one repository is registered in several projects. Errors: `400` (missing `repo_url`), `401`.

### B.4 `POST /api/auth/connect/approve`

**Auth:** Firebase ID token (the user pressing Confirm).

```jsonc
{ "user_code": "WDJB-MJHT", "project_id": "proj_1729...", "device_label": "alex-macbook" }
```

Response: `{ "approved": true, "project_name": "widgets-app" }`.

- The grant is found by `user_code`. Unknown or expired gives 404 or 400. Cancelled or consumed gives 409.
- The caller must be an effective member of `project_id`, otherwise 403.
- The update from `pending` to `approved` (with `user_id`, `project_id`, `device_label`, `approved_at`) runs in a transaction, so two browsers cannot both approve. A repeated approval by the same user for the same project is idempotent; any other second approval gets 409.
- The token is not minted here. The polling device mints it, so the raw token is handed only to the device that started the flow.

### B.5 `POST /api/auth/connect/cancel`

**Auth:** Firebase ID token. Body `{ user_code }`. Sets `status: 'denied'`. Idempotent.

### B.6 `GET /connect` and `GET /connect?code=WDJB-MJHT`

A page, not an API (`packages/frontend/src/app/connect/page.tsx`).

- Not signed in: the sign-in card; the popup keeps `?code=…` intact.
- Signed in without a code: a code entry field (8 characters, hyphen inserted automatically).
- Signed in with a code: the page loads the grant metadata (B.7) and the project matches (B.3) and shows the confirmation panel (F.1).

### B.7 `GET /api/auth/connect/lookup?user_code=…`

**Auth:** Firebase ID token. Returns the non-secret part of a pending grant for the `/connect` page: `client_name`, `client_version`, `device_label`, `repo_url`, `repo_name`, `expires_at`. Grants that are missing, expired, denied or consumed return 404. Rate limited per user (30 requests per minute) so one account cannot brute-force the code space from changing IP addresses.

---

## C. Data

### C.1 `PersonalAccessToken` (additive fields)

```ts
export interface PersonalAccessToken {
  token_id: string;
  user_id: string;
  name: string;                    // "<client_name> on <device_label>" when created through the flow
  token_hash: string;
  token_prefix: string;
  created_at: string;
  last_used_at?: string;
  expires_at?: string;
  client_name?: string;            // 'cursor' | 'claude-code' | 'codex' | 'arbitra-mcp-cli' | ...
  client_version?: string;
  device_id?: string;              // sha256(hostname + machine id), 16 hex characters
  device_label?: string;           // for example 'alex-macbook'
  created_via?: 'manual' | 'unified_connect' | 'ci_service';
}
```

Tokens without `created_via` are shown as legacy in the Connections panel.

### C.2 `device_codes`

The document id is `sha256(device_code)` in hex. The stored shape is `DeviceCode` in `packages/shared/src/types/device-code.ts`: `user_code`, `status` (`pending`, `approved`, `denied`, `consumed`), `client_name`, `client_version`, `device_label`, `device_id`, `repo_url`, `repo_name`, `user_id` and `project_id` (set on approval), `approved_at`, `last_polled_at`, `poll_interval_seconds` (starts at 5), `slow_down_strikes`, `expires_at` (creation time plus 600 seconds), `created_at`.

`expires_at` is an ISO-8601 string and the code ignores expired grants. Nothing deletes them; see [Data retention](../deployment.md#data-retention).

### C.3 Indexes

- `device_codes`: `(user_code ASC, status ASC)` for the approve lookup.
- `tokens`: `(user_id ASC, device_id ASC, client_name ASC)` for "revoke all tokens on this device" and panel grouping.
- `tokens`: `(user_id ASC, last_used_at DESC)` for panel ordering.

---

## D. MCP client

### D.1 Subcommands

`arbitra-mcp login`, `logout`, `token`, `doctor`, `use` and `hook` run before configuration is loaded, so they work without a token. See `packages/mcp/README.md`.

### D.2 `arbitra-mcp login`

1. Read `git remote get-url origin` from the working directory (best effort).
2. Use the client name `arbitra-mcp-cli` (an interactive CLI has no MCP handshake) and the package version.
3. Derive `device_id` and `device_label` (D.5).
4. `POST /api/auth/connect/init`, then print the user code and the `verification_uri_complete`, and open it in the browser. If no browser can be opened (SSH session, no display), only print the URL.
5. Poll `POST /api/auth/connect/token` at the server's `interval`, backing off on `slow_down`.
6. On success: write the keychain entry (D.4) and write `.arbitra/.env` with `ARBITRA_URL` and `ARBITRA_PROJECT_ID` (atomic write through a temporary file).
7. On `expired_token`, `access_denied` or a network failure: print a readable error and exit with status 1.

### D.3 Credential and project resolution

Token, first match wins: `ARBITRA_TOKEN` in the environment (CI); the OS keychain entry keyed by `(ARBITRA_URL, client_name)`; the file `~/.config/arbitra/<client_name>.json` (mode 0600), used only when the keychain module is unavailable; otherwise the auto-connect flow (D.6) when running as the MCP server.

Project id, first match wins: `ARBITRA_PROJECT_ID` in the environment; `ARBITRA_PROJECT_ID` in the nearest `.arbitra/.env`, searched from the working directory upwards. A token line in `.arbitra/.env` is ignored with a one-time warning (E.2).

### D.4 Keychain

`keytar` stores the token with service `arbitra-mcp` and account `<baseUrl>|<clientName>`, so separate instances have separate tokens. Where the native module cannot load (for example Linux without libsecret), the fallback file is used and `doctor` reports where it is. The keychain is keyed by client name rather than device id so that listing the tools that talk to Arbitra is readable in the OS keychain tool.

### D.5 `device_id`

`sha256(hostname | first non-loopback MAC)`, first 16 hex characters. If no MAC is available, a random id persisted in `~/.config/arbitra/machine-id.txt` is used instead. The value is stable across restarts, identical for every tool on the machine (which makes "revoke all tokens on this device" possible), and cannot be reversed.

### D.6 Auto-connect on a missing credential

When an MCP tool runs without a credential, the tool handler starts a device flow and waits for approval instead of failing. The tool result the agent shows to the user is a short Markdown message with the connect link and the code, valid for 10 minutes:

```markdown
**Connect Cursor to Arbitra**

This tool call needs an Arbitra credential. Open the link below to finish setup:

[Connect Cursor to Arbitra →](https://arbitra.example.com/connect?code=WDJB-MJHT)

Or visit https://arbitra.example.com/connect and enter the code: **`WDJB-MJHT`**
```

- One device flow is in flight per process. Concurrent tool calls reuse its code (while it is younger than 600 seconds) and wait for the same result.
- On approval the first waiter stores the token and the project default, and every waiting tool call retries itself once with the new credential. The agent then sees the real tool result, not the prompt. Only when the flow expires or is denied does the prompt reach the agent.
- If the API rejects a keychain token with 401, the client discards it and starts a new flow. A rejected `ARBITRA_TOKEN` is a hard failure, because CI must not wait for a human.

### D.7 `client_name`

Taken from `clientInfo.name` of the MCP `initialize` handshake, lowercased with non-alphanumeric characters replaced by `-` (`cursor`, `claude-code`, `codex`). If the handshake provides none, `arbitra-mcp-unknown` is used and a warning is logged.

### D.8 `logout`

`arbitra-mcp logout [--client <name>] [--all]` removes local credentials. It does not revoke the token on the server; revoke it in Settings, Connections.

---

## E. `.arbitra/.env`

### E.1 Format

```text
# Arbitra project pin, personal per developer per repository. Do not commit.
ARBITRA_URL=https://arbitra.example.com
ARBITRA_PROJECT_ID=proj_xxxxx

# Tokens are stored in the OS keychain, never in this file.
```

Written by `login` and by the setup script served at `/api/init/init.sh`. Neither writes a token line.

### E.2 Legacy token lines

If `.arbitra/.env` contains `ARBITRA_TOKEN=`, the MCP server prints a one-time warning to stderr and ignores the line. It does not edit the file.

---

## F. UI

### F.1 `/connect` page

Files: `packages/frontend/src/app/connect/page.tsx` and `packages/frontend/src/components/connect/`.

The confirmation panel shows:

- the tool (client name and version),
- the device label, editable inline,
- the project: a select seeded with the repository matches (B.3), then all of the user's projects, with an option to create a new project inline (name only),
- the code with its remaining lifetime,
- Cancel and Confirm buttons.

Project states: one match is pre-selected; several matches are listed first; no match shows all projects with the create option prominent. Confirm calls B.4 and then shows a success view ("You can close this tab. <tool> on <device> continues automatically."). Cancel calls B.5.

### F.2 Connections panel

`packages/frontend/src/components/settings/tokens-panel.tsx` (Settings, Connections). Tokens are grouped by device and then by tool. Columns: tool and version, device label, how it was created (Connect flow, manual, CI), last used (with a colour cue after 60 days), created. A bulk action revokes all tokens on a device (`DELETE /api/tokens?device_id=…`). Legacy tokens appear in a separate section. Creating a CI service token is under an Advanced disclosure and uses `POST /api/tokens`.

### F.3 Setup wizard

The project setup wizard ends with install snippets for Claude Code, Cursor and Codex; the first tool call connects the project. No token is generated or copied.

---

## G. CI service tokens

Long-lived tokens for CI are created in Settings, Connections, Advanced (`created_via: 'ci_service'`, `client_name: 'ci'`) and supplied to the MCP server as `ARBITRA_TOKEN`. Per-project and per-action scoping is not part of this design.

---

## H. Compatibility

- Tokens created before the flow keep working and are shown as legacy. Revoking them is a manual action.
- Servers need no migration: the new token fields are optional.
- An MCP client that talks to an instance without the `/connect` page cannot complete a login, so deploy the server before publishing a client that depends on it.

---

## I. Test matrix

Route tests cover:

- `init`: happy path, rate limit, `client_name` normalization, `user_code` format and alphabet, collision retries ending in 503.
- `token`: every RFC 8628 section 3.5 state (`authorization_pending`, `slow_down`, `access_denied`, `expired_token`, success), strike counting and interval bump, three strikes denying the grant, idempotence on a consumed grant, atomic mint and flip.
- `approve`: a non-member is rejected, double approval is idempotent, a cancelled grant cannot be approved.
- `projects/match`: `git@github.com:foo/bar.git`, `https://github.com/foo/bar`, the `.git` variant and the trailing-slash variant resolve to the same repository; mixed case matches; a miss returns `{ "matches": [] }`.

MCP tests cover keychain write, read and delete with the file fallback and its mode, the credential lookup order, ignoring `ARBITRA_TOKEN` in `.arbitra/.env`, the login polling loop, concurrent tool calls sharing one flow, and a stable device id.

---

## J. Risks and notes

- **J.1 Popup sign-in.** The `?code=` parameter survives sign-in only because the sign-in is a popup. A move to redirect-based sign-in must preserve it.
- **J.2 Wrong Google account.** The confirmation page shows the signed-in email prominently with a "Not you? Switch account" action (sign out and sign in again, keeping `?code=`). Arbitra does not guess which account was meant.
- **J.3 No browser.** `login` prints the URL when it cannot open one; the user opens it on any device. A fully headless CI environment uses a CI service token (G).
- **J.4 Several workspaces.** The MCP server has one working directory, so it finds the nearest `.arbitra/.env` upwards from there. In an editor with several repository roots the agent passes `project_id` explicitly; `arbitra://defaults` is a hint, not a constraint.
- **J.5 Repository matching.** Paths are matched case-insensitively by trying the lowercased and the as-given form. Self-hosted git hosts match by URL substring; creating a new project is the fallback. A fork has its own slug and does not match the upstream repository.
- **J.6 Keychain prompts.** After the package updates, macOS may ask whether `arbitra-mcp` may read its keychain entry. Choose Allow.
- **J.7 Token leakage.** Logs and `doctor --json` print `token_prefix` only, never the raw token.
- **J.8 `device_id` privacy.** The hash is stable and cannot be reversed. Someone who can read Firestore could correlate the tokens of one device, but already sees every token's `last_used_at` and audit metadata.
- **J.9 Rate-limit storage.** Rate limits are Firestore documents (`auth_rate_limits`) with a sliding window and fail open, so no extra service is needed. The cost is one write per request to the limited endpoints.
- **J.10 Large project lists.** The picker uses the existing `/api/projects` list, already limited to the user's memberships.
